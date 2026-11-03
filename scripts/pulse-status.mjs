import { open, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateTreasuryReport } from './validate-treasury-report.mjs';

export const DAILY_SCHEDULE = '21 3 * * *';
export const HOURLY_SCHEDULE = '21 0-2,4-23 * * *';
const SCANNERS = Object.freeze({ payan: 'delta-payan-demand.json', agentexchange: 'delta-agentexchange-demand.json',
  agentpact: 'delta-agentpact-demand.json', external: 'delta-external-funded-demand.json',
  moltjobs: 'delta-moltjobs-demand.json', workpnp: 'delta-workpnp-demand.json' });
const FILES = Object.freeze({ source: 'delta-owner-pricing-source.json', prices: 'delta-owner-pricing-live.json',
  health: 'delta-health.json', treasury: 'delta-treasury.json', paid_funnel: 'delta-revenue-candidates.json',
  discovery_channels: 'delta-discovery-channels.json', ...SCANNERS });
const MAINTENANCE = ['x402_discovery', 'agent402', 'payan_listings', 'allmcps', 'indexnow_core', 'indexnow_base_app',
  'bazaar', 'discovery_channels', 'true402', 'nohumans'];
const OUTCOMES = new Set(['success', 'failure', 'cancelled', 'skipped']);
const integer = n => Number.isSafeInteger(n) && n >= 0;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const outcome = (values, key) => OUTCOMES.has(values?.[key]?.outcome ?? values?.[key]) ? (values[key]?.outcome ?? values[key]) : 'unknown';

// Configuration approval is durable for future eligible daily runs, not a
// per-action prompt. No approval is inferred from a missing flag/checkpoint.
export function maintenanceDecision(event, schedule, enabled) {
  const due = event === 'schedule' && schedule === DAILY_SCHEDULE;
  return { due, authorized_configuration: enabled === 'true', run: due && enabled === 'true',
    decision: !due ? 'not_daily_schedule' : enabled === 'true' ? 'approved_daily_window' : 'authorization_migration_required',
    catchup_guaranteed: false, durable_due_checkpoint: 'not_configured' };
}

function stage(values, key, valid) {
  const execution = outcome(values, key);
  return { execution, state: execution === 'success' ? valid === true ? 'verified' : 'unknown' : execution === 'failure' ? 'failed' : execution };
}
export function scannerState(execution, report) {
  if (execution !== 'success') return { execution, state: execution === 'failure' ? 'failed' : execution, degraded_sources: null };
  if (!object(report) || report.ok !== true) return { execution, state: 'unknown', degraded_sources: null };
  const rows = Array.isArray(report.results) ? report.results : [report];
  if (!rows.length || rows.length > 100 || rows.some(r => !object(r) || !['present', 'checked', 'degraded_recoverable'].includes(r.discovery_status))) {
    return { execution, state: 'unknown', degraded_sources: null };
  }
  const degraded = rows.filter(r => r.discovery_status === 'degraded_recoverable' || r.board_count_consistent === false ||
    r.ok === false || (r.http != null && (!integer(r.http) || r.http < 200 || r.http >= 300))).length;
  return { execution, state: degraded ? 'degraded' : 'checked', degraded_sources: degraded };
}

function discoveryObservation(execution, report, planned) {
  const result = { execution, state: 'not_planned', sources: null,
    scope: 'keyword_observation_only_not_registration_or_business_success' };
  if (!planned) return result;
  if (execution !== 'success') return { ...result, state: execution === 'failure' ? 'failed' : execution };
  const names = ['x402_list', 'circle', 'payapi'], states = ['present', 'not_observed', 'degraded'];
  if (!object(report) || report.schema !== 'delta-discovery-observation/v1' || report.scope !== result.scope ||
    names.some(key => !states.includes(report[key]))) return { ...result, state: 'unknown' };
  return { ...result, sources: Object.fromEntries(names.map(key => [key, report[key]])),
    state: names.some(key => report[key] === 'degraded') ? 'degraded' : names.some(key => report[key] === 'not_observed') ? 'not_observed' : 'checked' };
}

// Pure projection of this run. No checkpoint, payment, receipt or customer
// revenue authority is created here. Never copy raw provider text or rows.
export function buildPulseStatus({ outcomes = {}, reports = {}, run = {}, maintenanceEnabled, now = new Date().toISOString(), phase = 'prepared' } = {}) {
  const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  const observedAt = iso(now), startedAt = iso(run.started_at);
  const metadata = { id: /^\d+$/.test(String(run.id)) ? String(run.id) : null,
    attempt: integer(Number(run.attempt)) && Number(run.attempt) > 0 ? Number(run.attempt) : null,
    source_sha: /^[0-9a-f]{40}$/.test(run.sha) ? run.sha : null,
    event: ['schedule', 'push', 'workflow_dispatch'].includes(run.event) ? run.event : 'unknown',
    schedule: [DAILY_SCHEDULE, HOURLY_SCHEDULE].includes(run.schedule) ? run.schedule : null };
  const maintenance = maintenanceDecision(metadata.event, metadata.schedule, maintenanceEnabled);
  const core = { source: stage(outcomes, 'core_source', reports.source?.ok === true),
    prices: stage(outcomes, 'core_prices', reports.prices?.ok === true),
    purchase_path: stage(outcomes, 'core_path', reports.health?.ok === true) };
  let validation;
  try { validation = validateTreasuryReport(reports.treasury); } catch { validation = { ok: false, continuity: 'unknown' }; }
  const treasuryValid = outcome(outcomes, 'treasury') === 'success' && outcome(outcomes, 'treasury_evidence') === 'success' && validation.ok === true;
  const treasury = { execution: outcome(outcomes, 'treasury'), semantic_validation: outcome(outcomes, 'treasury_evidence'),
    state: treasuryValid ? 'verified_declared_interval' : 'unverified',
    coverage: treasuryValid ? validation.continuity : 'unknown',
    start_block: treasuryValid ? reports.treasury.start_block : null,
    through_block: treasuryValid ? reports.treasury.requested_through_block : null,
    recognized_customer_revenue_usdc: null, actual_variable_cost_usdc: null, actual_contribution_margin_usdc: null };
  const scanners = Object.fromEntries(Object.keys(SCANNERS).map(key => [key, scannerState(outcome(outcomes, key), reports[key])]));
  const paid = reports.paid_funnel;
  const paidFunnel = stage(outcomes, 'paid_funnel', paid?.ok === true && paid.scan_complete === true && integer(paid.candidate_rows) && Array.isArray(paid.rows) && paid.candidate_rows === paid.rows.length);
  const artifact = phase === 'final' ? outcome(outcomes, 'canonical_artifact') : 'not_yet_observed';
  const discovery = discoveryObservation(outcome(outcomes, 'discovery_channels'), reports.discovery_channels, maintenance.due);
  const criticalOk = Object.values(core).every(x => x.state === 'verified') && treasuryValid && paidFunnel.state === 'verified';
  const degraded = Object.values(scanners).some(x => x.state !== 'checked') ||
    ['operator_evidence', 'agentpact_raw'].some(key => outcome(outcomes, key) !== 'success') ||
    MAINTENANCE.some(key => ['failure', 'cancelled'].includes(outcome(outcomes, key))) ||
    (maintenance.due && discovery.state !== 'checked') ||
    (maintenance.due && !maintenance.run);
  const completedAt = phase === 'final' ? observedAt : null;
  const diagnosticOutcome = !criticalOk ? 'failed' : phase !== 'final' || artifact !== 'success' ? 'unknown' : degraded ? 'degraded' : 'success';
  return { schema: 'delta-pulse-status/v1', observed_at: observedAt,
    task_id: 'delta-discovery-pulse', run_id: metadata.id, source: 'github_actions', source_status: 'recorded_runner_observation',
    scheduled_at: null, started_at: startedAt, completed_at: completedAt,
    duration_ms: startedAt && completedAt && Date.parse(completedAt) >= Date.parse(startedAt) ? Date.parse(completedAt) - Date.parse(startedAt) : null,
    outcome: diagnosticOutcome, last_success_at: null,
    execution_scope: 'runner_start_to_final_report_excludes_final_upload_and_gates',
    run: metadata, scheduler: { state: 'trigger_observed', historical_coverage: 'unverified', watchdog: 'independent_watchdog_required' },
    core, treasury, paid_funnel: paidFunnel, scanners,
    operator_evidence: { execution: outcome(outcomes, 'operator_evidence') },
    supplemental_evidence: { agentpact_raw: { execution: outcome(outcomes, 'agentpact_raw') } },
    maintenance: { ...maintenance, discovery_observation: discovery, stages: Object.fromEntries(MAINTENANCE.map(key => [key, { execution: outcome(outcomes, key),
      provider_effect: outcome(outcomes, key) === 'success' ? 'not_independently_verified_by_this_summary' : 'unknown' }])) },
    reporting: { phase: phase === 'final' ? 'final' : 'prepared', canonical_artifact: artifact,
      summary_artifact: 'upload_result_available_in_GitHub_job_metadata', notification: 'unknown' },
    critical_ok: criticalOk,
    financial_scope: 'Operational diagnostics only; no revenue, actual cost, margin or historical-zero inference.' };
}

export async function readBoundedJson(path, maximum = 16_000_000) {
  let file;
  try {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16_000_000) return null;
    file = await open(path, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) return null;
    const chunks = []; let size = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65536, maximum - size + 1));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maximum || size > stat.size) return null;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (size !== stat.size) return null;
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { return null; }
  finally { await file?.close(); }
}

export function pulseGate(report, outcomes, cloudEnabled = false) {
  return report?.schema === 'delta-pulse-status/v1' && report.critical_ok === true && report.reporting?.phase === 'final' &&
    report.reporting.canonical_artifact === 'success' && ['report_status', 'report_final', 'canonical_artifact', 'status_artifact']
      .every(key => outcome(outcomes, key) === 'success') && (!cloudEnabled || outcome(outcomes, 'operating_publish') === 'success');
}

async function main() {
  if (process.argv[2] === 'gate') {
    let outcomes = {};
    try { outcomes = JSON.parse(process.env.DELTA_STEP_OUTCOMES || '{}'); } catch { /* fail closed */ }
    if (!process.argv[3] || !pulseGate(await readBoundedJson(join(process.argv[3], 'delta-pulse-status-final.json')), outcomes, process.env.DELTA_OPERATIONS_CLOUD_ENABLED === 'true')) {
      console.error('pulse_core_financial_or_reporting_evidence_unverified'); process.exitCode = 1;
    }
    return;
  }
  if (process.argv[2] === 'maintenance') {
    const result = maintenanceDecision(process.env.GITHUB_EVENT_NAME, process.env.DELTA_EVENT_SCHEDULE, process.env.DELTA_DAILY_MAINTENANCE_ENABLED);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `run=${result.run}\ndue=${result.due}\n`);
    console.log(JSON.stringify(result)); return;
  }
  const directory = process.argv[2], phase = process.argv[3] === 'final' ? 'final' : 'prepared';
  if (!directory) throw new Error('pulse_report_directory_required');
  let outcomes = {};
  try { outcomes = JSON.parse(process.env.DELTA_STEP_OUTCOMES || '{}'); } catch { /* unknown, never success */ }
  const reports = Object.fromEntries(await Promise.all(Object.entries(FILES).map(async ([key, name]) => [key, await readBoundedJson(join(directory, name))])));
  const report = buildPulseStatus({ outcomes, reports, run: { id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
    sha: process.env.GITHUB_SHA, event: process.env.GITHUB_EVENT_NAME, schedule: process.env.DELTA_EVENT_SCHEDULE,
    started_at: process.env.DELTA_RUN_STARTED_AT },
    maintenanceEnabled: process.env.DELTA_DAILY_MAINTENANCE_ENABLED, phase });
  await writeFile(join(directory, phase === 'final' ? 'delta-pulse-status-final.json' : 'delta-pulse-status.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(report));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n### DELTA pulse ${phase}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => { console.error('pulse_status_unavailable'); process.exitCode = 1; });
}
