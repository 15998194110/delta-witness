import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reconcileTreasury, createRpcClient, TREASURY, USDC, TRANSFER_TOPIC, TO_TOPIC, failure } from '../scripts/treasury-reconciliation.mjs';
import { fileCheckpointStore } from '../scripts/treasury-checkpoint.mjs';
import { validateTreasuryReport } from '../scripts/validate-treasury-report.mjs';
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');

const hash = n => `0x${BigInt(n + 1000).toString(16).padStart(64, '0')}`;
const quantity = n => `0x${n.toString(16)}`;
function transfer(n, amount = 1000000n, tx = n, from = `0x${'1'.repeat(40)}`) {
  return { address: USDC, transactionHash: hash(tx + 100000), blockHash: hash(n), blockNumber: quantity(n), logIndex: '0x0', removed: false,
    topics: [TRANSFER_TOPIC, `0x${from.slice(2).padStart(64, '0')}`, TO_TOPIC], data: `0x${amount.toString(16).padStart(64, '0')}` };
}
function chain({ head = 11, logs = [], malformed, changed = new Map(), failFrom, chainId = '0x2105' } = {}) {
  const requests = [];
  const blockHash = n => changed.get(n) ?? hash(n);
  const rpc = async (method, params) => {
    requests.push({ method, params });
    if (method === 'eth_chainId') return { result: chainId };
    if (method === 'eth_blockNumber') return { result: quantity(head) };
    if (method === 'eth_getBlockByNumber') {
      const number = Number(BigInt(params[0]));
      return { result: { number: quantity(number), hash: blockHash(number), parentHash: blockHash(Math.max(0, number - 1)) } };
    }
    if (method === 'eth_getLogs') {
      const from = Number(BigInt(params[0].fromBlock));
      const through = Number(BigInt(params[0].toBlock));
      if (failFrom !== undefined && from >= failFrom) throw failure('fixture_outage');
      return { result: malformed !== undefined ? malformed : logs.filter(l => Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= through) };
    }
    throw new Error(`Unexpected fixture method ${method}`);
  };
  return { rpc, requests };
}
function memoryStore() {
  const snapshots = [];
  return {
    snapshots,
    async read() { return snapshots.length ? structuredClone(snapshots.at(-1)) : null; },
    async compareAndSwap(version, state) {
      if ((snapshots.at(-1)?.version ?? null) !== version) return null;
      const next = { version: (version ?? 0) + 1, state: structuredClone(state) };
      snapshots.push(next);
      return structuredClone(next);
    },
  };
}
const scan = (fixture, extra = {}) => reconcileTreasury({ rpc: fixture.rpc, confirmations: 1, initialBlock: 1, chunkBlocks: 4, overlapBlocks: 2, ...extra });

test('Treasury CLI import is inert even when fetch would fail', () => {
  const url = new URL('../scripts/reconcile-treasury.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `globalThis.fetch=()=>{throw Error('network forbidden')}; await import(${JSON.stringify(url)});`], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('complete declared window passes interval gate, never the continuous rollout gate', async () => {
  const report = await scan(chain({ logs: [transfer(3)] }));
  assert.equal(report.ok, true);
  assert.equal(report.latest_block, 11);
  assert.equal(report.last_scanned_block, 10);
  assert.equal(report.total_raw, '1000000');
  assert.equal(report.persistence_rollout_required, true);
  assert.equal(report.recognized_customer_revenue_usdc, null);
  assert.equal(validateTreasuryReport(report).ok, true);
  assert.equal(validateTreasuryReport(report, { requireContinuity: true }).ok, false);
});

test('continuous catchup never truncates an outage longer than 50000 blocks', async () => {
  const fixture = chain({ head: 60020, logs: [transfer(11), transfer(55001)] });
  const store = memoryStore();
  const report = await scan(fixture, { checkpointStore: store, initialBlock: 10, chunkBlocks: 1900, lookbackBlocks: 5 });
  assert.equal(report.ok, true);
  assert.equal(report.start_block, 10);
  assert.equal(report.total_raw, '2000000');
  const ranges = fixture.requests.filter(r => r.method === 'eth_getLogs').map(r => r.params[0]);
  assert.equal(ranges[0].fromBlock, '0xa');
  assert.equal(ranges.at(-1).toBlock, quantity(60019));
  for (let i = 1; i < ranges.length; i++) assert.equal(BigInt(ranges[i].fromBlock), BigInt(ranges[i - 1].toBlock) + 1n);
  assert.equal(validateTreasuryReport(report, { requireContinuity: true }).ok, true);
});

test('interruption commits only contiguous validated chunks; restart rechecks overlap once', async () => {
  const store = memoryStore();
  const logs = [transfer(3), transfer(7)];
  const failed = await scan(chain({ logs, failFrom: 5 }), { checkpointStore: store });
  assert.equal(failed.ok, false);
  assert.equal(failed.checkpoint_after, 4);
  assert.equal(failed.total_raw, null);
  assert.equal(failed.treasury_received_candidates, null);
  assert.equal(store.snapshots.at(-1).state.transfers.length, 1);
  const recovered = await scan(chain({ logs }), { checkpointStore: store });
  assert.equal(recovered.start_block, 3);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.total_raw, '2000000');
  assert.equal(recovered.transfers.length, 2);
  assert.deepEqual(store.snapshots[0].state.transfers.map(t => t.raw_amount), ['1000000']);
});

test('within-anchor reorg replaces receipt evidence and preserves prior revisions', async () => {
  const store = memoryStore();
  await scan(chain({ head: 6, logs: [transfer(4)] }), { checkpointStore: store, overlapBlocks: 3 });
  const previous = JSON.stringify(store.snapshots);
  const replacement = { ...transfer(4, 2000000n, 44), blockHash: hash(444) };
  const report = await scan(chain({ head: 6, logs: [replacement], changed: new Map([[4, hash(444)], [5, hash(555)]]) }), { checkpointStore: store, overlapBlocks: 3 });
  assert.equal(report.ok, true);
  assert.equal(report.checkpoint_before, 5);
  assert.equal(report.checkpoint_after, 5);
  assert.equal(report.total_raw, '2000000');
  assert.equal(report.corrections[0].kind, 'removed');
  assert.equal(JSON.stringify(store.snapshots.slice(0, 2)), previous);
});

test('deep reorg fails closed without rolling back or rewriting the checkpoint', async () => {
  const store = memoryStore();
  await scan(chain(), { checkpointStore: store });
  const previous = JSON.stringify(store.snapshots);
  const anchor = store.snapshots.at(-1).state.reorg_anchor.number;
  const report = await scan(chain({ changed: new Map([[anchor, hash(999)]]) }), { checkpointStore: store });
  assert.equal(report.category, 'reorg_beyond_retained_anchor');
  assert.equal(report.total_raw, null);
  assert.equal(JSON.stringify(store.snapshots), previous);
});

test('missing or changed receipts under the same canonical block hash are unknown, not a reorg', async () => {
  for (const logs of [[], [transfer(4, 7n)]]) {
    const store = memoryStore();
    await scan(chain({ head: 6, logs: [transfer(4)] }), { checkpointStore: store, overlapBlocks: 3 });
    const before = JSON.stringify(store.snapshots);
    const report = await scan(chain({ head: 6, logs }), { checkpointStore: store, overlapBlocks: 3 });
    assert.equal(report.ok, false);
    assert.equal(report.category, 'inconsistent_receipt_readback');
    assert.equal(report.total_raw, null);
    assert.equal(JSON.stringify(store.snapshots), before);
  }
});

test('new receipt in already-certified unchanged history is contradictory evidence', async () => {
  const store = memoryStore();
  await scan(chain({ head: 6 }), { checkpointStore: store, overlapBlocks: 3 });
  const before = JSON.stringify(store.snapshots);
  const report = await scan(chain({ head: 7, logs: [transfer(4)] }), { checkpointStore: store, overlapBlocks: 3 });
  assert.equal(report.ok, false);
  assert.equal(report.category, 'inconsistent_receipt_readback');
  assert.equal(report.total_raw, null);
  assert.equal(JSON.stringify(store.snapshots), before);
});

test('null, non-array, provider pagination wrappers and capped logs remain unknown', async () => {
  for (const malformed of [null, {}, '', { logs: [], next: 'cursor' }]) {
    const report = await scan(chain({ malformed }));
    assert.equal(report.ok, false);
    assert.equal(report.total_raw, null);
  }
  const capped = await scan(chain({ logs: [transfer(1), transfer(2)] }), { maxLogsPerChunk: 2 });
  assert.equal(capped.category, 'log_limit_requires_smaller_range');
});

test('receipt block hashes and Base chain identity are verified before completion', async () => {
  assert.equal((await scan(chain({ chainId: '0x1' }))).category, 'wrong_chain');
  assert.equal((await scan(chain({ logs: [{ ...transfer(2), blockHash: hash(777) }] }))).category, 'receipt_block_hash_mismatch');
});

test('raw integer totals remain exact beyond JavaScript safe integer range', async () => {
  const amount = 9007199254740993n;
  const report = await scan(chain({ logs: [transfer(2, amount), transfer(3, 7n)] }));
  assert.equal(report.ok, true);
  assert.equal(report.total_raw, '9007199254741000');
  assert.equal(report.total_usdc_decimal, '9007199254.741000');
  assert.equal(report.total_usdc, null, 'unsafe legacy numeric display is unavailable, not rounded');
  assert.equal(validateTreasuryReport(report).ok, true);
});

test('known platform/test payers remain excluded after recovery', async () => {
  const store = memoryStore();
  const fixture = chain({ logs: [transfer(2, 30000n, 2, '0x54e163e9b8edda194d83f46add921bfa5fc5f4e0')] });
  await scan(fixture, { checkpointStore: store });
  const report = await scan(fixture, { checkpointStore: store });
  assert.equal(report.known_non_customer_raw, '30000');
  assert.equal(report.transfers[0].customer_revenue, false);
  assert.equal(report.recognized_customer_revenue_usdc, null);
});

test('scan budgets preserve progress and never certify the unvisited suffix', async () => {
  const store = memoryStore();
  const report = await scan(chain({ head: 100 }), { checkpointStore: store, maxChunks: 2 });
  assert.equal(report.category, 'chunk_budget_exhausted');
  assert.equal(report.checkpoint_after, 8);
  assert.deepEqual(report.coverage_gap, { from_block: 9, through_block: 99 });
  assert.equal(validateTreasuryReport(report).ok, false);
});

test('unknown checkpoint persistence result cannot be reported as complete', async () => {
  const store = { async read() { return null; }, async compareAndSwap() { throw new Error('private fixture detail'); } };
  const report = await scan(chain(), { checkpointStore: store });
  assert.equal(report.ok, false);
  assert.equal(report.total_raw, null);
  assert.equal(report.checkpoint_advanced, null);
  assert.equal(report.checkpoint_write_status, 'unknown_readback_required');
  assert.doesNotMatch(JSON.stringify(report), /private fixture detail/);
});

test('restart reads a committed checkpoint when the previous writer lost its response', async () => {
  const store = memoryStore();
  const originalWrite = store.compareAndSwap;
  let loseResponse = true;
  store.compareAndSwap = async (version, state) => {
    const result = await originalWrite(version, state);
    if (loseResponse) { loseResponse = false; throw new Error('fixture response lost after publication'); }
    return result;
  };
  const logs = [transfer(3), transfer(7)];
  const first = await scan(chain({ logs }), { checkpointStore: store });
  assert.equal(first.checkpoint_write_status, 'unknown_readback_required');
  assert.equal(first.checkpoint_after, null);
  assert.equal(store.snapshots.at(-1).state.checked_through_block, 4);
  const resumed = await scan(chain({ logs }), { checkpointStore: store });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.checkpoint_before, 4);
  assert.equal(resumed.total_raw, '2000000');
  assert.equal(resumed.transfers.length, 2);
});

test('concurrent scanners have one CAS winner and no contradictory success or receipt loss', async () => {
  const store = memoryStore();
  const originalWrite = store.compareAndSwap;
  let arrivals = 0;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  store.compareAndSwap = async (version, state) => {
    if (version === null) {
      arrivals++;
      if (arrivals === 2) release();
      await barrier;
    }
    return originalWrite(version, state);
  };
  const logs = [transfer(3), transfer(7)];
  const reports = await Promise.all([
    scan(chain({ logs }), { checkpointStore: store }),
    scan(chain({ logs }), { checkpointStore: store }),
  ]);
  assert.equal(reports.filter(report => report.ok).length, 1);
  const loser = reports.find(report => !report.ok);
  assert.equal(loser.category, 'checkpoint_write_conflict');
  assert.equal(loser.total_raw, null);
  assert.equal(store.snapshots.at(-1).state.checked_through_block, 10);
  assert.equal(store.snapshots.at(-1).state.transfers.length, 2);
  assert.deepEqual(store.snapshots.map(item => item.version), [1, 2, 3]);
});

test('explicit state bootstrap is required; old checkpoint identity cannot be changed', async () => {
  const store = memoryStore();
  const missing = await reconcileTreasury({ rpc: chain().rpc, checkpointStore: store, confirmations: 1 });
  assert.equal(missing.category, 'initial_block_required');
  await scan(chain(), { checkpointStore: store });
  const report = await scan(chain(), { checkpointStore: store, initialBlock: 2 });
  assert.equal(report.category, 'checkpoint_origin_conflict');
});

test('filesystem CAS has one winner and retains immutable crash candidates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delta-treasury-test-'));
  try {
    const mem = memoryStore();
    await scan(chain(), { checkpointStore: mem });
    const state = mem.snapshots[0].state;
    const a = fileCheckpointStore(directory), b = fileCheckpointStore(directory);
    const results = await Promise.all([a.compareAndSwap(null, state), b.compareAndSwap(null, state)]);
    assert.equal(results.filter(Boolean).length, 1);
    const first = await readFile(join(directory, 'revision-0000000001.json'), 'utf8');
    assert.equal((await a.read()).version, 1);
    assert.equal(await b.compareAndSwap(null, state), null);
    assert.equal(await readFile(join(directory, 'revision-0000000001.json'), 'utf8'), first);
    assert.ok((await readdir(directory)).some(name => name.startsWith('candidate-')));
    await writeFile(join(directory, 'candidate-interrupted.json'), '{partial', { flag: 'wx' });
    assert.equal((await a.read()).version, 1);
    await writeFile(join(directory, 'revision-0000000003.json'), '{}', { flag: 'wx' });
    await assert.rejects(a.read(), /checkpoint_revision_gap/);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/'));
    await rm(directory, { recursive: true }); // Only this test's newly created fixture directory.
  }
});

test('bounded RPC fallback remembers healthy provider and validates each provider chain', async () => {
  const calls = [];
  const rpc = createRpcClient({ urls: ['https://primary.invalid', 'https://fallback.invalid'], sleep: async () => {}, fetchImpl: async (url, init) => {
    const { method } = JSON.parse(init.body); calls.push({ url, method });
    if (url.includes('primary') && method === 'eth_getLogs') return new Response('fixture', { status: 429 });
    return Response.json({ jsonrpc: '2.0', id: 1, result: method === 'eth_chainId' ? '0x2105' : [] });
  } });
  await rpc('eth_getLogs', [{}]);
  await rpc('eth_getLogs', [{}]);
  assert.equal(calls.filter(c => c.url.includes('primary') && c.method === 'eth_getLogs').length, 2);
  assert.equal(calls.filter(c => c.url.includes('fallback') && c.method === 'eth_chainId').length, 1);
  assert.equal(calls.at(-1).url, 'https://fallback.invalid');
});

test('RPC denial is not bypassed and response/error secrets are not logged', async () => {
  const logged = [];
  let calls = 0;
  const rpc = createRpcClient({ urls: ['https://one.invalid', 'https://two.invalid'], log: e => logged.push(e), fetchImpl: async () => { calls++; return new Response('fixture-secret', { status: 403 }); } });
  await assert.rejects(rpc('eth_chainId', []), /http_forbidden/);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(logged), /fixture-secret/);
});

test('response body deadline and byte limit bound the entire RPC read', async () => {
  let cancelled = false;
  let bodyCancelled = false;
  const hanging = createRpcClient({ attempts: 1, urls: ['https://fixture.invalid'], requestTimeoutMs: 15, fetchImpl: async (_url, init) => {
    init.signal.addEventListener('abort', () => { cancelled = true; });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { bodyCancelled = true; } }));
  } });
  await assert.rejects(hanging('eth_chainId', []), /rpc_timeout/);
  assert.equal(cancelled, true);
  assert.equal(bodyCancelled, true, 'an uncooperative body reader is cancelled, not left alive');
  const large = createRpcClient({ maxResponseBytes: 20, fetchImpl: async () => new Response('x'.repeat(21)) });
  await assert.rejects(large('eth_chainId', []), /rpc_body_limit/);
});

test('timeout cancelling a stalled body after valid JSON cannot certify a successful EOF', async () => {
  let cancelled = false;
  const rpc = createRpcClient({ attempts: 1, urls: ['https://fixture.invalid'], requestTimeoutMs: 15, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2105' }))); },
    cancel() { cancelled = true; },
  })) });
  await assert.rejects(rpc('eth_chainId', []), /rpc_timeout/);
  assert.equal(cancelled, true);
});

test('late response from noncooperative fetch is cancelled after the RPC timed out', async () => {
  let returnResponse;
  let reportCancellation;
  const cancellation = new Promise(resolve => { reportCancellation = resolve; });
  const rpc = createRpcClient({ attempts: 1, urls: ['https://fixture.invalid'], requestTimeoutMs: 15, fetchImpl: () => new Promise(resolve => { returnResponse = resolve; }) });
  await assert.rejects(rpc('eth_chainId', []), /rpc_timeout/);
  returnResponse(new Response(new ReadableStream({ cancel() { reportCancellation(true); } })));
  let timer;
  try {
    assert.equal(await Promise.race([cancellation, new Promise(resolve => { timer = setTimeout(() => resolve(false), 100); })]), true);
  } finally { clearTimeout(timer); }
});

test('pinned RPC endpoints never follow redirects', async () => {
  const rpc = createRpcClient({ attempts: 1, urls: ['https://fixture.invalid'], fetchImpl: async (_url, init) => {
    assert.equal(init.redirect, 'error');
    return Response.json({ jsonrpc: '2.0', id: 1, result: '0x2105' });
  } });
  assert.equal((await rpc('eth_chainId', [])).result, '0x2105');
});

test('report validator rejects exit-zero fake success, missing range and fabricated revenue', async () => {
  const good = await scan(chain());
  for (const report of [null, {}, { ok: true }, { ...good, scan_complete: false }, { ...good, transfers: null }, { ...good, total_raw: '1' }, { ...good, last_scanned_block: 4 }, { ...good, recognized_customer_revenue_usdc: 1 }]) {
    assert.equal(validateTreasuryReport(report).ok, false);
  }
});

test('report gate rejects type-coerced ranges, inconsistent display totals and invented finality', async () => {
  const good = await scan(chain({ logs: [transfer(3)] }));
  for (const changed of [
    { start_block: true }, { origin_block: '1' }, { latest_block: good.latest_block + 1 },
    { checked_at: 'not a timestamp' }, { all_time_reconciled: true }, { finality_verified: true },
    { known_non_customer_usdc_decimal: '999.000000' }, { total_usdc: 123 },
    { checkpoint_write_status: 'unknown_readback_required' },
    { transfers: [{ ...good.transfers[0], usdc_decimal: '999.000000' }] },
  ]) assert.equal(validateTreasuryReport({ ...good, ...changed }).ok, false, JSON.stringify(changed));
});

test('corrupt persisted integer and receipt display fields cannot become checkpoint authority', async () => {
  const seed = memoryStore();
  await scan(chain({ logs: [transfer(3)] }), { checkpointStore: seed });
  for (const change of [
    state => { state.origin_block = true; },
    state => { state.confirmation_depth = 0; },
    state => { state.checked_at = 'invalid'; },
    state => { state.transfers[0].block_number = '3'; },
    state => { state.transfers[0].usdc_decimal = '1000.000000'; },
  ]) {
    const stored = structuredClone(seed.snapshots.at(-1)); change(stored.state);
    let writes = 0;
    const store = { async read() { return stored; }, async compareAndSwap() { writes++; throw Error('must not publish'); } };
    const report = await scan(chain(), { checkpointStore: store });
    assert.equal(report.ok, false);
    assert.equal(report.total_raw, null);
    assert.equal(writes, 0);
  }
});

test('existing final failure gate and always-upload survive the semantic gate addition', async () => {
  const workflow = await readFile(new URL('../.github/workflows/discovery-pulse.yml', import.meta.url), 'utf8');
  assert.match(workflow, /id: treasury_evidence/);
  assert.match(workflow, /steps\.treasury\.outcome != 'success' \|\| steps\.treasury_evidence\.outcome != 'success'/);
  assert.match(workflow, /Upload canonical pulse evidence\s+if: always\(\)/);
  assert.ok(workflow.indexOf('Upload canonical pulse evidence') < workflow.indexOf('Fail pulse visibly'));
  assert.match(workflow, /No purchase or customer revenue is generated/);
});

test('forty isolated restarts preserve receipt identity and bounded overlap work', async () => {
  const store = memoryStore();
  const receipt = transfer(3);
  for (let run = 0; run < 40; run++) {
    const fixture = chain({ head: 11 + run, logs: [receipt] });
    const report = await scan(fixture, { checkpointStore: store });
    assert.equal(report.ok, true);
    assert.equal(report.total_raw, '1000000');
    assert.equal(report.transfers.length, 1);
    assert.ok(fixture.requests.filter(r => r.method === 'eth_getLogs').length <= 3);
    assert.equal(report.recognized_customer_revenue_usdc, null);
  }
});
