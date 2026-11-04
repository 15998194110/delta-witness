// Fourth independent check for the ONE canonical Pulse. No business execution,
// dispatch or provider setup. Disabled until exact-source activation is approved.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pingIndependentMonitor } from './independent-monitor.mjs';
import { pulseGate, readBoundedJson } from './pulse-status.mjs';

const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const identity = run => !!run && /^[1-9][0-9]{0,18}$/.test(run.id) && Number.isSafeInteger(run.attempt) && run.attempt > 0 && /^[a-f0-9]{40}$/.test(run.source_sha);
const success = (outcomes, key) => (outcomes?.[key]?.outcome ?? outcomes?.[key]) === 'success';
export function pulseDeadmanDecision(original, report, outcomes, run, now = Date.now(), cloudEnabled = false) {
  const fail = reason => ({ phase: 'fail', reason, last_verified_critical_completion_at: null, customer_revenue_verified: false });
  if (!identity(run) || original?.schema !== 'delta-pulse-deadman-start/v1' || !uuid(original.ping_run_id) ||
      !identity(original.run) || JSON.stringify(original.run) !== JSON.stringify(run) || !iso(original.started_at) ||
      !iso(original.runner_started_at) || original.runner_started_at > original.started_at ||
      Date.parse(original.started_at) > now || now - Date.parse(original.runner_started_at) >= 55 * 60000) return fail('original_run_missing_mismatched_or_expired');
  if (!report || report.run?.id !== run.id || report.run?.attempt !== run.attempt || report.run?.source_sha !== run.source_sha ||
      !iso(report.completed_at) || Date.parse(report.completed_at) < Date.parse(original.started_at) || Date.parse(report.completed_at) > now ||
      !['success', 'degraded'].includes(report.outcome)) return fail('critical_observation_unverified');
  // The original final gate must have really executed; queued/failed/newer runs,
  // HTTP 200, a fresh created_at and a report's unvalidated boolean never suffice.
  if (!success(outcomes, 'pulse_critical_gate') || !success(outcomes, 'pulse_deadman_start') || !pulseGate(report, outcomes, cloudEnabled))
    return fail('original_critical_or_reporting_gate_failed');
  return { phase: 'success', reason: report.outcome === 'degraded' ? 'critical_verified_supplemental_degraded' : 'critical_operations_verified',
    last_verified_critical_completion_at: report.completed_at, customer_revenue_verified: false };
}

export async function startPulseDeadman({ path, run, pingUrl, fetcher = fetch, now = () => Date.now(), runnerStartedAt = new Date(now()).toISOString() }) {
  if (!path || !identity(run)) throw Error('pulse_deadman_configuration_invalid');
  if (!iso(runnerStartedAt) || Date.parse(runnerStartedAt) > now()) throw Error('pulse_deadman_runner_time_invalid');
  const original = { schema: 'delta-pulse-deadman-start/v1', run, ping_run_id: randomUUID(), started_at: new Date(now()).toISOString(),
    runner_started_at: runnerStartedAt,
    notification_delivered: null, notification_acknowledged: null };
  // Persist identity before network. A lost ping ACK cannot cause a second start.
  await writeFile(path, JSON.stringify(original, null, 2) + '\n', { flag: 'wx' });
  return { ...original, heartbeat: await pingIndependentMonitor(fetcher, pingUrl, original.ping_run_id, 'start') };
}

export async function finishPulseDeadman({ original, report, outcomes, run, resultPath, pingUrl, fetcher = fetch, now = () => Date.now(), cloudEnabled = false }) {
  const decision = pulseDeadmanDecision(original, report, outcomes, run, now(), cloudEnabled);
  const observation = { schema: 'delta-pulse-deadman-finish/v1', run, ping_run_id: uuid(original?.ping_run_id) ? original.ping_run_id : randomUUID(),
    observed_at: new Date(now()).toISOString(), ...decision, notification_delivered: null, notification_acknowledged: null,
    scope: 'original_run_critical_operational_evidence_not_customer_revenue', external_delivery_verified: false };
  if (!resultPath) throw Error('pulse_deadman_output_required');
  // Immutable intent makes repeat finish invocations fail closed BEFORE any ping.
  // Thus an unknown/failed original cannot be replaced with a later success.
  await writeFile(resultPath, JSON.stringify(observation, null, 2) + '\n', { flag: 'wx' });
  const receipt = { ...observation, heartbeat: await pingIndependentMonitor(fetcher, pingUrl, observation.ping_run_id, decision.phase) };
  await writeFile(`${resultPath}.receipt.json`, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

async function main() {
  if (process.env.DELTA_PULSE_DEADMAN_ENABLED !== 'true' || !/^[a-f0-9]{40}$/.test(process.env.DELTA_APPROVED_PULSE_DEADMAN_SHA ?? '') ||
      process.env.DELTA_APPROVED_PULSE_DEADMAN_SHA !== process.env.GITHUB_SHA) throw Error('pulse_deadman_activation_not_approved');
  const run = { id: process.env.GITHUB_RUN_ID, attempt: Number(process.env.GITHUB_RUN_ATTEMPT), source_sha: process.env.GITHUB_SHA };
  if (!identity(run)) throw Error('pulse_deadman_configuration_invalid');
  const pingUrl = process.env.DELTA_PULSE_HEALTHCHECKS_PING_URL;
  let result;
  if (process.argv[2] === 'start') {
    const started = process.env.DELTA_RUN_STARTED_AT;
    if (!started || !Number.isFinite(Date.parse(started))) throw Error('pulse_deadman_runner_time_missing');
    result = await startPulseDeadman({ path: process.argv[3], run, pingUrl, runnerStartedAt: new Date(started).toISOString() });
  }
  else if (process.argv[2] === 'finish') {
    let outcomes = {}; try { outcomes = JSON.parse(process.env.DELTA_STEP_OUTCOMES || '{}'); } catch { /* fail closed */ }
    result = await finishPulseDeadman({ original: await readBoundedJson(process.argv[3], 8192), report: await readBoundedJson(process.argv[4], 65536),
      outcomes, run, resultPath: process.argv[5], pingUrl, cloudEnabled: process.env.DELTA_OPERATIONS_CLOUD_ENABLED === 'true' });
  } else throw Error('pulse_deadman_phase_invalid');
  console.log(JSON.stringify(result));
  if (result.heartbeat.state !== 'accepted' || result.phase === 'fail') process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main().catch(() => {
  console.error('pulse_deadman_unconfirmed'); process.exitCode = 2;
});
