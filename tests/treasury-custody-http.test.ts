import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleTreasuryCustody, TREASURY_CUSTODY_PREFIX, TREASURY_CUSTODY_DEADLINE_MS } from '../src/treasury-custody';
import { checkpointRevisionDigest } from '../scripts/treasury-checkpoint-store.mjs';
import { configuredRemoteCheckpointStore, createTreasuryHttpAuthority, TREASURY_CUSTODY_ORIGIN } from '../scripts/treasury-custody-http.mjs';
import { MemoryBucket, orderRuntime } from './helpers/order-runtime';
// @ts-expect-error Existing import-safe JavaScript CLI has no generated declarations.
import { runTreasuryCli } from '../scripts/reconcile-treasury.mjs';
// @ts-expect-error Original canonical receipt constants; this import performs no RPC.
import { USDC, TRANSFER_TOPIC, TO_TOPIC } from '../scripts/treasury-reconciliation.mjs';
const base = `${TREASURY_CUSTODY_ORIGIN}/internal/operations/treasury`;
const secret = 'synthetic-credential-not-a-real-secret';
const hash = (n: number) => `0x${String(n).padStart(64, '0')}`;
const key = (n: number) => `${TREASURY_CUSTODY_PREFIX}revision-${String(n).padStart(10, '0')}.json`;
const snapshot = (tip = 4) => ({ schema: 'delta-treasury-checkpoint/v1', network: 'eip155:8453', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  treasury: '0x1990e21bc219696ff7fbc26527dbaed335ac6367', origin_block: 1, checked_through_block: tip, checked_through_hash: hash(tip),
  reorg_anchor: { number: tip - 2, hash: hash(tip - 2) }, confirmation_depth: 12, checked_at: '2026-11-03T00:00:00.000Z', transfers: [], corrections: [] });
async function revision(version = 1, tip = 4, previous: string | null = null) {
  const state = snapshot(tip); return { schema: 'delta-treasury-revision/v1', version, previous_digest: previous, digest: await checkpointRevisionDigest(state), state };
}
class Bucket extends MemoryBucket {
  lists = 0; puts = 0; gets = 0;
  async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
    this.lists++; const all = [...this.values.keys()].filter(k => k.startsWith(options.prefix ?? '')).sort();
    const offset = Number(options.cursor ?? 0), limit = options.limit ?? 1000, truncated = offset + limit < all.length;
    return { objects: all.slice(offset, offset + limit).map(k => ({ key: k })), truncated, ...(truncated ? { cursor: String(offset + limit) } : {}), delimitedPrefixes: [] };
  }
  async get(k: string) { this.gets++; return super.get(k); }
  async put(k: string, body: unknown, options?: R2PutOptions) { this.puts++; return super.put(k, body, options); }
}
function fixture() {
  const bucket = new Bucket();
  const env = { ...orderRuntime(bucket), TREASURY_CUSTODY_ENABLED: 'true', TREASURY_CUSTODY_ORIGIN_BLOCK: '1',
    TREASURY_CUSTODY_MINIMUM_VERSION: '0', TREASURY_CUSTODY_MINIMUM_DIGEST: '', TREASURY_CUSTODY_ALLOW_BOOTSTRAP: 'true' };
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url).startsWith(base + '/')).toBe(true); expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`);
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    return handleTreasuryCustody(new Request(String(url), init), env);
  }) as unknown as typeof fetch;
  return { bucket, env, calls, fetchImpl };
}
function request(path: string, body?: unknown) {
  return new Request(base + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('private Treasury custody transport, local HTTP to synthetic R2 only', () => {
  it('missing flags and approved floor fail503 instead of empty custody or receipts0', async () => {
    const f = fixture();
    for (const patch of [{ TREASURY_CUSTODY_ENABLED: '1' }, { TREASURY_CUSTODY_ORIGIN_BLOCK: undefined },
      { TREASURY_CUSTODY_ALLOW_BOOTSTRAP: undefined }, { TREASURY_CUSTODY_MINIMUM_VERSION: '1', TREASURY_CUSTODY_MINIMUM_DIGEST: 'a'.repeat(64) }]) {
      const result = await handleTreasuryCustody(request('/config'), { ...f.env, ...patch });
      expect(result.status).toBe(503); expect(await result.json()).toEqual({ ok: false, error: 'treasury_custody_unavailable', retryable: false });
    }
    expect(f.bucket.puts).toBe(0);
  });
  it('configured HTTP port and original custody bridge append and resume exact original revisions', async () => {
    const f = fixture(), configured = await configuredRemoteCheckpointStore({ DELTA_OPERATIONS_ADMIN_SECRET: secret }, { fetchImpl: f.fetchImpl });
    expect(configured.initialBlock).toBe(1); expect(await configured.checkpointStore.read()).toBeNull();
    const one = await configured.checkpointStore.compareAndSwap(null, snapshot()), two = await configured.checkpointStore.compareAndSwap(1, snapshot(8));
    expect(one?.version).toBe(1); expect(two?.previous_digest).toBe(one?.digest);
    expect(await configured.checkpointStore.read()).toEqual(two); expect(f.calls.filter(x => x.method === 'POST')).toHaveLength(2);
    f.env.TREASURY_CUSTODY_MINIMUM_VERSION = '2'; f.env.TREASURY_CUSTODY_MINIMUM_DIGEST = two!.digest; f.env.TREASURY_CUSTODY_ALLOW_BOOTSTRAP = 'false';
    const restarted = await configuredRemoteCheckpointStore({ DELTA_OPERATIONS_ADMIN_SECRET: secret }, { fetchImpl: f.fetchImpl });
    expect(await restarted.checkpointStore.read()).toEqual(two); expect(f.bucket.values.size).toBe(2);
    expect(JSON.stringify(restarted.config)).not.toContain(secret);
  });
  it('actual remote CLI preserves partial checkpoint and a new client resumes original overlap without counting receipts twice', async () => {
    const f = fixture(), quantity = (n: number) => `0x${n.toString(16)}`;
    const logs = [3, 7].map((n, index) => ({ address: USDC, transactionHash: hash(n + 1000), blockHash: hash(n),
      blockNumber: quantity(n), logIndex: '0x0', removed: false,
      topics: [TRANSFER_TOPIC, `0x${'1'.repeat(40).padStart(64, '0')}`, TO_TOPIC],
      data: `0x${BigInt((index + 1) * 1_000_000).toString(16).padStart(64, '0')}` }));
    const chain = (interrupt: boolean) => {
      const ranges: Array<{ from: number; through: number }> = [];
      const rpc = async (method: string, params: any[]) => {
        if (method === 'eth_chainId') return { result: '0x2105' };
        if (method === 'eth_blockNumber') return { result: quantity(11) };
        if (method === 'eth_getBlockByNumber') {
          const n = Number(BigInt(params[0]));
          return { result: { number: quantity(n), hash: hash(n), parentHash: hash(Math.max(0, n - 1)) } };
        }
        if (method === 'eth_getLogs') {
          const from = Number(BigInt(params[0].fromBlock)), through = Number(BigInt(params[0].toBlock));
          ranges.push({ from, through });
          if (interrupt && from >= 5) throw Object.assign(new Error('synthetic_rpc_outage'), { category: 'synthetic_rpc_outage' });
          return { result: logs.filter(row => Number(BigInt(row.blockNumber)) >= from && Number(BigInt(row.blockNumber)) <= through) };
        }
        throw Error('unexpected_synthetic_rpc_method');
      };
      return { rpc, ranges };
    };
    const env = { DELTA_TREASURY_STATE_MODE: 'remote', DELTA_OPERATIONS_ADMIN_SECRET: secret,
      DELTA_TREASURY_CONFIRMATIONS: '1', DELTA_TREASURY_CHUNK_BLOCKS: '4', DELTA_TREASURY_OVERLAP_BLOCKS: '2',
      DELTA_TREASURY_LOOKBACK_BLOCKS: '1' };
    const firstChain = chain(true);
    // No checkpointStore or remoteCheckpointStore override: use the real CLI factory and HTTP port.
    const first = await runTreasuryCli(env, { rpc: firstChain.rpc, fetchImpl: f.fetchImpl, log() {} });
    expect(first).toMatchObject({ ok: false, scan_complete: false, origin_block: 1, checkpoint_after: 4,
      checkpoint_revision: 1, category: 'synthetic_rpc_outage', total_raw: null, treasury_received_candidates: null });
    const originalRevisionBytes = f.bucket.values.get(key(1));
    expect(f.bucket.values.size).toBe(1);
    const secondChain = chain(false);
    const resumed = await runTreasuryCli(env, { rpc: secondChain.rpc, fetchImpl: f.fetchImpl, log() {} });
    expect(resumed).toMatchObject({ ok: true, scan_complete: true, continuity_verified: true, origin_block: 1,
      start_block: 3, checkpoint_before: 4, checkpoint_after: 10, total_raw: '3000000', treasury_received_candidates: 2,
      recognized_customer_revenue_usdc: null, actual_variable_cost_usdc: null, actual_contribution_margin_usdc: null });
    expect(secondChain.ranges).toEqual([{ from: 3, through: 6 }, { from: 7, through: 10 }]);
    expect(new Set(resumed.transfers.map((row: { receipt_id: string }) => row.receipt_id)).size).toBe(2);
    expect(f.bucket.values.get(key(1))).toEqual(originalRevisionBytes);
    expect(f.bucket.values.size).toBe(3);
    expect(f.calls.filter(call => call.url === base + '/config')).toHaveLength(2);
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(3);
  });
  it('full paginated inventory follows truncated/cursor, including short pages and no invented empty', async () => {
    const f = fixture(), one = await revision(); await f.bucket.put(key(1), JSON.stringify(one)); await f.bucket.put(key(2), JSON.stringify(await revision(2, 8, one.digest)));
    const a = createTreasuryHttpAuthority({ secret, fetchImpl: f.fetchImpl });
    expect(await a.listRevisions({ cursor: null, limit: 1 })).toEqual({ versions: [1], cursor: '1' });
    expect(await a.listRevisions({ cursor: '1', limit: 1 })).toEqual({ versions: [2], cursor: null });
    const list = f.bucket.list.bind(f.bucket); f.bucket.list = async opts => ({ ...await list(opts), truncated: true, cursor: '' });
    expect((await handleTreasuryCustody(request('/revisions'), f.env)).status).toBe(503);
  });
  it('append is create-only and concurrent callers cannot overwrite the same original revision', async () => {
    const f = fixture(), item = await revision();
    const result = await Promise.all([handleTreasuryCustody(request('/revisions/1', item), f.env), handleTreasuryCustody(request('/revisions/1', item), f.env)]);
    expect(result.map(r => r.status).sort()).toEqual([201, 409]);
    const before = f.bucket.values.get(key(1));
    expect((await handleTreasuryCustody(request('/revisions/1', await revision(1, 5)), f.env)).status).toBe(409);
    expect(f.bucket.values.get(key(1))).toEqual(before);
  });
  it('append requires exact previous digest, approved original origin and monotonic cursor without full inventory', async () => {
    const f = fixture(), one = await revision(); await f.bucket.put(key(1), JSON.stringify(one));
    f.env.TREASURY_CUSTODY_MINIMUM_VERSION = '1'; f.env.TREASURY_CUSTODY_MINIMUM_DIGEST = one.digest;
    const two = await revision(2, 8, one.digest), before = f.bucket.puts;
    for (const bad of [{ ...two, previous_digest: 'a'.repeat(64) }, { ...two, digest: 'b'.repeat(64) },
      { ...two, state: { ...two.state, origin_block: 2 } }]) expect((await handleTreasuryCustody(request('/revisions/2', bad), f.env)).status).toBe(503);
    expect((await handleTreasuryCustody(request('/revisions/2', await revision(2, 3, one.digest)), f.env)).status).toBe(409);
    expect((await handleTreasuryCustody(request('/revisions/3', await revision(3, 10, two.digest)), f.env)).status).toBe(409);
    expect(f.bucket.puts).toBe(before); expect(f.bucket.lists).toBe(0);
    expect((await handleTreasuryCustody(request('/revisions/2', two), f.env)).status).toBe(201);
    expect(f.bucket.lists).toBe(0); expect(f.bucket.gets).toBeLessThan(20);
  });
  it('declared approved floor cannot be absent or changed andbootstrap cannot fill an existing history gap', async () => {
    const f = fixture(), one = await revision(); await f.bucket.put(key(2), JSON.stringify(await revision(2, 8, one.digest)));
    expect((await handleTreasuryCustody(request('/revisions/1', one), f.env)).status).toBe(409);
    f.env.TREASURY_CUSTODY_MINIMUM_VERSION = '2'; f.env.TREASURY_CUSTODY_MINIMUM_DIGEST = 'a'.repeat(64);
    expect((await handleTreasuryCustody(request('/config'), f.env)).status).toBe(503);
  });
  it('missing revision404 is distinct from provider503 or an unrelated404 route', async () => {
    const f = fixture(), a = createTreasuryHttpAuthority({ secret, fetchImpl: f.fetchImpl });
    expect(await a.getRevision(1, {})).toBeNull();
    f.bucket.get = async () => { throw Error('credential-like-provider-error'); };
    await expect(a.getRevision(1, {})).rejects.toThrow('custody_http_read_unavailable');
    const unrelated = createTreasuryHttpAuthority({ secret, fetchImpl: async () => Response.json({ error: 'not-found' }, { status: 404 }) });
    await expect(unrelated.getRevision(1, {})).rejects.toThrow('custody_http_read_unavailable');
  });
  it('lost POST ACK performs one POST then original readback and never publishes again', async () => {
    const f = fixture(); let posts = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await f.fetchImpl(input, init); if (init?.method === 'POST') { posts++; throw Error('synthetic lost ACK'); } return response;
    }) as typeof fetch;
    const configured = await configuredRemoteCheckpointStore({ DELTA_OPERATIONS_ADMIN_SECRET: secret }, { fetchImpl });
    expect((await configured.checkpointStore.compareAndSwap(null, snapshot()))?.version).toBe(1);
    expect(posts).toBe(1); expect(f.bucket.values.size).toBe(1);
  });
  it('GET retry is bounded, credentials/redirects cannot be moved to another origin and POST is one attempt', async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_: unknown, init?: RequestInit) => { calls.push(init!); return Response.json({ error: 'fixture' }, { status: 503 }); }) as unknown as typeof fetch;
    const a = createTreasuryHttpAuthority({ secret, fetchImpl });
    await expect(a.getRevision(1, {})).rejects.toThrow(); expect(calls).toHaveLength(2);
    await expect(a.putRevisionIfAbsent(1, new TextEncoder().encode('{}'), {})).rejects.toThrow('custody_http_write_unknown'); expect(calls).toHaveLength(3);
    expect(calls.every(c => c.redirect === 'error')).toBe(true);
    const forbidden = vi.fn(async () => Response.json({}, { status: 403 }));
    await expect(createTreasuryHttpAuthority({ secret, fetchImpl: forbidden }).getRevision(1, {})).rejects.toThrow(); expect(forbidden).toHaveBeenCalledTimes(1);
    expect(() => createTreasuryHttpAuthority({ secret: '' })).toThrow('credential_required');
  });
  it('server config must match exact approved public shape without extra fields or changed receipt scope', async () => {
    const f = fixture(), valid = await (await handleTreasuryCustody(request('/config'), f.env)).json() as Record<string, unknown>;
    for (const invalid of [{ ...valid, token: secret }, { ...valid, treasury: '0x' + '1'.repeat(40) }, { ...valid, origin_block: -1 },
      { ...valid, minimum_revision: { version: 1, digest: 'a'.repeat(64), extra: secret }, allow_bootstrap: false }]) {
      const a = createTreasuryHttpAuthority({ secret, fetchImpl: async () => Response.json(invalid) });
      await expect(a.config()).rejects.toThrow('custody_http_config_invalid');
    }
  });
  it('streaming bytes and invalid or oversized bodies cannot write storage or bypass a misleading size', async () => {
    const f = fixture();
    const huge = new Request(base + '/revisions/1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(16_000_001) });
    expect((await handleTreasuryCustody(huge, f.env)).status).toBe(503); expect(f.bucket.puts).toBe(0);
    await f.bucket.put(key(1), JSON.stringify(await revision())); const original = f.bucket.get.bind(f.bucket);
    f.bucket.get = async k => { const record = await original(k); return record ? { ...record, size: 1 } : null; };
    expect((await handleTreasuryCustody(request('/revisions/1'), f.env)).status).toBe(503);
  });
  it('stalled original read is bounded and late resolution cannot start append', async () => {
    vi.useFakeTimers(); const f = fixture(), one = await revision(); await f.bucket.put(key(1), JSON.stringify(one));
    const original = f.bucket.get.bind(f.bucket); let release!: () => void;
    f.bucket.get = async k => { await new Promise<void>(resolve => { release = resolve; }); return original(k); };
    const response = handleTreasuryCustody(request('/revisions/2', await revision(2, 8, one.digest)), f.env);
    await vi.advanceTimersByTimeAsync(TREASURY_CUSTODY_DEADLINE_MS + 1); expect((await response).status).toBe(503);
    release(); await vi.advanceTimersByTimeAsync(1); expect(f.bucket.puts).toBe(1);
  });
  it('late create-only write remains unknown to timed-out handler, never retries or overwrites', async () => {
    vi.useFakeTimers(); const f = fixture(), original = f.bucket.put.bind(f.bucket); let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }); let attempts = 0;
    f.bucket.put = async (k, v, o) => { attempts++; entered(); await new Promise<void>(resolve => { release = resolve; }); return original(k, v, o); };
    const response = handleTreasuryCustody(request('/revisions/1', await revision()), f.env); await ready;
    await vi.advanceTimersByTimeAsync(TREASURY_CUSTODY_DEADLINE_MS + 1);
    expect(await (await response).json()).toMatchObject({ error: 'treasury_custody_write_unknown', retryable: false });
    release(); await vi.advanceTimersByTimeAsync(1); expect(attempts).toBe(1); expect(f.bucket.values.size).toBe(1);
  });
  it('HTTP timeout bounds headers and body, preserving unknown instead of a hidden write retry', async () => {
    const fetchImpl = vi.fn(async () => new Promise<Response>(() => {}));
    const a = createTreasuryHttpAuthority({ secret, fetchImpl, requestTimeoutMs: 5 });
    await expect(a.getRevision(1, {})).rejects.toThrow('custody_http_unavailable'); expect(fetchImpl).toHaveBeenCalledTimes(2);
    const slow = vi.fn(async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } })));
    await expect(createTreasuryHttpAuthority({ secret, fetchImpl: slow, requestTimeoutMs: 5 }).putRevisionIfAbsent(1, new TextEncoder().encode('{}'), {})).rejects.toThrow('custody_http_unavailable');
    expect(slow).toHaveBeenCalledTimes(1);
  });
});
