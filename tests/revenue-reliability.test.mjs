import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const {test} = process.env.VITEST ? await import('vitest') : await import('node:test');

const root = process.env.DELTA_TEST_SOURCE_DIR || fileURLToPath(new URL('../', import.meta.url));
const address = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const treasury = '0x1990e21bc219696ff7fbc26527dbaed335ac6367';
const tx = `0x${'ab'.repeat(32)}`;
const log = {
  address, transactionHash: tx, blockHash: `0x${'cd'.repeat(32)}`,
  blockNumber: '0x5', logIndex: '0xa', removed: false,
  topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${'1'.repeat(40).padStart(64, '0')}`, `0x${treasury.slice(2).padStart(64, '0')}`],
  data: `0x${(1000000).toString(16).padStart(64, '0')}`,
};

function run(script, fixture = {}, env = {}) {
  const code = `
    const fixture = ${JSON.stringify(fixture)};
    let calls = 0;
    let logCalls = 0;
    console.table = rows => console.log('MOCK_TABLE=' + JSON.stringify(rows));
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => { if (ms <= 1400) { queueMicrotask(fn); return 0; } return realTimeout(fn, ms, ...args); };
    globalThis.fetch = async (_url, options) => {
      calls++;
      const request = JSON.parse(options.body);
      let body;
      if (request.method) {
        let result;
        if (request.method === 'eth_chainId') result = '0x2105';
        else if (request.method === 'eth_blockNumber') result = fixture.head ?? '0x6';
        else if (request.method === 'eth_getBlockByNumber') result = {number: request.params[0], hash: '0x' + 'cd'.repeat(32), parentHash: '0x' + 'cd'.repeat(32)};
        else {
          logCalls++;
          if (fixture.failLogsFrom !== undefined && Number(BigInt(request.params[0].fromBlock)) >= fixture.failLogsFrom) return new Response('fixture unavailable', {status: 503});
          result = Object.hasOwn(fixture, 'logs') ? fixture.logs : [];
        }
        body = fixture.rpcEnvelope ?? {jsonrpc: '2.0', id: 1, result};
      } else {
        body = fixture.d1 ?? {success: true, result: [{success: true, results: []}]};
        if (fixture.sqlRows) {
          const {DatabaseSync} = await import('node:sqlite');
          const db = new DatabaseSync(':memory:');
          db.exec("CREATE TABLE telemetry_events (channel TEXT, event TEXT, success TEXT, event_count INTEGER, gross_usd REAL, variable_cost_usd REAL, contribution_margin_usd REAL, browser_ms REAL, storage_bytes REAL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
          const {readFileSync} = await import('node:fs');
          db.exec(readFileSync(${JSON.stringify(resolve(root, 'migrations/0002_metric_provenance.sql'))}, 'utf8'));
          for (const row of fixture.sqlRows) db.prepare('INSERT INTO telemetry_events (channel, event, success, event_count, gross_usd, variable_cost_usd, contribution_margin_usd, browser_ms, storage_bytes) VALUES (?,?,?,?,?,?,?,?,?)').run(...row);
          body = {success: true, result: [{success: true, results: db.prepare(request.sql).all()}]};
          db.close();
        }
      }
      if (fixture.assertTimeout && !options.signal) throw new Error('missing request timeout');
      if (fixture.networkError) throw new TypeError('fetch failed', {cause: new Error('token=SHOULD_NOT_LEAK')});
      if (fixture.unknownError) throw new Error('SHOULD_NOT_LEAK unknown cause');
      return new Response(fixture.rawBody ?? JSON.stringify(body), {status: fixture.statusAfter && calls >= fixture.statusAfter ? (fixture.status ?? 503) : fixture.statusAfter ? 200 : (fixture.status ?? 200)});
    };
    process.on('exit', () => { console.error('MOCK_CALLS=' + calls); console.error('MOCK_LOG_CALLS=' + logCalls); });
    process.argv[1] = ${JSON.stringify(resolve(root, 'scripts', script))};
    await import(${JSON.stringify(pathToFileURL(resolve(root, 'scripts', script)).href)});
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', timeout: 10000,
    env: {...process.env, CLOUDFLARE_ACCOUNT_ID: 'offline', CLOUDFLARE_API_TOKEN: 'offline', GITHUB_STEP_SUMMARY: '', DELTA_TREASURY_LOOKBACK_BLOCKS: '5', DELTA_TREASURY_CHUNK_BLOCKS: '5', DELTA_TREASURY_CHECKPOINT_BLOCK: '', DELTA_TREASURY_START_BLOCK: '', DELTA_TREASURY_STATE_DIRECTORY: '', DELTA_TREASURY_CONFIRMATIONS: '1', ...env},
  });
  assert.ifError(result.error);
  return {...result, calls: Number(result.stderr.match(/MOCK_CALLS=(\d+)/)?.[1]), logCalls: Number(result.stderr.match(/MOCK_LOG_CALLS=(\d+)/)?.[1])};
}

test('Treasury malformed head never becomes a successful zero receipt scan', () => {
  const result = run('reconcile-treasury.mjs', {head: 'invalid'});
  assert.notEqual(result.status, 0, result.stdout);
});
test('Treasury malformed log response never becomes an empty successful scan', () => {
  const result = run('reconcile-treasury.mjs', {logs: ''});
  assert.notEqual(result.status, 0, result.stdout);
});
test('Treasury refuses zero lookback without making an RPC request', () => {
  const result = run('reconcile-treasury.mjs', {}, {DELTA_TREASURY_LOOKBACK_BLOCKS: '0'});
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.calls, 0);
});
test('Treasury deduplicates normalized settlement/log identities', () => {
  const duplicate = {...log, transactionHash: '0x' + tx.slice(2).toUpperCase(), logIndex: '0xA'};
  const result = run('reconcile-treasury.mjs', {logs: [log, duplicate]});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).treasury_received_candidates, 1);
});
test('Treasury rejects inconsistent duplicate settlement evidence', () => {
  const result = run('reconcile-treasury.mjs', {logs: [log, {...log, data: `0x${'0'.repeat(63)}1`}]});
  assert.notEqual(result.status, 0, result.stdout);
});
test('Treasury rejects removed or off-filter logs', () => {
  for (const bad of [{...log, removed: true}, {...log, address: treasury}, {...log, blockNumber: '0x6'}]) {
    const result = run('reconcile-treasury.mjs', {logs: [bad]});
    assert.notEqual(result.status, 0, result.stdout);
  }
});
test('Treasury resumes a supplied checkpoint beyond the rolling lookback gap', () => {
  const result = run('reconcile-treasury.mjs', {head: '0x64'}, {DELTA_TREASURY_CHECKPOINT_BLOCK: '10'});
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.start_block, 10);
  assert.equal(report.scan_complete, true);
  assert.equal(report.last_scanned_block, 99, 'current head remains outside the configured confirmation boundary');
  assert.equal(report.all_time_reconciled, false);
});
test('Treasury 403 is classified, redacted, and never retried', () => {
  const result = run('reconcile-treasury.mjs', {status: 403, rawBody: 'SHOULD_NOT_LEAK safety denied'});
  assert.notEqual(result.status, 0);
  assert.equal(result.calls, 1);
  assert.doesNotMatch(result.stderr + result.stdout, /SHOULD_NOT_LEAK/);
  assert.match(result.stderr + result.stdout, /http_forbidden/);
});
test('Treasury interrupted scan records exact partial coverage and unknown totals', () => {
  const result = run('reconcile-treasury.mjs', {failLogsFrom: 3}, {DELTA_TREASURY_CHUNK_BLOCKS: '2'});
  assert.notEqual(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scan_complete, false);
  assert.equal(report.last_scanned_block, 2);
  assert.equal(report.treasury_received_candidates, null);
  assert.equal(report.checkpoint_advanced, false);
  assert.equal(result.logCalls, 7, 'one completed chunk and six bounded failed log requests; provider chain/header validation is separately bounded');
});
test('Treasury network retries are bounded and raw error contents stay redacted', () => {
  const result = run('reconcile-treasury.mjs', {networkError: true});
  assert.notEqual(result.status, 0);
  assert.equal(result.calls, 6);
  assert.doesNotMatch(result.stdout + result.stderr, /SHOULD_NOT_LEAK/);
  assert.equal(JSON.parse(result.stdout).category, 'network_failure');
});
test('Funnel counts successful authorizations separately from paid/settled revenue', () => {
  const result = run('query-funnel.mjs', {sqlRows: [
    ['direct', 'partner_request', 'false', 1, 0, 0, 0, 0, 0],
    ['direct', 'payment_verified', 'true', 1, 1, 0, 0, 0, 0],
    ['direct', 'capture_completed', 'true', 1, 1, 0, 1, 100, 1],
  ]});
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout.match(/MOCK_TABLE=(.*)/)[1]);
  assert.equal(rows[0].payment_authorization_events, 1);
  assert.equal(rows[0].paid, undefined);
  assert.equal(rows[0].gross_revenue_usd, undefined);
  assert.equal(rows[0].telemetry_gross_usd, 1);
});

for (const script of ['query-revenue-candidates.mjs', 'query-funnel.mjs']) {
  test(`${script}: incomplete D1 results cannot become empty success`, () => {
    const result = run(script, {d1: {success: true, result: [{success: true}]}});
    assert.notEqual(result.status, 0, result.stdout);
  });
  test(`${script}: failed statements cannot become empty success`, () => {
    const result = run(script, {d1: {success: true, result: [{success: false, results: []}]}});
    assert.notEqual(result.status, 0, result.stdout);
  });
  test(`${script}: request has a finite timeout`, () => {
    const result = run(script, {assertTimeout: true});
    assert.equal(result.status, 0, result.stderr);
  });
  test(`${script}: denied response is redacted and never retried`, () => {
    const result = run(script, {status: 403, rawBody: 'SHOULD_NOT_LEAK'});
    assert.notEqual(result.status, 0);
    assert.equal(result.calls, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /SHOULD_NOT_LEAK/);
    assert.match(result.stdout + result.stderr, /http_forbidden/);
  });
  test(`${script}: telemetry is explicitly not reconciled revenue or actual costs`, () => {
    const result = run(script);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /recognized_customer_revenue_usdc[^\n]*null/);
    assert.match(result.stdout, /actual_variable_cost_usdc[^\n]*null/);
  });
  test(`${script}: transient read retries are limited to two attempts`, () => {
    for (const status of [429, 503]) {
      const result = run(script, {status});
      assert.notEqual(result.status, 0);
      assert.equal(result.calls, 2);
    }
  });
}

for (const script of ['reconcile-treasury.mjs', 'query-revenue-candidates.mjs', 'query-funnel.mjs']) {
  test(`${script}: unknown exception stays unknown and is not retried`, () => {
    const result = run(script, {unknownError: true});
    assert.notEqual(result.status, 0);
    assert.equal(result.calls, 1);
    assert.match(result.stdout + result.stderr, /"category":\s*"unknown"/);
    assert.doesNotMatch(result.stdout + result.stderr, /SHOULD_NOT_LEAK/);
  });
}
