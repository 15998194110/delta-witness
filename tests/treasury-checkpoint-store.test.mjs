import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { continuousCheckpointStore, checkpointRevisionDigest, validateCustodyRevision } from '../scripts/treasury-checkpoint-store.mjs';
import { fileCheckpointStore } from '../scripts/treasury-checkpoint.mjs';
import { reconcileTreasury, validateCheckpoint, NETWORK, TREASURY, USDC, TRANSFER_TOPIC, TO_TOPIC } from '../scripts/treasury-reconciliation.mjs';
import { validateTreasuryReport } from '../scripts/validate-treasury-report.mjs';
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
const hash = n => `0x${(BigInt(n) + 1000n).toString(16).padStart(64, '0')}`;
const q = n => `0x${n.toString(16)}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function state(through = 4, extra = {}) {
  return { schema: 'delta-treasury-checkpoint/v1', network: NETWORK, asset: USDC, treasury: TREASURY,
    origin_block: 1, checked_through_block: through, checked_through_hash: hash(through), reorg_anchor: { number: Math.max(0, through - 2), hash: hash(Math.max(0, through - 2)) },
    confirmation_depth: 1, checked_at: '2026-11-03T00:00:00.000Z', transfers: [], corrections: [], ...extra };
}
async function revision(version, snapshot = state(), previous = null) {
  return { schema: 'delta-treasury-revision/v1', version, previous_digest: previous, digest: await checkpointRevisionDigest(snapshot), state: snapshot };
}
function memoryAuthority({ pageSize = 1000 } = {}) {
  const objects = new Map(), calls = { list: 0, get: 0, put: 0 };
  return { objects, calls,
    async listRevisions({ cursor }) {
      calls.list++;
      const all = [...objects.keys()].sort((a, b) => a - b), offset = cursor === null ? 0 : Number(cursor);
      return { versions: all.slice(offset, offset + pageSize), cursor: offset + pageSize < all.length ? String(offset + pageSize) : null };
    },
    async getRevision(version) { calls.get++; return objects.has(version) ? { body: new Response(objects.get(version).slice()).body } : null; },
    async putRevisionIfAbsent(version, bytes) {
      calls.put++; if (objects.has(version)) return { created: false };
      objects.set(version, bytes.slice()); return { created: true };
    },
  };
}
function store(authority, options = {}) { return continuousCheckpointStore({ authority, originBlock: 1, allowBootstrap: true, readTimeoutMs: 1000, writeTimeoutMs: 1000, ...options }); }
const putRaw = (authority, item) => authority.objects.set(item.version, new TextEncoder().encode(JSON.stringify(item)));

test('custody activation requires pinned origin, explicit bootstrap or exact existing floor', () => {
  const authority = memoryAuthority();
  assert.throws(() => continuousCheckpointStore({ authority, originBlock: 1 }), /bootstrap_not_authorized/);
  assert.throws(() => continuousCheckpointStore({ authority, allowBootstrap: true }), /invalid_custody_origin/);
  for (const minimumRevision of [{ version: 0, digest: 'a'.repeat(64) }, { version: 1, digest: 'bad' }, { version: '1', digest: 'a'.repeat(64) }]) {
    assert.throws(() => store(authority, { minimumRevision }), /floor_invalid/);
  }
  assert.throws(() => store({}), /authority_required/);
});

test('pure Worker-compatible validator accepts original local revision bytes and SHA256 ordering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'delta-custody-existing-'));
  const snapshot = state(4, { historical_unknown_field: 'preserved' });
  const original = await fileCheckpointStore(dir).compareAndSwap(null, snapshot);
  const bytes = await readFile(join(dir, 'revision-0000000001.json'));
  assert.equal(await checkpointRevisionDigest(snapshot), createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'));
  assert.deepEqual(await validateCustodyRevision(JSON.parse(bytes), { originBlock: 1, expectedVersion: 1, previousDigest: null }), original);
  const authority = memoryAuthority(); authority.objects.set(1, new Uint8Array(bytes));
  const restored = continuousCheckpointStore({ authority, originBlock: 1, minimumRevision: { version: 1, digest: original.digest } });
  assert.deepEqual(await restored.read(), original); assert.equal(authority.calls.put, 0);
});

test('conditional immutable revisions preserve original history and reject stale CAS without another write', async () => {
  const authority = memoryAuthority(), custody = store(authority);
  assert.equal(await custody.read(), null);
  const first = await custody.compareAndSwap(null, state());
  const originalBytes = authority.objects.get(1).slice();
  const second = await custody.compareAndSwap(1, state(8));
  assert.equal(second.version, 2); assert.equal(second.previous_digest, first.digest);
  assert.equal(await custody.compareAndSwap(1, state(10)), null);
  assert.equal(authority.calls.put, 2); assert.deepEqual(authority.objects.get(1), originalBytes);
  const result = await custody.read(); result.state.checked_through_block = 99;
  assert.equal((await custody.read()).state.checked_through_block, 8);
});

test('pagination is complete before a chain is trusted and gaps or cursor cycles never bootstrap', async () => {
  const authority = memoryAuthority({ pageSize: 1 }); let previous = null;
  for (let n = 1; n <= 3; n++) { const item = await revision(n, state(n + 3), previous); putRaw(authority, item); previous = item.digest; }
  assert.equal((await store(authority).read()).version, 3); assert.equal(authority.calls.list, 3);
  const missing = memoryAuthority(); putRaw(missing, await revision(2));
  await assert.rejects(store(missing).read(), /revision_gap/); assert.equal(missing.calls.put, 0);
  const cycle = memoryAuthority(); cycle.listRevisions = async () => ({ versions: [], cursor: 'same' });
  await assert.rejects(store(cycle).read(), /inventory_cycle/);
  for (const bad of [null, {}, { versions: [], cursor: undefined }, { versions: [1, 1], cursor: null }, { versions: ['1'], cursor: null }]) {
    const corrupt = memoryAuthority(); corrupt.listRevisions = async () => bad;
    await assert.rejects(store(corrupt).read()); assert.equal(corrupt.calls.put, 0);
  }
});

test('trusted minimum revision prevents rollback, empty-as-reset and changed digest', async () => {
  const first = await revision(1), authority = memoryAuthority(); putRaw(authority, first);
  const custody = store(authority, { minimumRevision: { version: 1, digest: first.digest } });
  await custody.read(); authority.objects.delete(1); // Synthetic provider corruption; adapter never deletes.
  await assert.rejects(custody.read(), /below_trusted_floor/);
  putRaw(authority, await revision(1, state(5)));
  await assert.rejects(custody.read(), /floor_digest_mismatch/);
});

test('origin, cursor, scope, digest and previous chain changes fail closed', async () => {
  const first = await revision(1), authority = memoryAuthority(); putRaw(authority, first);
  const custody = store(authority); await custody.read();
  await assert.rejects(custody.compareAndSwap(1, state(3)), /cursor_regressed/);
  await assert.rejects(custody.compareAndSwap(1, state(5, { origin_block: 2 })), /origin_conflict/);
  await assert.rejects(custody.compareAndSwap(1, state(5, { treasury: '0x' + '9'.repeat(40) })), /scope_mismatch/);
  assert.equal(authority.calls.put, 0);
  for (const mutate of [
    item => { item.digest = 'a'.repeat(64); }, item => { item.previous_digest = 'b'.repeat(64); },
    item => { item.state.checked_through_block = 5; }, item => { item.state.origin_block = 2; },
  ]) {
    const bad = structuredClone(first); mutate(bad); const a = memoryAuthority(); putRaw(a, bad);
    await assert.rejects(store(a).read()); assert.equal(a.calls.put, 0);
  }
  const regressed = memoryAuthority(); putRaw(regressed, first); putRaw(regressed, await revision(2, state(3), first.digest));
  await assert.rejects(store(regressed).read(), /cursor_regressed/);
});

test('two independent writers have one immutable winner at the same expected version', async () => {
  const authority = memoryAuthority(); putRaw(authority, await revision(1));
  const a = store(authority), b = store(authority);
  const results = await Promise.all([a.compareAndSwap(1, state(8)), b.compareAndSwap(1, state(9))]);
  assert.equal(results.filter(Boolean).length, 1); assert.equal(authority.objects.size, 2);
  assert.equal((await a.read()).version, 2); assert.equal((await b.read()).digest, (await a.read()).digest);
});

test('lost write acknowledgement is resolved only by exact readback, with one write attempt', async () => {
  const authority = memoryAuthority(), original = authority.putRevisionIfAbsent.bind(authority);
  authority.putRevisionIfAbsent = async (...args) => { await original(...args); throw Error('synthetic secret must not escape'); };
  const custody = store(authority), result = await custody.compareAndSwap(null, state());
  assert.equal(result.version, 1); assert.equal(authority.calls.put, 1);
  assert.equal(custody.getObservability().write_state, 'confirmed_by_readback');
  assert.equal(custody.getObservability().pending_write, null);
});

test('uncertain write cannot be blindly retried; late commit is resolved with read-only history', async () => {
  const authority = memoryAuthority(), release = deferred(), started = deferred(), original = authority.putRevisionIfAbsent.bind(authority);
  let attempts = 0;
  authority.putRevisionIfAbsent = async (...args) => { attempts++; started.resolve(); await release.promise; return original(...args); };
  const custody = store(authority, { writeTimeoutMs: 10 });
  const operation = custody.compareAndSwap(null, state()); await started.promise;
  await assert.rejects(operation, /write_unknown_readback_required/);
  const observation = custody.getObservability();
  assert.equal(observation.write_state, 'unknown'); assert.equal(observation.last_confirmed_cursor, null);
  assert.equal(observation.pending_write.version, 1);
  await assert.rejects(custody.compareAndSwap(null, state(5)), /write_unknown_readback_required/);
  assert.equal(attempts, 1);
  release.resolve(); await sleep(1);
  assert.equal((await custody.read()).version, 1); assert.equal(attempts, 1);
  assert.equal(custody.getObservability().write_state, 'confirmed_by_readback');
  assert.equal((await store(authority).read()).state.checked_through_block, 4);
});

test('late timed-out writer cannot overwrite a different confirmed winner after restart', async () => {
  const authority = memoryAuthority(), first = await revision(1); putRaw(authority, first);
  const release = deferred(), original = authority.putRevisionIfAbsent.bind(authority); let slow = true;
  authority.putRevisionIfAbsent = async (...args) => { if (slow) { slow = false; await release.promise; } return original(...args); };
  const old = store(authority, { writeTimeoutMs: 10 });
  await assert.rejects(old.compareAndSwap(1, state(8)), /write_unknown_readback_required/);
  const newer = store(authority, { minimumRevision: { version: 1, digest: first.digest } });
  const winner = await newer.compareAndSwap(1, state(9)); assert.equal(winner.state.checked_through_block, 9);
  const bytes = authority.objects.get(2).slice(); release.resolve(); await sleep(1);
  assert.equal((await old.read()).digest, winner.digest); assert.equal(old.getObservability().write_state, 'conflict');
  assert.deepEqual(authority.objects.get(2), bytes);
});

test('readback denial never becomes absent or zero, preserves prior confirmed cursor and fences subsequent writes', async () => {
  const authority = memoryAuthority(), first = await revision(1); putRaw(authority, first);
  const original = authority.putRevisionIfAbsent.bind(authority);
  authority.putRevisionIfAbsent = async (...args) => { await original(...args); authority.listRevisions = async () => { throw Error('credential-like-fixture'); }; return { created: true }; };
  const custody = store(authority);
  await assert.rejects(custody.compareAndSwap(1, state(8)), error => error.category === 'checkpoint_custody_write_unknown_readback_required' && !error.message.includes('credential-like-fixture'));
  assert.equal(custody.getObservability().last_confirmed_cursor, 4);
  for (const key of ['recognized_customer_revenue_usdc', 'actual_variable_cost_usdc', 'actual_contribution_margin_usdc']) assert.equal(custody.getObservability()[key], null);
  await assert.rejects(custody.compareAndSwap(1, state(8)), /write_unknown/); assert.equal(authority.calls.put, 1);
});

test('stalled inventory and late read completion cannot continue into a write', async () => {
  const authority = memoryAuthority(), release = deferred();
  authority.listRevisions = async () => { await release.promise; return { versions: [], cursor: null }; };
  const custody = store(authority, { readTimeoutMs: 10 });
  await assert.rejects(custody.compareAndSwap(null, state()), /timeout/);
  release.resolve(); await sleep(1); assert.equal(authority.calls.put, 0);
});

test('actual stream bytes, malformed UTF8 and stalled bodies are bounded without json-only bypass', async () => {
  const first = await revision(1);
  for (const body of [new Uint8Array([255]), new TextEncoder().encode('{'), new TextEncoder().encode('\uFEFF{}'), new Uint8Array(16_000_001)]) {
    const authority = memoryAuthority(); putRaw(authority, first);
    authority.getRevision = async () => ({ body: new Response(body).body, size: 1 });
    await assert.rejects(store(authority).read()); assert.equal(authority.calls.put, 0);
  }
  const authority = memoryAuthority(); putRaw(authority, first); let cancelled = false;
  authority.getRevision = async () => ({ body: new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } }) });
  await assert.rejects(store(authority, { readTimeoutMs: 10 }).read(), /timeout/); assert.equal(cancelled, true);
  authority.getRevision = async () => ({ json: async () => first });
  await assert.rejects(store(authority).read(), /body_required/);
});

test('missing listed revision and malformed acknowledgement never permit a guessed success', async () => {
  const authority = memoryAuthority(); putRaw(authority, await revision(1)); authority.getRevision = async () => null;
  await assert.rejects(store(authority).read(), /listed_revision_missing/);
  const empty = memoryAuthority(); empty.putRevisionIfAbsent = async () => ({ created: true });
  await assert.rejects(store(empty).compareAndSwap(null, state()), /write_unknown/);
});

test('complete inventory limits and cumulative actual history bytes cannot be bypassed by small individual records', async () => {
  const pages = memoryAuthority(); let count = 0;
  pages.listRevisions = async () => ({ versions: [], cursor: String(++count) });
  await assert.rejects(store(pages).read(), /inventory_limit/); assert.equal(count, 100); assert.equal(pages.calls.get, 0);
  const largePage = memoryAuthority(); largePage.listRevisions = async () => ({ versions: Array.from({ length: 1001 }, (_, i) => i + 1), cursor: null });
  await assert.rejects(store(largePage).read(), /inventory_invalid/);
  const history = memoryAuthority(); let previous = null;
  // Each original revision is <16 MB, but the retained history exceeds64 MB.
  for (let n = 1; n <= 5; n++) {
    const item = await revision(n, state(n + 3, { historical_padding: 'x'.repeat(12_900_000) }), previous);
    previous = item.digest; putRaw(history, item);
  }
  await assert.rejects(store(history, { readTimeoutMs: 10000 }).read(), /body_limit/);
  assert.equal(history.calls.put, 0); assert.equal(history.objects.size, 5);
});

function chain({ failFrom, head = 11 } = {}) {
  const transfer = { address: USDC, transactionHash: hash(100000), blockHash: hash(3), blockNumber: q(3), logIndex: '0x0', removed: false,
    topics: [TRANSFER_TOPIC, `0x${'0'.repeat(24)}${'1'.repeat(40)}`, TO_TOPIC], data: `0x${1000000n.toString(16).padStart(64, '0')}` };
  return async (method, params) => {
    if (method === 'eth_chainId') return { result: '0x2105' };
    if (method === 'eth_blockNumber') return { result: q(head) };
    if (method === 'eth_getBlockByNumber') { const n = Number(BigInt(params[0])); return { result: { number: q(n), hash: hash(n), parentHash: hash(Math.max(0, n - 1)) } }; }
    if (method === 'eth_getLogs') {
      const from = Number(BigInt(params[0].fromBlock)), through = Number(BigInt(params[0].toBlock));
      if (failFrom !== undefined && from >= failFrom) throw Error('synthetic RPC outage');
      return { result: from <= 3 && through >= 3 ? [transfer] : [] };
    }
    throw Error('unexpected synthetic RPC method');
  };
}

test('existing reconciliation resumes original partial cursor and unique receipt through the custody bridge', async () => {
  const authority = memoryAuthority(), options = { initialBlock: 1, confirmations: 1, chunkBlocks: 4, overlapBlocks: 2 };
  const interrupted = await reconcileTreasury({ ...options, rpc: chain({ failFrom: 5 }), checkpointStore: store(authority) });
  assert.equal(interrupted.ok, false); assert.equal(interrupted.checkpoint_after, 4);
  assert.equal(interrupted.total_raw, null); assert.equal(interrupted.treasury_received_candidates, null);
  const originalBytes = authority.objects.get(1).slice(), first = JSON.parse(new TextDecoder().decode(originalBytes));
  validateCheckpoint(first.state); assert.equal(first.state.transfers.length, 1);
  const resumed = await reconcileTreasury({ ...options, rpc: chain(), checkpointStore: store(authority, { minimumRevision: { version: 1, digest: first.digest } }) });
  assert.equal(resumed.ok, true); assert.equal(resumed.checkpoint_before, 4); assert.equal(resumed.start_block, 3);
  assert.equal(resumed.total_raw, '1000000'); assert.equal(resumed.transfers.length, 1);
  assert.equal(resumed.recognized_customer_revenue_usdc, null);
  assert.equal(validateTreasuryReport(resumed, { requireContinuity: true }).ok, true);
  assert.deepEqual(authority.objects.get(1), originalBytes);
});

test('lost acknowledgement and unavailable readback remain unknown in the original report, not completed or zero', async () => {
  const authority = memoryAuthority(), original = authority.putRevisionIfAbsent.bind(authority);
  authority.putRevisionIfAbsent = async (...args) => { await original(...args); authority.listRevisions = async () => { throw Error('synthetic outage'); }; throw Error('synthetic ACK loss'); };
  const report = await reconcileTreasury({ initialBlock: 1, confirmations: 1, chunkBlocks: 4, overlapBlocks: 2, rpc: chain(), checkpointStore: store(authority) });
  assert.equal(report.ok, false); assert.equal(report.checkpoint_write_status, 'unknown_readback_required');
  assert.equal(report.checkpoint_after, null); assert.equal(report.total_raw, null); assert.equal(report.recognized_customer_revenue_usdc, null);
  assert.equal(validateTreasuryReport(report).ok, false); assert.equal(authority.calls.put, 1);
});
