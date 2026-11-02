import assert from 'node:assert/strict';
import { createRpcClient, reconcileTreasury, failure, USDC, TRANSFER_TOPIC, TO_TOPIC } from '../scripts/treasury-reconciliation.mjs';
import { runTreasuryCli } from '../scripts/reconcile-treasury.mjs';
import { validateTreasuryReport } from '../scripts/validate-treasury-report.mjs';
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');

const hex = n => `0x${n.toString(16)}`;
const hash = n => `0x${BigInt(n + 1000).toString(16).padStart(64, '0')}`;
const block = n => ({ number: hex(n), hash: hash(n), parentHash: hash(Math.max(0, n - 1)) });
const transfer = { address: USDC, transactionHash: hash(100000), blockHash: hash(2), blockNumber: '0x2', logIndex: '0x0', removed: false,
  topics: [TRANSFER_TOPIC, `0x${'1'.repeat(40).padStart(64, '0')}`, TO_TOPIC], data: `0x${(1000000n).toString(16).padStart(64, '0')}` };
function fixture({ source = method => method === 'eth_getLogs' ? 'https://logs.invalid/private-key?secret=NO_LEAK' : 'https://user:password@headers.invalid/api-key', finalized = block(4), failFrom = null } = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    const url = source?.(method);
    if (method === 'eth_chainId') return { result: '0x2105', url };
    if (method === 'eth_blockNumber') return { result: hex(16), url };
    if (method === 'eth_getBlockByNumber') return { result: params[0] === 'finalized' ? await (typeof finalized === 'function' ? finalized() : finalized) : block(Number(BigInt(params[0]))), url };
    if (method === 'eth_getLogs') {
      const from = Number(BigInt(params[0].fromBlock)), through = Number(BigInt(params[0].toBlock));
      if (failFrom !== null && from >= failFrom) throw failure('fixture_outage');
      return { result: from <= 2 && through >= 2 ? [transfer] : [], url };
    }
    throw Error('unexpected fixture method');
  };
  return { rpc, calls };
}
const scan = (f, more = {}) => reconcileTreasury({ rpc: f.rpc, initialBlock: 1, confirmations: 12, chunkBlocks: 2, ...more });
function store() {
  const revisions = [];
  return { revisions, read: async () => structuredClone(revisions.at(-1) ?? null), compareAndSwap: async (version, state) => {
    assert.equal(version, revisions.at(-1)?.version ?? null);
    const next = { version: (version ?? 0) + 1, state: structuredClone(state) };
    revisions.push(next); return structuredClone(next);
  } };
}

test('Treasury records each completed log and header source without URL credentials or API paths', async () => {
  const report = await scan(fixture());
  assert.equal(report.ok, true);
  assert.deepEqual(report.rpc_sources.sort(), ['https://headers.invalid', 'https://logs.invalid']);
  assert.equal(report.rpc_source_missing, false);
  assert.equal(report.rpc_coverage.length, 2);
  assert.deepEqual(report.rpc_coverage.map(x => [x.from_block, x.through_block]), [[1, 2], [3, 4]]);
  for (const row of report.rpc_coverage) {
    assert.equal(row.status, 'complete'); assert.equal(row.canonical_logs_verified, true);
    assert.equal(row.log_source, 'https://logs.invalid');
    assert.deepEqual(row.header_sources, ['https://headers.invalid']);
    assert.equal(row.header_source_missing, false); assert.equal(row.checkpoint_committed, false);
  }
  assert.doesNotMatch(JSON.stringify(report), /NO_LEAK|private-key|password|api-key/);
  assert.equal(validateTreasuryReport(report).ok, true);
});

test('Treasury source-less injected clients stay explicitly unknown without invented node health', async () => {
  const report = await scan(fixture({ source: null }));
  assert.equal(report.ok, true); assert.equal(report.total_raw, '1000000');
  assert.equal(report.rpc_source_missing, true); assert.deepEqual(report.rpc_sources, []);
  assert.equal(report.rpc_observability, null);
  for (const row of report.rpc_coverage) {
    assert.equal(row.log_source, null); assert.deepEqual(row.header_sources, []); assert.equal(row.header_source_missing, true);
  }
});

test('Treasury failed interval preserves partial source evidence and original checkpoint, never a zero total', async () => {
  const checkpointStore = store();
  const report = await scan(fixture({ failFrom: 3 }), { checkpointStore, overlapBlocks: 1 });
  assert.equal(report.ok, false); assert.equal(report.total_raw, null); assert.equal(report.treasury_received_candidates, null);
  assert.equal(report.checkpoint_after, 2); assert.equal(checkpointStore.revisions.length, 1);
  assert.equal(report.rpc_coverage[0].checkpoint_committed, true);
  assert.equal(report.rpc_coverage[1].status, 'incomplete'); assert.equal(report.rpc_coverage[1].log_source, null);
  assert.equal(report.rpc_coverage[1].canonical_logs_verified, false);
  assert.equal(checkpointStore.revisions[0].state.transfers[0].raw_amount, '1000000');
  assert.equal(Object.hasOwn(checkpointStore.revisions[0].state, 'rpc_coverage'), false);
});

test('Treasury healthy fallback records run-only failures and successful selection without leaking configured URLs', async () => {
  const events = [];
  const rpc = createRpcClient({ urls: ['https://primary.invalid/key-SECRET', 'https://u:p@fallback.invalid/?key=SECRET'], attempts: 1,
    log: e => events.push(e), fetchImpl: async (url, init) => {
      if (url.includes('primary')) return new Response('private upstream body', { status: 503 });
      const method = JSON.parse(init.body).method;
      return Response.json({ jsonrpc: '2.0', id: 1, result: method === 'eth_chainId' ? '0x2105' : '0x10' });
    } });
  await rpc('eth_blockNumber', []);
  const first = rpc.getObservability();
  assert.equal(first.persisted, false); assert.equal(first.scope, 'this_rpc_client_instance_only');
  assert.equal(first.failovers, 1); assert.equal(first.preferred_provider, 1);
  assert.equal(first.providers[0].failed_attempts, 1); assert.equal(first.providers[1].successful_calls, 1);
  assert.equal(first.providers[0].last_failure_category, 'rpc_http_error');
  await rpc('eth_blockNumber', []);
  assert.equal(rpc.getObservability().providers[1].successful_calls, 2);
  assert.equal(first.providers[1].successful_calls, 1, 'published snapshots never change on later calls');
  assert.equal(events.filter(e => e.event === 'treasury_rpc_fallback_selected').length, 1);
  assert.doesNotMatch(JSON.stringify({ first, events }), /SECRET|u:p|private upstream body/);
});

test('Treasury report includes a detached client health snapshot after transient fallback', async () => {
  const f = fixture({ source: () => 'https://fallback.invalid' });
  const rpc = createRpcClient({ urls: ['https://primary.invalid', 'https://fallback.invalid'], attempts: 1, fetchImpl: async (url, init) => {
    if (url.includes('primary')) return new Response('', { status: 429 });
    const request = JSON.parse(init.body); const answer = await f.rpc(request.method, request.params);
    return Response.json({ jsonrpc: '2.0', id: 1, result: answer.result });
  } });
  const report = await scan({ rpc });
  assert.equal(report.ok, true); assert.equal(report.rpc_observability.failovers, 1);
  assert.equal(report.rpc_observability.providers[0].last_failure_category, 'rate_limited');
  assert.equal(report.total_raw, '1000000'); assert.equal(report.recognized_customer_revenue_usdc, null);
});

test('Treasury finalized observation is opt-in and cannot change twelve-confirmation coverage', async () => {
  const f = fixture(); const report = await scan(f);
  assert.equal(report.finality_observation.status, 'not_requested'); assert.equal(report.finality_verified, false);
  assert.equal(f.calls.some(c => c.params[0] === 'finalized'), false);
  assert.equal(report.confirmation_depth, 12); assert.equal(report.requested_through_block, 4);
});

test('Treasury provider finalized metadata remains diagnostic even when its number covers the scan', async () => {
  const report = await scan(fixture(), { observeFinalized: true });
  assert.equal(report.ok, true); assert.equal(report.finality_observation.status, 'observed');
  assert.equal(report.finality_observation.block_number, 4); assert.equal(report.finality_observation.block_hash, hash(4));
  assert.equal(report.finality_observation.source, 'https://headers.invalid');
  assert.equal(report.finality_observation.scan_through_at_or_below_observed_finalized_number, true);
  assert.equal(report.finality_verified, false); assert.equal(report.all_time_reconciled, false);
  assert.equal(report.recognized_customer_revenue_usdc, null); assert.equal(validateTreasuryReport(report).ok, true);
});

test('Treasury malformed or lagging finalized tags do not erase complete receipt coverage or imply finality', async () => {
  for (const finalized of [null, { ...block(4), hash: 'invalid' }, block(2)]) {
    const report = await scan(fixture({ finalized }), { observeFinalized: true });
    assert.equal(report.ok, true); assert.equal(report.total_raw, '1000000'); assert.equal(report.finality_verified, false);
    if (finalized?.number === '0x2') {
      assert.equal(report.finality_observation.status, 'observed');
      assert.equal(report.finality_observation.scan_through_at_or_below_observed_finalized_number, false);
    } else assert.equal(report.finality_observation.status, 'unavailable');
  }
});

test('Treasury late finalized response after diagnostic deadline cannot mutate report or checkpoint', async () => {
  let release; const held = new Promise(resolve => { release = resolve; }); const checkpointStore = store();
  const report = await scan(fixture({ finalized: () => held }), { observeFinalized: true, finalityObservationTimeoutMs: 5, checkpointStore });
  assert.equal(report.ok, true); assert.equal(report.total_raw, '1000000');
  assert.equal(report.finality_observation.status, 'unavailable'); assert.equal(report.finality_observation.category, 'rpc_timeout');
  const original = JSON.stringify({ report, revisions: checkpointStore.revisions });
  release(block(4)); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(JSON.stringify({ report, revisions: checkpointStore.revisions }), original);
});

test('Treasury diagnostic enablement preserves byte-identical financial checkpoint snapshots', async () => {
  const a = store(), b = store();
  const before = await scan(fixture(), { checkpointStore: a, now: () => 1700000000000 });
  const after = await runTreasuryCli({ DELTA_TREASURY_START_BLOCK: '1', DELTA_TREASURY_CHUNK_BLOCKS: '2', DELTA_TREASURY_STATE_DIRECTORY: 'fixture-only', DELTA_TREASURY_OBSERVE_FINALIZED: '1' },
    { rpc: fixture().rpc, checkpointStore: b, log: () => {} });
  // CLI uses wall-clock checked_at; compare every financial field without
  // fabricating identical observation times. Direct variants must be byte equal.
  assert.equal(after.finality_observation.status, 'observed'); assert.equal(after.confirmation_depth, 12);
  const c = store();
  await scan(fixture(), { checkpointStore: c, now: () => 1700000000000, observeFinalized: true });
  assert.equal(JSON.stringify(a.revisions), JSON.stringify(c.revisions));
  assert.equal(before.total_raw, after.total_raw); assert.equal(after.total_raw, '1000000');
});
