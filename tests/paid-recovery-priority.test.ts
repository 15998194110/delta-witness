import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import {scheduledPaidOrderRecovery} from '../src/paid-recovery-control';
import { drainPaidRecoveryPriority, enqueuePaidRecoveryPriority, paidRecoveryPriorityStatus,
  PAID_RECOVERY_PRIORITY_PREFIX, PAID_RECOVERY_PRIORITY_LEASE_MS, PAID_RECOVERY_PRIORITY_RETRY_MS } from '../src/paid-recovery-priority';
import { MemoryBucket, mockOrderNetwork, orderRequest, orderRuntime, TEST_ORDER_ID } from './helpers/order-runtime';

const INDEX = `${PAID_RECOVERY_PRIORITY_PREFIX}pending.json`;
const idFor = (n: number) => n === 1 ? TEST_ORDER_ID : `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
class Bucket extends MemoryBucket {
  interrupt = false;
  completions: string[] = [];
  override async put(key: string, value: unknown, options?: R2PutOptions) {
    const final = key.startsWith('fulfillments/') && JSON.parse(String(value)).state === 'complete';
    if (final && this.interrupt) { this.interrupt = false; throw new Error('synthetic_original_final_interruption'); }
    const saved = await super.put(key, value, options);
    if (saved && final) this.completions.push(key);
    return saved;
  }
  list = vi.fn(async (_options?: R2ListOptions): Promise<any> => { throw new Error('priority_must_not_scan_original_indexes'); });
}
function setup() {
  const bucket = new Bucket(), env = orderRuntime(bucket), network = mockOrderNetwork();
  vi.stubGlobal('fetch', network);
  return { bucket, env, network };
}
async function draft(s: ReturnType<typeof setup>, n = 1, product = 'capture', complete = false) {
  s.bucket.interrupt = !complete;
  const response = await app.fetch(orderRequest({ orderId: idFor(n), nonce: `0x${n.toString(16).padStart(64, '0')}`, product }), s.env);
  expect(response.status).toBe(complete ? 200 : 503);
  s.network.mockClear(); vi.mocked(s.env.BROWSER.quickAction).mockClear(); s.bucket.completions = [];
  return idFor(n);
}
function record(s: ReturnType<typeof setup>, key: string): any { return JSON.parse(s.bucket.values.get(key)!.text); }
function key(s: ReturnType<typeof setup>, prefix: string, id?: string) {
  if (id && prefix === 'fulfillments/') {
    const fingerprint = record(s, `orders/${id}.json`).payment_fingerprint;
    return [...s.bucket.values.keys()].find(target => target.startsWith(prefix) && record(s, target).payment_fingerprint === fingerprint)!;
  }
  return [...s.bucket.values.keys()].find(target => target.startsWith(prefix))!;
}
function edit(s: ReturnType<typeof setup>, target: string, fields: Record<string, unknown>) {
  const stored = s.bucket.values.get(target)!;
  s.bucket.values.set(target, { ...stored, etag: `edit:${++s.bucket.sequence}`, text: JSON.stringify({ ...JSON.parse(stored.text), ...fields }) });
}
function noPurchase(s: ReturnType<typeof setup>) {
  expect(s.network).not.toHaveBeenCalled(); expect(s.env.BROWSER.quickAction).not.toHaveBeenCalled(); expect(s.bucket.list).not.toHaveBeenCalled();
}
function originalBytes(s: ReturnType<typeof setup>) {
  return [...s.bucket.values].filter(([target]) => !target.startsWith(PAID_RECOVERY_PRIORITY_PREFIX)).map(([target, value]) => [target, value.text, value.bytes && [...value.bytes]]);
}
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('actual Core unfinished response enrolls once in background, then the existing scheduled controller drains it before a degraded fallback scan',async()=>{
  const s=setup();Object.assign(s.env,{OPERATIONS_CLOUD_ENABLED:'true',PAID_ORDER_DRAFT_RECOVERY_ENABLED:'true'});
  s.bucket.interrupt=true;const pending:Promise<unknown>[]=[],ctx={waitUntil(p:Promise<unknown>){pending.push(p);}} as ExecutionContext;
  expect((await app.fetch(orderRequest(),s.env,ctx)).status).toBe(503);await Promise.all(pending);
  expect(record(s,INDEX).entries).toHaveLength(1);s.network.mockClear();vi.mocked(s.env.BROWSER.quickAction).mockClear();
  const result=await scheduledPaidOrderRecovery(s.env,Date.now());
  expect(result).toMatchObject({priority_counts:{recovered:1},outcome:'degraded'}); // fixture deliberately rejects fallback list
  expect(record(s,key(s,'fulfillments/',TEST_ORDER_ID)).state).toBe('complete');expect(record(s,INDEX).entries).toEqual([]);
  expect(s.network).not.toHaveBeenCalled();expect(s.env.BROWSER.quickAction).not.toHaveBeenCalled();
});
it('healthy paid traffic and unpaid challenges do not fill pending capacity',async()=>{
  const s=setup();Object.assign(s.env,{OPERATIONS_CLOUD_ENABLED:'true',PAID_ORDER_DRAFT_RECOVERY_ENABLED:'true'});
  const pending:Promise<unknown>[]=[],ctx={waitUntil(p:Promise<unknown>){pending.push(p);}} as ExecutionContext;
  expect((await app.fetch(orderRequest({unpaid:true}),s.env,ctx)).status).toBe(402);expect(pending).toHaveLength(0);
  expect(s.env.BROWSER.quickAction).not.toHaveBeenCalled();expect((await app.fetch(orderRequest(),s.env,ctx)).status).toBe(200);
  expect(pending).toHaveLength(0);expect(s.bucket.values.has(INDEX)).toBe(false);
});

describe('persistent confirmed-original paid priority references (isolated)', () => {
  it.each(['capture', 'preflight'])('enrolls the same confirmed %s identity idempotently and resolves only its original draft', async product => {
    const s = setup(), id = await draft(s, 1, product);
    const original = record(s, `orders/${id}.json`), fulfillment = key(s, 'fulfillments/', id);
    const before = originalBytes(s).filter(([target]) => target !== fulfillment);
    expect(await enqueuePaidRecoveryPriority(s.env, id)).toMatchObject({ outcome: 'enqueued' });
    expect(await enqueuePaidRecoveryPriority(s.env, id)).toMatchObject({ outcome: 'already_pending' });
    expect(record(s, INDEX).entries).toHaveLength(1);
    expect(await drainPaidRecoveryPriority(s.env)).toMatchObject({ outcome: 'success', inventory_complete: false, counts: { selected: 1, recovered: 1 } });
    expect(record(s, INDEX).entries).toEqual([]); expect(s.bucket.completions).toEqual([fulfillment]);
    expect(originalBytes(s).filter(([target]) => target !== fulfillment)).toEqual(before);
    expect(record(s, `orders/${id}.json`)).toEqual(original);
    expect(await enqueuePaidRecoveryPriority(s.env, id)).toMatchObject({ outcome: 'terminal' });
    expect(await drainPaidRecoveryPriority(s.env)).toMatchObject({ counts: { selected: 0, recovered: 0 } });
    noPurchase(s);
  });

  it('does not enroll an unknown settlement or invent an obligation for an absent original', async () => {
    const s = setup(), id = await draft(s), settlement = key(s, 'settlements/');
    edit(s, settlement, { state: 'settlement_unknown' }); const before = originalBytes(s);
    expect(await enqueuePaidRecoveryPriority(s.env, id)).toMatchObject({ outcome: 'not_eligible', reason: 'settlement_unknown' });
    expect(await enqueuePaidRecoveryPriority(s.env, idFor(2))).toMatchObject({ outcome: 'not_eligible', reason: 'order_missing' });
    expect(s.bucket.values.has(INDEX)).toBe(false); expect(originalBytes(s)).toEqual(before); noPurchase(s);
  });

  it('concurrent enrollments rebase only explicit CAS conflicts and preserve both original identities', async () => {
    const s = setup(), a = await draft(s), b = await draft(s, 2);
    const outcomes = await Promise.all([enqueuePaidRecoveryPriority(s.env, a), enqueuePaidRecoveryPriority(s.env, b)]);
    expect(outcomes.every(result => ['enqueued', 'degraded'].includes(result.outcome))).toBe(true);
    expect(record(s, INDEX).entries.map((entry: any) => entry.order_id).sort()).toEqual([a, b].sort());
    expect(await drainPaidRecoveryPriority(s.env)).toMatchObject({ counts: { selected: 2, recovered: 2 } }); noPurchase(s);
  });

  it('concurrent drains grant one queue lease and retain the original completion CAS', async () => {
    const s = setup(), id = await draft(s); await enqueuePaidRecoveryPriority(s.env, id);
    const results = await Promise.all([drainPaidRecoveryPriority(s.env), drainPaidRecoveryPriority(s.env)]);
    expect(results.reduce((total, result) => total + result.counts.recovered, 0)).toBe(1);
    expect(s.bucket.completions).toHaveLength(1); expect(record(s, INDEX).entries).toEqual([]); noPurchase(s);
  });

  it.each(['expired', 'replaced'])('a %s queue claim fences an old observer before permanent observation or reference removal', async kind => {
    const s = setup(), id = await draft(s); await enqueuePaidRecoveryPriority(s.env, id);
    const put = s.bucket.put.bind(s.bucket); let changed = false;
    s.bucket.put = async (target, value, options) => {
      const saved = await put(target, value, options);
      if (!changed && target.startsWith('fulfillments/') && JSON.parse(String(value)).state === 'complete') {
        changed = true;
        const index = record(s, INDEX), entry = index.entries[0];
        edit(s, INDEX, { version: index.version + 1, write_id: crypto.randomUUID(), entries: [{ ...entry,
          ...(kind === 'replaced' ? { claim_id: crypto.randomUUID(), attempts: entry.attempts + 1,
            lease_until: new Date(Date.now() + PAID_RECOVERY_PRIORITY_LEASE_MS).toISOString() } :
            { lease_until: new Date(Date.now() - 1).toISOString() }) }] });
      }
      return saved;
    };
    expect(await drainPaidRecoveryPriority(s.env)).toMatchObject({ outcome: 'degraded', counts: { recovered: 0, conflicts: 1 } });
    expect(s.bucket.values.has(`${PAID_RECOVERY_PRIORITY_PREFIX}orders/${id}.json`)).toBe(false);
    expect(record(s, INDEX).entries).toHaveLength(1); expect(s.bucket.completions).toHaveLength(1);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + PAID_RECOVERY_PRIORITY_LEASE_MS + 1);
    expect(await drainPaidRecoveryPriority(s.env)).toMatchObject({ counts: { already_complete: 1 } });
    expect(s.bucket.completions).toHaveLength(1); noPurchase(s);
  });

  it('completed historical observations do not occupy pending capacity or add a completed-index sweep', async () => {
    const s = setup();
    for (let n = 1; n <= 6; n++) {
      const id = await draft(s, n, 'capture', true); await enqueuePaidRecoveryPriority(s.env, id);
      expect(await drainPaidRecoveryPriority(s.env, { maxOrders: 1 })).toMatchObject({ counts: { selected: 1, already_complete: 1 } });
    }
    const id = await draft(s, 7), get = vi.spyOn(s.bucket, 'get');
    await enqueuePaidRecoveryPriority(s.env, id); get.mockClear();
    expect(await drainPaidRecoveryPriority(s.env, { maxOrders: 1 })).toMatchObject({ counts: { selected: 1, recovered: 1 } });
    expect(get.mock.calls.filter(([target]) => target.startsWith(`${PAID_RECOVERY_PRIORITY_PREFIX}orders/`)).every(([target]) => target.endsWith(`${id}.json`))).toBe(true);
    expect(await paidRecoveryPriorityStatus(s.env)).toMatchObject({ pending: 0, due: 0, inventory_complete: false, quarantined_originals: null }); noPurchase(s);
  });

  it('an unknown enrollment ACK remains the same reference and can be safely read by a later drain', async () => {
    const s = setup(), id = await draft(s), put = s.bucket.put.bind(s.bucket); let lost = true;
    s.bucket.put = async (target, value, options) => {
      const saved = await put(target, value, options);
      if (lost && target === INDEX) { lost = false; throw new Error('synthetic_enrollment_lost_ack'); }
      return saved;
    };
    expect(await enqueuePaidRecoveryPriority(s.env, id)).toMatchObject({ outcome: 'degraded' });
    expect(s.bucket.completions).toHaveLength(0); expect(record(s, INDEX).entries).toHaveLength(1);
    expect(await enqueuePaidRecoveryPriority(s.env, id)).toMatchObject({ outcome: 'already_pending' });
    expect(await drainPaidRecoveryPriority(s.env)).toMatchObject({ counts: { recovered: 1 } }); noPurchase(s);
  });

  it('a lost queue lease ACK never starts original recovery and an expired original lease is read back later', async () => {
    const s = setup(), id = await draft(s); await enqueuePaidRecoveryPriority(s.env, id);
    vi.useFakeTimers({ toFake: ['Date'] });
    const put = s.bucket.put.bind(s.bucket); let lost = true;
    s.bucket.put = async (target, value, options) => {
      const saved = await put(target, value, options);
      if (lost && target === INDEX && JSON.parse(String(value)).entries[0]?.claim_id) { lost = false; throw new Error('synthetic_lease_lost_ack'); }
      return saved;
    };
    expect(await drainPaidRecoveryPriority(s.env)).toMatchObject({ outcome: 'degraded', counts: { write_unconfirmed: 1, recovered: 0 } });
    expect(s.bucket.completions).toHaveLength(0);
    expect(await drainPaidRecoveryPriority(s.env)).toMatchObject({ counts: { selected: 0 } });
    vi.setSystemTime(Date.now() + PAID_RECOVERY_PRIORITY_LEASE_MS + 1);
    expect(await drainPaidRecoveryPriority(s.env)).toMatchObject({ counts: { recovered: 1 } }); noPurchase(s);
  });

  it('unknown terminal-observation ACK is exactly read back before dropping a resolved reference', async () => {
    const s = setup(), id = await draft(s); await enqueuePaidRecoveryPriority(s.env, id);
    const put = s.bucket.put.bind(s.bucket); let lost = true;
    s.bucket.put = async (target, value, options) => {
      const saved = await put(target, value, options);
      if (lost && target.startsWith(`${PAID_RECOVERY_PRIORITY_PREFIX}orders/`)) { lost = false; throw new Error('synthetic_observation_lost_ack'); }
      return saved;
    };
    expect(await drainPaidRecoveryPriority(s.env)).toMatchObject({ counts: { recovered: 1 } });
    expect(record(s, INDEX).entries).toEqual([]); expect(s.bucket.completions).toHaveLength(1); noPurchase(s);
  });

  it('an uncertain original completion stays pending until original readback establishes completion', async () => {
    const s = setup(), id = await draft(s); await enqueuePaidRecoveryPriority(s.env, id);
    const put = s.bucket.put.bind(s.bucket); let lost = true;
    s.bucket.put = async (target, value, options) => {
      const saved = await put(target, value, options);
      if (lost && target.startsWith('fulfillments/') && JSON.parse(String(value)).state === 'complete') { lost = false; throw new Error('synthetic_original_lost_ack'); }
      return saved;
    };
    expect(await drainPaidRecoveryPriority(s.env)).toMatchObject({ counts: { retry_scheduled: 1, recovered: 0 } });
    expect(record(s, INDEX).entries).toHaveLength(1);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + PAID_RECOVERY_PRIORITY_RETRY_MS + 1);
    expect(await drainPaidRecoveryPriority(s.env)).toMatchObject({ counts: { already_complete: 1, recovered: 0 } });
    expect(s.bucket.completions).toHaveLength(1); noPurchase(s);
  });

  it('missing drafts back off durably across invocations without new capture or resetting their original enrollment', async () => {
    const s = setup(), id = await draft(s); edit(s, key(s, 'fulfillments/', id), { response: undefined, response_hash: undefined });
    await enqueuePaidRecoveryPriority(s.env, id); const enrolled = record(s, INDEX).entries[0].enrolled_at;
    vi.useFakeTimers({ toFake: ['Date'] });
    expect(await drainPaidRecoveryPriority(s.env)).toMatchObject({ counts: { retry_scheduled: 1 } });
    const first = record(s, INDEX).entries[0]; expect(Date.parse(first.due_at) - Date.now()).toBe(PAID_RECOVERY_PRIORITY_RETRY_MS);
    expect(await enqueuePaidRecoveryPriority(s.env, id)).toMatchObject({ outcome: 'already_pending' });
    expect(await drainPaidRecoveryPriority(s.env)).toMatchObject({ counts: { selected: 0 } });
    vi.setSystemTime(Date.parse(first.due_at));
    expect(await drainPaidRecoveryPriority(s.env)).toMatchObject({ counts: { retry_scheduled: 1 } });
    const second = record(s, INDEX).entries[0];
    expect(second.enrolled_at).toBe(enrolled); expect(second.attempts).toBe(2);
    expect(Date.parse(second.due_at) - Date.now()).toBe(2 * PAID_RECOVERY_PRIORITY_RETRY_MS); noPurchase(s);
  });

  it.each(['unknown', 'corrupt', 'changed'])('quarantines a %s original without a terminal business claim or replacement', async kind => {
    const s = setup(), id = await draft(s); await enqueuePaidRecoveryPriority(s.env, id);
    if (kind === 'unknown') edit(s, key(s, 'settlements/'), { state: 'settlement_unknown' });
    if (kind === 'corrupt') edit(s, `orders/${id}.json`, { amount: 'broken' });
    if (kind === 'changed') edit(s, `orders/${id}.json`, { expires_at: new Date(Date.now() + 7_200_000).toISOString() });
    const before = originalBytes(s), get = vi.spyOn(s.bucket, 'get');
    expect(await drainPaidRecoveryPriority(s.env)).toMatchObject({ outcome: 'degraded', counts: { quarantined: 1, recovered: 0 } });
    expect(record(s, `${PAID_RECOVERY_PRIORITY_PREFIX}orders/${id}.json`)).toMatchObject({ state: 'quarantined' });
    expect(originalBytes(s)).toEqual(before); expect(s.bucket.completions).toHaveLength(0);
    expect(get.mock.calls.some(([target]) => /\/(page\.html|page\.md|screenshot\.png|manifest\.json)$/.test(target))).toBe(false); noPurchase(s);
  });

  it('a stalled original is isolated while a later due obligation completes and late continuations remain fenced', async () => {
    const s = setup(), a = await draft(s), b = await draft(s, 2);
    await enqueuePaidRecoveryPriority(s.env, a); await enqueuePaidRecoveryPriority(s.env, b);
    vi.useFakeTimers(); const get = s.bucket.get.bind(s.bucket);
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    s.bucket.get = async target => { if (target === `orders/${a}.json`) { entered(); await blocked; } return get(target); };
    const pending = drainPaidRecoveryPriority(s.env, { maxOrders: 2, deadlineMs: 1_200 });
    await started; await vi.advanceTimersByTimeAsync(401);
    const result = await pending;
    expect(result).toMatchObject({ counts: { selected: 2, inspected: 2, recovered: 1, retry_scheduled: 1 } });
    expect(result.items.find(item => item.order_id === b)?.state).toBe('recovered');
    const writes = s.bucket.completions.length; release(); await vi.advanceTimersByTimeAsync(1);
    expect(s.bucket.completions).toHaveLength(writes); expect(writes).toBe(1); noPurchase(s);
  });

  it('rejects a corrupt priority index independently and preserves every original object', async () => {
    const s = setup(), id = await draft(s); await enqueuePaidRecoveryPriority(s.env, id);
    edit(s, INDEX, { unexpected: 'invalid' }); const before = originalBytes(s);
    expect(await drainPaidRecoveryPriority(s.env)).toMatchObject({ outcome: 'degraded', reason: 'priority_unconfirmed', counts: { inspected: 0 } });
    await expect(paidRecoveryPriorityStatus(s.env)).rejects.toThrow(); expect(originalBytes(s)).toEqual(before); noPurchase(s);
  });
});
