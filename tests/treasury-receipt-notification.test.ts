import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { persistTreasuryReceiptNotifications, readTreasuryReceiptNotificationStatus, TREASURY_NOTIFICATION_CURSOR_KEY, TREASURY_NOTIFICATION_DEADLINE_MS } from '../src/treasury-receipt-notification';
import { checkpointRevisionDigest } from '../scripts/treasury-checkpoint-store.mjs';
import { TREASURY_CUSTODY_PREFIX } from '../src/treasury-custody';
import { MemoryBucket, orderRuntime } from './helpers/order-runtime';
// @ts-expect-error Reuse original pure canonical log normalizer; no RPC is run.
import { normalizeLogs, USDC, TRANSFER_TOPIC, TO_TOPIC } from '../scripts/treasury-reconciliation.mjs';
const now = Date.parse('2026-11-04T12:00:00.000Z');
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const key = (n: number) => `${TREASURY_CUSTODY_PREFIX}revision-${String(n).padStart(10, '0')}.json`;
const receivedAt = (version: number) => new Date(now - 3600000 + version * 1000).toISOString();
function transfer(id: number, blockHash = hash(id), amount = 1000000) {
  return normalizeLogs([{ address: USDC, transactionHash: hash(id + 1000), blockHash, blockNumber: `0x${id.toString(16)}`,
    logIndex: '0x0', removed: false, topics: [TRANSFER_TOPIC, `0x${'1'.repeat(40).padStart(64, '0')}`, TO_TOPIC], data: `0x${BigInt(amount).toString(16).padStart(64, '0')}` }], 1, 100)[0];
}
class Bucket extends MemoryBucket {
  reads: string[] = []; writes: string[] = []; lists = 0;
  async get(k: string) { this.reads.push(k); return super.get(k); }
  async put(k: string, value: unknown, options?: R2PutOptions) { this.writes.push(k); return super.put(k, value, options); }
  async list() { this.lists++; throw Error('notification_must_not_scan_inventory'); }
}
function fixture() {
  const bucket = new Bucket(), env = { ...orderRuntime(bucket), OPERATIONS_CLOUD_ENABLED: 'true', OPERATIONS_ALERT_OUTBOX_ENABLED: 'true',
    OPERATIONS_TREASURY_NOTIFICATIONS_ENABLED: 'true', TREASURY_CUSTODY_ENABLED: 'true', TREASURY_CUSTODY_ORIGIN_BLOCK: '1',
    TREASURY_CUSTODY_MINIMUM_VERSION: '1', TREASURY_CUSTODY_MINIMUM_DIGEST: '',
    OPERATIONS_ALERT_DESTINATION_ID: 'synthetic-owner', OPERATIONS_ALERT_DESTINATION_DIGEST: `sha256:${'a'.repeat(64)}` };
  const revision = async (version: number, transfers: any[], corrections: any[] = [], previous: string | null = null, patch: Record<string, unknown> = {}) => {
    const state = { schema: 'delta-treasury-checkpoint/v1', network: 'eip155:8453', asset: USDC,
      treasury: env.PAY_TO, origin_block: 1, checked_through_block: 100, checked_through_hash: hash(version + 10000),
      reorg_anchor: { number: 90, hash: hash(90) }, confirmation_depth: 12, checked_at: receivedAt(version), transfers, corrections, ...patch };
    const item = { schema: 'delta-treasury-revision/v1', version, previous_digest: previous, digest: await checkpointRevisionDigest(state), state };
    await bucket.put(key(version), JSON.stringify(item));
    if (version === Number(env.TREASURY_CUSTODY_MINIMUM_VERSION)) env.TREASURY_CUSTODY_MINIMUM_DIGEST = item.digest;
    return item;
  };
  return { bucket, env, revision };
}
function episodes(bucket: Bucket) {
  return [...bucket.values].filter(([k]) => k.startsWith('operations/alerts/episodes/')).map(([,v]) => JSON.parse(v.text));
}
function cursor(bucket: Bucket) { const v = bucket.values.get(TREASURY_NOTIFICATION_CURSOR_KEY); return v && JSON.parse(v.text); }
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); vi.stubGlobal('fetch', vi.fn(() => { throw Error('no-network'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('canonical Treasury custody to normal owner notifications, synthetic storage only', () => {
  it('default-disabled projection reads/writes nothing and unanchored bootstrap cannot authorize notices', async () => {
    const f = fixture();
    expect(await persistTreasuryReceiptNotifications({ ...f.env, OPERATIONS_TREASURY_NOTIFICATIONS_ENABLED: undefined })).toMatchObject({ state: 'disabled', notification_delivered: null });
    expect(f.bucket.reads).toEqual([]); expect(f.bucket.writes).toEqual([]);
    expect(await persistTreasuryReceiptNotifications({ ...f.env, TREASURY_CUSTODY_MINIMUM_VERSION: '0' })).toMatchObject({ state: 'unavailable' });
    expect(f.bucket.writes).toEqual([]);
  });
  it('initial trusted snapshot uses bounded batches and original observation time, not this invocation time', async () => {
    const f = fixture(); await f.revision(1, Array.from({ length: 6 }, (_,i) => transfer(i + 1)));
    const source = f.bucket.values.get(key(1))!.text;
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'observed', selected: 4, established: 4, revision_complete: false, next_offset: 4, notification_delivered: null });
    expect(cursor(f.bucket)).toMatchObject({ revision: 1, offset: 4, complete: false });
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'observed', selected: 2, revision_complete: true });
    const all = episodes(f.bucket); expect(all).toHaveLength(6);
    expect(all[0]).toMatchObject({ state: 'queued', receipt: null, acknowledgment: null,
      episode: { code: 'treasury_received', severity: 'INFO', first_seen_at: receivedAt(1), receipt: { observed_at: receivedAt(1), occurrence: 'initial_observation', customer_revenue: 'UNKNOWN', actual_cost: 'UNKNOWN', contribution_margin: 'UNKNOWN', fulfillment: 'UNKNOWN' } } });
    const originals = stableEpisodes(f.bucket); f.bucket.reads = []; f.bucket.writes = [];
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'observed', selected: 0, next_revision: 2, latest_inventory_verified: false });
    expect(stableEpisodes(f.bucket)).toEqual(originals); expect(f.bucket.writes).toEqual([]); expect(f.bucket.lists).toBe(0);
    expect(f.bucket.reads.filter(k => k.startsWith(TREASURY_CUSTODY_PREFIX))).toEqual([key(1), key(2)]);
    expect(f.bucket.values.get(key(1))!.text).toBe(source); expect(f.env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it('adjacent revision differences create only new receipts and complete empty deltas without replaying prior income', async () => {
    const f = fixture(), one = await f.revision(1, [transfer(1)]); await persistTreasuryReceiptNotifications(f.env);
    const two = await f.revision(2, [transfer(1), transfer(2)], [], one.digest);
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ selected: 1, source_revision: 2 });
    await f.revision(3, [transfer(1), transfer(2)], [], two.digest); f.bucket.reads = [];
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'observed', selected: 0, source_revision: 3, revision_complete: true });
    expect(episodes(f.bucket)).toHaveLength(2); expect(f.bucket.reads.filter(k => k.startsWith(TREASURY_CUSTODY_PREFIX))).toEqual([key(1), key(2), key(3)]);
  });
  it('appended replacement/removal corrections preserve original notifications and do not invent customer revenue', async () => {
    const f = fixture(), a = transfer(1), b = transfer(2), one = await f.revision(1, [a,b]); await persistTreasuryReceiptNotifications(f.env);
    const originalRows = stableEpisodes(f.bucket), replacement = transfer(1, hash(9001), 2000000);
    const corrections = [{ kind: 'replaced', receipt_id: a.receipt_id, previous: a, replacement, observed_at: receivedAt(2) },
      { kind: 'removed', receipt_id: b.receipt_id, previous: b, replacement: null, observed_at: receivedAt(2) }];
    await f.revision(2, [replacement], corrections, one.digest);
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'observed', selected: 2, established: 2 });
    const rows = episodes(f.bucket); expect(rows).toHaveLength(4); const revised = rows.filter(r => r.episode.code === 'treasury_receipt_corrected');
    expect(revised).toHaveLength(2); expect(revised.map(r => r.episode.receipt.correction.kind).sort()).toEqual(['removed','replaced']);
    expect(rows.filter(r => r.episode.code === 'treasury_received').map(r => JSON.stringify(r)).sort()).toEqual(originalRows);
    expect(revised.every(r => r.episode.receipt.customer_revenue === 'UNKNOWN')).toBe(true);
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ selected: 0 }); expect(episodes(f.bucket)).toHaveLength(4);
  });
  it('a removed original block reappearing creates a versioned re-observation without mutating its prior notice', async () => {
    const f = fixture(), a = transfer(1), one = await f.revision(1, [a]); await persistTreasuryReceiptNotifications(f.env);
    const correction = { kind: 'removed', receipt_id: a.receipt_id, previous: a, replacement: null, observed_at: receivedAt(2) };
    const two = await f.revision(2, [], [correction], one.digest); await persistTreasuryReceiptNotifications(f.env);
    await f.revision(3, [a], [correction], two.digest);
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'observed', selected: 1 });
    const rows = episodes(f.bucket); expect(rows).toHaveLength(3); expect(new Set(rows.map(r => r.notification_id)).size).toBe(3);
    expect(rows.filter(r => r.episode.code === 'treasury_received').map(r => r.episode.first_seen_at).sort()).toEqual([receivedAt(1), receivedAt(3)]);
    expect(rows.find(r => r.episode.receipt.custody_revision === 3).episode.receipt.occurrence).toBe('reobserved_after_removal');
    expect(rows.find(r => r.episode.code === 'treasury_receipt_corrected').episode.receipt.occurrence).toBe('initial_observation');
  });
  it('an initial anchored floor reports current receipts only; older correction history remains untouched', async () => {
    const f = fixture(); f.env.TREASURY_CUSTODY_MINIMUM_VERSION = '5'; const a = transfer(1), b = transfer(1, hash(3000));
    const correction = { kind: 'replaced', receipt_id: a.receipt_id, previous: a, replacement: b, observed_at: receivedAt(3) };
    await f.revision(5, [b], [correction], 'a'.repeat(64));
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'observed', source_revision: 5, selected: 1, scope: 'anchored_checkpoint_receipts_only' });
    expect(episodes(f.bucket)[0].episode.code).toBe('treasury_received'); expect(f.bucket.values.has(key(5))).toBe(true);
  });
  it('preserves known platform-verification exclusion instead of presenting it as unknown customer income', async () => {
    const f = fixture(), a = transfer(1);
    a.from = '0x54e163e9b8edda194d83f46add921bfa5fc5f4e0'; a.payer_classification = 'nohumans_platform_verification'; a.customer_revenue = false;
    await f.revision(1, [a]);
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'observed', selected: 1 });
    expect(episodes(f.bucket)[0].episode.receipt).toMatchObject({ payer_classification: 'nohumans_platform_verification', customer_revenue: 'EXCLUDED', actual_cost: 'UNKNOWN' });
    expect(episodes(f.bucket)[0].episode.receipt).not.toHaveProperty('from');
  });
  it.each(['digest', 'wrong-treasury', 'wrong-receipt', 'future'])('validates original custody evidence instead of trusting self-reported receipt: %s', async mode => {
    const f = fixture(), a = transfer(1); if (mode === 'wrong-receipt') a.raw_amount = '2000000';
    const item = await f.revision(1, [a], [], null, mode === 'wrong-treasury' ? { treasury: `0x${'2'.repeat(40)}` } : mode === 'future' ? { checked_at: new Date(now + 1).toISOString() } : {});
    if (mode === 'digest') { item.digest = 'a'.repeat(64); f.env.TREASURY_CUSTODY_MINIMUM_DIGEST = item.digest; await f.bucket.put(key(1), JSON.stringify(item)); }
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'unavailable', selected: 0 }); expect(episodes(f.bucket)).toHaveLength(0); expect(cursor(f.bucket)).toBeUndefined();
  });
  it.each(['chain', 'missing-correction', 'rewrite-history', 'future-correction'])('does not advance for invalid history: %s', async mode => {
    const f = fixture(), a = transfer(1), one = await f.revision(1, [a]); await persistTreasuryReceiptNotifications(f.env); const originalCursor = cursor(f.bucket);
    const correction = { kind: 'removed', receipt_id: a.receipt_id, previous: a, replacement: null, observed_at: mode === 'future-correction' ? new Date(now + 1).toISOString() : receivedAt(2) };
    if (mode === 'rewrite-history') {
      const two = await f.revision(2, [], [correction], one.digest); await persistTreasuryReceiptNotifications(f.env);
      await f.revision(3, [], [], two.digest); const before = cursor(f.bucket);
      expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'unavailable' }); expect(cursor(f.bucket)).toEqual(before); return;
    }
    await f.revision(2, mode === 'chain' ? [a] : [], mode === 'future-correction' ? [correction] : [], mode === 'chain' ? 'a'.repeat(64) : one.digest);
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'unavailable' }); expect(cursor(f.bucket)).toEqual(originalCursor);
  });
  it('an outbox outage partway through a batch preserves cursor and resumes the original identities', async () => {
    const f = fixture(); await f.revision(1, [transfer(1), transfer(2)]); const put = f.bucket.put.bind(f.bucket); let alerts = 0;
    f.bucket.put = async (k,v,o) => { if (k.startsWith('operations/alerts/episodes/') && ++alerts === 2) throw Error('synthetic outage'); return put(k,v,o); };
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'unavailable', selected: 2, established: 1 }); expect(cursor(f.bucket)).toBeUndefined();
    const original = episodes(f.bucket)[0]; f.bucket.put = put;
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'observed', established: 2 }); expect(episodes(f.bucket)).toHaveLength(2);
    expect(episodes(f.bucket).find(r => r.notification_id === original.notification_id)).toEqual(original);
  });
  it('lost cursor write acknowledgement is resolved only by exact readback; no duplicate notices', async () => {
    const f = fixture(); await f.revision(1, [transfer(1)]); const put = f.bucket.put.bind(f.bucket);
    f.bucket.put = async (k,v,o) => { const r = await put(k,v,o); if (k === TREASURY_NOTIFICATION_CURSOR_KEY) throw Error('lost cursor ACK'); return r; };
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'observed', cursor_state: 'advanced' });
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ selected: 0 }); expect(episodes(f.bucket)).toHaveLength(1);
  });
  it('outbox write committed but every original readback unavailable retains cursor and recovers original notice', async () => {
    const f = fixture(); await f.revision(1, [transfer(1)]); const get = f.bucket.get.bind(f.bucket); let created = false;
    const put = f.bucket.put.bind(f.bucket); f.bucket.put = async (k,v,o) => { const r = await put(k,v,o); if (k.startsWith('operations/alerts/episodes/')) created = true; return r; };
    f.bucket.get = async k => { if (created && k.startsWith('operations/alerts/episodes/')) throw Error('synthetic unavailable readback'); return get(k); };
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'unavailable', established: 0, cursor_state: 'retained' });
    expect(cursor(f.bucket)).toBeUndefined(); expect(episodes(f.bucket)).toHaveLength(1); const original = episodes(f.bucket)[0];
    f.bucket.get = get;
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'observed', established: 1 }); expect(episodes(f.bucket)).toEqual([original]);
  });
  it('unknown cursor write cannot skip a persisted receipt and resumes without a replacement notice', async () => {
    const f = fixture(); await f.revision(1, [transfer(1)]); const put = f.bucket.put.bind(f.bucket);
    f.bucket.put = async (k,v,o) => { if (k === TREASURY_NOTIFICATION_CURSOR_KEY) throw Error('synthetic cursor outage'); return put(k,v,o); };
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'degraded', established: 1, cursor_state: 'unconfirmed' });
    const original = episodes(f.bucket)[0]; expect(cursor(f.bucket)).toBeUndefined(); f.bucket.put = put;
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'observed', established: 1 }); expect(episodes(f.bucket)).toEqual([original]);
  });
  it('corrupted cursor and changed floor cannot skip unresolved source events', async () => {
    const f = fixture(); await f.revision(1, [transfer(1)]); await persistTreasuryReceiptNotifications(f.env); const original = stableEpisodes(f.bucket);
    await f.bucket.put(TREASURY_NOTIFICATION_CURSOR_KEY, JSON.stringify({ ...cursor(f.bucket), offset: 99, complete: false }));
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'unavailable' });
    expect(await persistTreasuryReceiptNotifications({ ...f.env, TREASURY_CUSTODY_MINIMUM_DIGEST: 'a'.repeat(64) })).toMatchObject({ state: 'unavailable' });
    expect(stableEpisodes(f.bucket)).toEqual(original);
  });
  it('a forged complete flag cannot skip the remaining source events even when the next revision is absent', async () => {
    const f = fixture(); await f.revision(1, Array.from({ length: 6 }, (_,i) => transfer(i + 1))); await persistTreasuryReceiptNotifications(f.env);
    expect(cursor(f.bucket)).toMatchObject({ offset: 4, complete: false });
    await f.bucket.put(TREASURY_NOTIFICATION_CURSOR_KEY, JSON.stringify({ ...cursor(f.bucket), complete: true })); const original = cursor(f.bucket); f.bucket.reads = [];
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'unavailable', cursor_state: 'retained' });
    expect(cursor(f.bucket)).toEqual(original); expect(episodes(f.bucket)).toHaveLength(4); expect(f.bucket.reads).not.toContain(key(2));
  });
  it('two simultaneous producers retain one notification per event and one CAS progression', async () => {
    const f = fixture(); await f.revision(1, [transfer(1), transfer(2)]);
    const results = await Promise.all([persistTreasuryReceiptNotifications(f.env), persistTreasuryReceiptNotifications(f.env)]);
    expect(results.some(r => r.state === 'observed')).toBe(true); expect(episodes(f.bucket)).toHaveLength(2);
    expect(cursor(f.bucket)).toMatchObject({ generation: 1, offset: 2, complete: true }); expect(f.bucket.lists).toBe(0);
  });
  it('destination absent still durably retains blocked obligations without claiming provider acceptance', async () => {
    const f = fixture(); await f.revision(1, [transfer(1)]);
    expect(await persistTreasuryReceiptNotifications({ ...f.env, OPERATIONS_ALERT_DESTINATION_ID: undefined })).toMatchObject({ state: 'degraded', established: 1, blocked: 1, notification_delivered: null });
    expect(episodes(f.bucket)[0]).toMatchObject({ state: 'blocked', destination: null, receipt: null }); expect(cursor(f.bucket).complete).toBe(true);
  });
  it('oversize custody stops only this projection, leaves original receipts intact and never reports zero money', async () => {
    const f = fixture(); await f.revision(1, [transfer(1)], [], null, { padding: 'x'.repeat(1000000) }); const original = f.bucket.values.get(key(1));
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'unavailable', customer_revenue: 'UNKNOWN', actual_cost: 'UNKNOWN' });
    expect(cursor(f.bucket)).toBeUndefined(); expect(f.bucket.values.get(key(1))).toEqual(original); expect(episodes(f.bucket)).toHaveLength(0);
  });
  it('status and no-next-revision expose stale source evidence rather than claiming a healthy income stream', async () => {
    const f = fixture();
    expect(await readTreasuryReceiptNotificationStatus(f.env)).toMatchObject({ enabled: true, state: 'unavailable', source_revision: null, freshness: 'UNKNOWN' });
    expect(await readTreasuryReceiptNotificationStatus({ ...f.env, OPERATIONS_TREASURY_NOTIFICATIONS_ENABLED: undefined })).toMatchObject({ enabled: false, state: 'disabled' });
    await f.revision(1, [transfer(1)]); await persistTreasuryReceiptNotifications(f.env);
    expect(await readTreasuryReceiptNotificationStatus(f.env)).toMatchObject({ enabled: true, state: 'observed', source_revision: 1, freshness: 'FRESH', notification_delivered: null });
    const original = cursor(f.bucket); vi.setSystemTime(now + 2 * 60 * 60 * 1000);
    expect(await persistTreasuryReceiptNotifications(f.env)).toMatchObject({ state: 'degraded', selected: 0, reason: 'source_stale', customer_revenue: 'UNKNOWN', cursor_state: 'retained' });
    expect(await readTreasuryReceiptNotificationStatus(f.env)).toMatchObject({ freshness: 'STALE', source_observed_at: receivedAt(1), notification_delivered: null });
    expect(cursor(f.bucket)).toEqual(original); expect(episodes(f.bucket)).toHaveLength(1);
  });
  it('deadline fences a stalled source read from all subsequent outbox and cursor writes', async () => {
    vi.useRealTimers(); vi.useFakeTimers(); vi.setSystemTime(now); const f = fixture(); await f.revision(1, [transfer(1)]);
    const get = f.bucket.get.bind(f.bucket); let release!: (r: Awaited<ReturnType<Bucket['get']>>) => void, enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    f.bucket.get = async k => { if (k === key(1)) { enter(); return new Promise(resolve => { release = resolve; }); } return get(k); };
    const pending = persistTreasuryReceiptNotifications(f.env); await entered; await vi.advanceTimersByTimeAsync(TREASURY_NOTIFICATION_DEADLINE_MS + 1);
    expect(await pending).toMatchObject({ state: 'unavailable', cursor_state: 'retained' });
    release(await get(key(1))); await vi.advanceTimersByTimeAsync(1); expect(episodes(f.bucket)).toHaveLength(0); expect(cursor(f.bucket)).toBeUndefined();
  });
});
function stableEpisodes(bucket: Bucket) { return episodes(bucket).map(r => JSON.stringify(r)).sort(); }
