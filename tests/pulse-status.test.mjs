import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPulseStatus, maintenanceDecision, scannerState, pulseGate, readBoundedJson, DAILY_SCHEDULE, HOURLY_SCHEDULE } from '../scripts/pulse-status.mjs';
import { reconcileTreasury } from '../scripts/treasury-reconciliation.mjs';
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('../scripts/pulse-status.mjs', import.meta.url));
const scannerNames = ['payan', 'agentexchange', 'agentpact', 'external', 'moltjobs', 'workpnp'];
const outcomeNames = ['core_source', 'core_prices', 'core_path', 'treasury', 'treasury_evidence', 'paid_funnel', 'operator_evidence', 'agentpact_raw',
  'report_status', 'report_final', 'canonical_artifact', 'status_artifact', ...scannerNames];
const q = n => `0x${n.toString(16)}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
async function fixture() {
  const treasury = await reconcileTreasury({ initialBlock: 1, confirmations: 1, chunkBlocks: 4, overlapBlocks: 2,
    rpc: async (method, params) => {
      if (method === 'eth_chainId') return { result: '0x2105' };
      if (method === 'eth_blockNumber') return { result: q(11) };
      if (method === 'eth_getLogs') return { result: [] };
      if (method === 'eth_getBlockByNumber') {
        const n = Number(BigInt(params[0])); return { result: { number: q(n), hash: hash(n), parentHash: hash(Math.max(n - 1, 0)) } };
      }
      throw Error('unexpected synthetic RPC method');
    } });
  assert.equal(treasury.ok, true);
  return { outcomes: Object.fromEntries(outcomeNames.map(key => [key, { outcome: 'success' }])),
    reports: { source: { ok: true }, prices: { ok: true }, health: { ok: true }, treasury,
      paid_funnel: { ok: true, scan_complete: true, candidate_rows: 0, rows: [] },
      ...Object.fromEntries(scannerNames.map(key => [key, { ok: true, discovery_status: 'present', http: 200 }])) },
    run: { id: '1234', attempt: '1', sha: 'a'.repeat(40), event: 'schedule', schedule: HOURLY_SCHEDULE,
      started_at: '2026-11-03T00:00:00.000Z' }, now: '2026-11-03T00:00:10.000Z', phase: 'final' };
}

test('daily maintenance follows original cron even when Runner starts hours late, manual and push remain read only', () => {
  assert.equal(maintenanceDecision('schedule', DAILY_SCHEDULE, 'true').run, true);
  for (const event of ['push', 'workflow_dispatch', 'unknown']) assert.equal(maintenanceDecision(event, DAILY_SCHEDULE, 'true').run, false);
  assert.equal(maintenanceDecision('schedule', HOURLY_SCHEDULE, 'true').run, false);
  assert.equal(maintenanceDecision('schedule', '21 * * * *', 'true').run, false);
  const missing = maintenanceDecision('schedule', DAILY_SCHEDULE, undefined);
  assert.equal(missing.run, false); assert.equal(missing.due, true);
  assert.equal(missing.decision, 'authorization_migration_required');
  assert.equal(missing.catchup_guaranteed, false); assert.equal(missing.durable_due_checkpoint, 'not_configured');
});

test('core failure does not erase independently valid Treasury or scanner evidence', async () => {
  const f = await fixture(); f.outcomes.core_prices = { outcome: 'failure' };
  const status = buildPulseStatus(f);
  assert.equal(status.critical_ok, false); assert.equal(status.outcome, 'failed');
  assert.equal(status.treasury.state, 'verified_declared_interval');
  assert.equal(status.scanners.payan.state, 'checked'); assert.equal(pulseGate(status, f.outcomes), false);
});

test('exit zero and continue-on-error cannot promote malformed Treasury evidence or failed outcome', async () => {
  const f = await fixture();
  for (const treasury of [null, {}, { ...f.reports.treasury, total_raw: '1' }, { ...f.reports.treasury, coverage_gap: { from: 1 } }]) {
    const status = buildPulseStatus({ ...f, reports: { ...f.reports, treasury } });
    assert.equal(status.treasury.state, 'unverified'); assert.equal(status.critical_ok, false);
    assert.equal(status.treasury.start_block, null);
  }
  f.outcomes.treasury = { outcome: 'failure', conclusion: 'success' };
  assert.equal(buildPulseStatus(f).treasury.state, 'unverified');
});

test('window receipts retain their narrow scope, never revenue, invoice cost, margin or all-time zero', async () => {
  const f = await fixture(), status = buildPulseStatus(f);
  assert.equal(status.critical_ok, true); assert.equal(status.outcome, 'success');
  assert.equal(status.treasury.coverage, 'complete_window_only_persistence_rollout_pending');
  assert.equal(status.treasury.start_block, 1); assert.equal(status.treasury.through_block, 10);
  for (const field of ['recognized_customer_revenue_usdc', 'actual_variable_cost_usdc', 'actual_contribution_margin_usdc']) assert.equal(status.treasury[field], null);
  assert.equal(Object.hasOwn(status.treasury, 'total_usdc'), false);
  assert.equal(status.scheduler.historical_coverage, 'unverified'); assert.equal(status.reporting.notification, 'unknown');
});

test('green scanner processes with provider degradation and inconsistent boards remain degraded', async () => {
  for (const report of [
    { ok: true, discovery_status: 'degraded_recoverable', http: 502 },
    { ok: true, discovery_status: 'present', board_count_consistent: false, http: 200 },
    { ok: true, results: [{ discovery_status: 'present', http: 200 }, { discovery_status: 'degraded_recoverable', http: null }] },
  ]) assert.equal(scannerState('success', report).state, 'degraded');
  const f = await fixture(); f.reports.payan.discovery_status = 'degraded_recoverable';
  assert.equal(buildPulseStatus(f).outcome, 'degraded');
  assert.equal(buildPulseStatus(f).critical_ok, true);
});

test('missing scanner output is unknown and failed, cancelled or skipped execution never becomes checked', () => {
  for (const report of [null, {}, { ok: true }, { ok: true, results: [] }, { ok: true, results: [{ discovery_status: 'guessed' }] }]) assert.equal(scannerState('success', report).state, 'unknown');
  for (const execution of ['failure', 'cancelled', 'skipped']) assert.notEqual(scannerState(execution, { ok: true, discovery_status: 'present' }).state, 'checked');
});

test('missing operator export or supplemental buyer readback makes diagnostic outcome degraded', async () => {
  const f = await fixture();
  for (const key of ['operator_evidence', 'agentpact_raw']) {
    const status = buildPulseStatus({ ...f, outcomes: { ...f.outcomes, [key]: { outcome: 'failure' } } });
    assert.equal(status.outcome, 'degraded'); assert.equal(status.critical_ok, true);
    assert.equal(key === 'operator_evidence' ? status.operator_evidence.execution : status.supplemental_evidence.agentpact_raw.execution, 'failure');
  }
});

test('planned discovery uses provider payload rather than a successful process and unplanned skip is quiet', async () => {
  const f = await fixture(); f.run.schedule = DAILY_SCHEDULE; f.maintenanceEnabled = 'true';
  f.outcomes.discovery_channels = { outcome: 'success' };
  const report = { schema: 'delta-discovery-observation/v1', x402_list: 'present', circle: 'present', payapi: 'present',
    scope: 'keyword_observation_only_not_registration_or_business_success' };
  const status = body => buildPulseStatus({ ...f, reports: { ...f.reports, discovery_channels: body } });
  assert.equal(status(report).outcome, 'success');
  for (const observation of ['degraded', 'not_observed']) {
    const result = status({ ...report, x402_list: observation, circle: observation, payapi: observation });
    assert.equal(result.outcome, 'degraded'); assert.equal(result.critical_ok, true);
    assert.equal(result.maintenance.discovery_observation.state, observation);
    assert.equal(result.maintenance.discovery_observation.sources.circle, observation);
  }
  for (const body of [null, {}, { ...report, schema: 'wrong' }, { ...report, scope: 'registration_verified' }, { ...report, circle: 'untrusted-provider-text' }]) {
    const result = status(body);
    assert.equal(result.outcome, 'degraded'); assert.equal(result.maintenance.discovery_observation.state, 'unknown');
    assert.equal(result.maintenance.discovery_observation.sources, null);
  }
  f.run.schedule = HOURLY_SCHEDULE; f.outcomes.discovery_channels = { outcome: 'skipped' };
  const unplanned = status(null);
  assert.equal(unplanned.outcome, 'success'); assert.equal(unplanned.maintenance.discovery_observation.state, 'not_planned');
});

test('paid funnel diagnostic requires declared complete evidence, never infers candidate delivery or payment', async () => {
  const f = await fixture();
  for (const paid of [{ ok: true }, { ok: true, scan_complete: true, candidate_rows: 1, rows: [] }, { ok: true, scan_complete: false, candidate_rows: 0, rows: [] }]) {
    const status = buildPulseStatus({ ...f, reports: { ...f.reports, paid_funnel: paid } });
    assert.equal(status.paid_funnel.state, 'unknown'); assert.equal(status.critical_ok, false);
  }
});

test('allowlisted diagnostics cannot copy arbitrary raw rows, provider errors or credential-like values', async () => {
  const f = await fixture(), secret = 'synthetic-secret-must-not-appear';
  f.reports.payan.error = secret; f.reports.payan.rows = [{ token: secret }];
  f.reports.source.errors = [secret]; f.reports.health.authorization = secret;
  f.outcomes.core_source.credential = secret; f.run.sha = secret; f.run.id = secret;
  const status = buildPulseStatus(f);
  assert.equal(JSON.stringify(status).includes(secret), false);
  assert.equal(status.run.source_sha, null); assert.equal(status.run.id, null);
});

test('observational run identity and times do not pretend scheduler provenance, whole-job completion or historical success', async () => {
  const f = await fixture(), status = buildPulseStatus(f);
  assert.equal(status.task_id, 'delta-discovery-pulse'); assert.equal(status.run_id, '1234');
  assert.equal(status.source, 'github_actions'); assert.equal(status.source_status, 'recorded_runner_observation');
  assert.equal(status.scheduled_at, null); assert.equal(status.last_success_at, null); assert.equal(status.duration_ms, 10000);
  assert.match(status.execution_scope, /excludes_final_upload_and_gates/);
  const pending = buildPulseStatus({ ...f, phase: 'prepared' });
  assert.equal(pending.completed_at, null); assert.equal(pending.duration_ms, null); assert.equal(pending.outcome, 'unknown');
  assert.equal(buildPulseStatus({ ...f, run: { ...f.run, started_at: 'invalid' } }).duration_ms, null);
});

test('reporting gate requires actual upload and both report outcomes, never self-attests notification delivery', async () => {
  const f = await fixture(), status = buildPulseStatus(f);
  assert.equal(pulseGate(status, f.outcomes), true);
  for (const key of ['report_status', 'report_final', 'canonical_artifact', 'status_artifact']) {
    const outcomes = { ...f.outcomes, [key]: { outcome: 'failure', conclusion: 'success' } };
    assert.equal(pulseGate(status, outcomes), false, key);
  }
  assert.equal(pulseGate(buildPulseStatus({ ...f, phase: 'prepared' }), f.outcomes), false);
  assert.equal(pulseGate(null, f.outcomes), false);
});

test('bounded local report reader rejects missing, malformed, oversized and invalid UTF-8 output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'delta-pulse-reader-'));
  for (const [name, bytes] of [['bad', '{'], ['large', '{}'.repeat(20)], ['utf8', Buffer.from([0xff])], ['empty', '']]) await writeFile(join(dir, name), bytes, { flag: 'wx' });
  await writeFile(join(dir, 'valid'), '{"ok":true}', { flag: 'wx' });
  assert.deepEqual(await readBoundedJson(join(dir, 'valid'), 20), { ok: true });
  for (const name of ['missing', 'bad', 'large', 'utf8', 'empty']) assert.equal(await readBoundedJson(join(dir, name), 20), null);
  assert.equal(await readBoundedJson(join(dir, 'valid'), Infinity), null);
  assert.equal(await readBoundedJson(join(dir, 'valid'), 0), null);
});

test('CLI preserves create-only status and gate fails closed on missing reports without network', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'delta-pulse-cli-'));
  const env = { ...process.env, GITHUB_STEP_SUMMARY: '', DELTA_STEP_OUTCOMES: '{}', GITHUB_RUN_ID: '1234' };
  const first = spawnSync(process.execPath, [script, dir, 'final'], { encoding: 'utf8', timeout: 10000, env });
  assert.equal(first.status, 0, first.stderr);
  const before = await readFile(join(dir, 'delta-pulse-status-final.json'), 'utf8');
  assert.equal(JSON.parse(before).critical_ok, false);
  const second = spawnSync(process.execPath, [script, dir, 'final'], { encoding: 'utf8', timeout: 10000, env });
  assert.equal(second.status, 1); assert.equal(await readFile(join(dir, 'delta-pulse-status-final.json'), 'utf8'), before);
  assert.equal(spawnSync(process.execPath, [script, 'gate', dir], { encoding: 'utf8', timeout: 10000, env }).status, 1);
});

test('workflow keeps single Pulse, independent cancellation fences, semantic gate and failure artifacts', async () => {
  const source = await readFile(join(root, '.github/workflows/discovery-pulse.yml'), 'utf8');
  const chunks = source.split(/    steps:\r?\n/)[1].split(/(?:^|\r?\n)      - /).slice(1);
  const byId = id => chunks.find(block => new RegExp(`\\bid: ${id}(?:\\s|$)`).test(block));
  for (const id of ['core_source', 'core_prices', 'core_path', 'treasury', 'treasury_evidence', 'paid_funnel', ...scannerNames]) {
    assert.match(byId(id), /if: \$\{\{ !cancelled\(\) \}\}/, id);
    assert.match(byId(id), /continue-on-error: true/, id);
  }
  for (const id of ['report_status', 'canonical_artifact', 'report_final', 'status_artifact']) assert.match(byId(id), /if: always\(\)/, id);
  assert.match(source, /steps\.treasury\.outcome != 'success' \|\| steps\.treasury_evidence\.outcome != 'success'/);
  assert.match(source, /node scripts\/validate-treasury-report\.mjs/);
  assert.match(source, /node scripts\/pulse-status\.mjs gate/);
  assert.equal((source.match(/delta-canonical-revenue-pulse/g) || []).length, 1);
  assert.doesNotMatch(source, /date -u \+%H/);
  assert.match(source, /cron: '21 0-2,4-23 \* \* \*'/); assert.match(source, /cron: '21 3 \* \* \*'/);
  for (const id of ['x402_discovery', 'agent402', 'payan_listings', 'allmcps', 'indexnow_core', 'indexnow_base_app', 'true402', 'nohumans']) {
    assert.match(byId(id), /!cancelled\(\) && steps\.maintenance\.outputs\.run == 'true'/, id);
    assert.match(byId(id), /steps\.core_path\.outcome == 'success'/, id);
  }
  assert.match(source, /DELTA_DAILY_MAINTENANCE_ENABLED: \$\{\{ vars\.DELTA_DAILY_MAINTENANCE_ENABLED \}\}/);
});

test('workflow pipefail and bounded step budgets preserve at least five minutes beyond all step deadlines', async () => {
  const source = await readFile(join(root, '.github/workflows/discovery-pulse.yml'), 'utf8');
  const steps = source.split(/    steps:\r?\n/)[1].split(/(?:^|\r?\n)      - /).slice(1);
  const jobBudget = Number(source.match(/^    timeout-minutes: (\d+)/m)[1]);
  const budgets = steps.map(block => Number(block.match(/^        timeout-minutes: (\d+)/m)?.[1]));
  assert.equal(budgets.every(n => Number.isInteger(n) && n >= 1 && n <= 5), true);
  assert.ok(jobBudget >= budgets.reduce((sum, n) => sum + n, 0) + 5);
  assert.match(source, /defaults:\s+run:\s+shell: bash --noprofile --norc -euo pipefail \{0\}/);
  assert.doesNotMatch(source, /shell: bash\s*\r?\n/);
  assert.ok(source.indexOf('Upload canonical pulse evidence') < source.indexOf('Fail pulse visibly'));
});

test('three discovery GETs fit their two-minute lane and preserve degraded or unobserved evidence', async () => {
  const source = await readFile(join(root, '.github/workflows/discovery-pulse.yml'), 'utf8');
  const block = source.split(/\r?\n      - /).find(x => /id: discovery_channels\b/.test(x));
  const options = block.match(/curl -fsS ([^\r\n]+)/)[1];
  const number = option => Number(options.match(new RegExp(`--${option} (\\d+)`))[1]);
  const attempts = number('retry') + 1;
  const requests = (block.match(/if fetch_bounded /g) || []).length;
  const networkSeconds = requests * (attempts * number('max-time') + number('retry') * number('retry-delay'));
  assert.equal(requests, 3); assert.equal(networkSeconds, 75);
  assert.ok(networkSeconds <= Number(block.match(/timeout-minutes: (\d+)/)[1]) * 60 - 30);
  assert.match(block, /timeout --signal=TERM --kill-after=1s 26s curl/);
  assert.ok(requests * (26 + 1) <= Number(block.match(/timeout-minutes: (\d+)/)[1]) * 60 - 30);
  assert.equal(number('retry-max-time'), 25);
  assert.match(block, /X402_LIST=degraded/); assert.match(block, /CIRCLE=degraded/); assert.match(block, /PAYAPI=degraded/);
  assert.doesNotMatch(block, /=absent|set \+e/);
  assert.match(block, /keyword_observation_only_not_registration_or_business_success/);
  assert.match(block, /> \/tmp\/delta-discovery-channels\.json/);
  const upload = source.split(/\r?\n      - /).find(x => /id: canonical_artifact\b/.test(x));
  assert.match(upload, /\/tmp\/delta-discovery-channels\.json/);
});
