import type { RuntimeEnv } from './env';
import { withinDeadline } from './deadline';
import { createOrderReadSnapshot } from './order-storage';
import { WatchRunError, type WatchRunSummary } from './watch';

export const SCHEDULED_OBSERVATION_TIMEOUT_MS = 2_000;
export const SCHEDULED_LANE_TIMEOUT_MS = { meshkore: 20_000, watch: 170_000, indexnow: 15_000 } as const;
const PREFIX = 'operations/scheduled/';
const TASKS = ['meshkore', 'watch', 'indexnow'] as const;
type Task = typeof TASKS[number];
type Outcome = 'running' | 'success' | 'degraded' | 'skipped' | 'timeout' | 'failed';
const REASONS = ['none', 'missing_configuration', 'upstream_rejected', 'upstream_invalid_response', 'transport_failure',
  'lane_deadline', 'watch_items_rejected', 'watch_items_degraded', 'watch_inventory_failed'] as const;
type Reason = typeof REASONS[number];
const COUNT_KEYS = ['checks_selected', 'checks_settled', 'checks_rejected', 'notifications_selected',
  'notifications_settled', 'notifications_rejected', 'inventory_failures', 'checks_failed', 'checks_deferred',
  'notifications_failed', 'notifications_deferred'] as const;
export type ScheduledWorkResult = { outcome: 'success' | 'degraded' | 'skipped'; reason?: Reason; http_status?: number; counts?: WatchRunSummary };
export type ScheduledWork = (signal: AbortSignal) => Promise<ScheduledWorkResult>;
type Run = {
  schema: 'delta-scheduled-run/v1'; scope: 'observational'; source: 'cloudflare_cron_handler'; source_status: 'recorded_handler_execution';
  task_id: Task; run_id: string; idempotency_key: string;
  scheduled_at: string; started_at: string; completed_at: string | null; duration_ms: number | null;
  outcome: Outcome; reason: Reason; http_status: number | null; counts: WatchRunSummary | null;
};
type Latest = { schema: 'delta-scheduled-latest/v1'; scope: 'observational'; task_id: Task; latest: Run; last_success: Run | null };
type Observation = 'disabled' | 'recorded' | 'conflict' | 'unconfirmed';
export type ScheduledLaneResult = Run & { observation: Observation };

const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function validCounts(value: unknown): value is WatchRunSummary {
  return !!value && typeof value === 'object' && Object.keys(value).sort().join(',') === [...COUNT_KEYS].sort().join(',') &&
    Object.values(value).every(number => Number.isSafeInteger(number) && number >= 0 && number <= 1_000_000);
}
function validRun(value: unknown, task: Task): value is Run {
  const row = value as Run;
  return !!row && typeof row === 'object' && Object.keys(row).sort().join(',') ===
    ['schema','scope','source','source_status','task_id','run_id','idempotency_key','scheduled_at','started_at','completed_at','duration_ms','outcome','reason','http_status','counts'].sort().join(',') &&
    row.schema === 'delta-scheduled-run/v1' && row.scope === 'observational' && row.task_id === task &&
    row.source === 'cloudflare_cron_handler' && row.source_status === 'recorded_handler_execution' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.run_id) &&
    iso(row.scheduled_at) && iso(row.started_at) && row.idempotency_key === `${task}:${row.scheduled_at}` &&
    (row.completed_at === null || iso(row.completed_at)) &&
    (row.duration_ms === null || Number.isSafeInteger(row.duration_ms) && row.duration_ms >= 0 && row.duration_ms <= 86_400_000) &&
    ['running','success','degraded','skipped','timeout','failed'].includes(row.outcome) && REASONS.includes(row.reason) &&
    (row.outcome === 'running' ? row.completed_at === null && row.duration_ms === null : row.completed_at !== null && row.duration_ms !== null) &&
    (row.http_status === null || Number.isInteger(row.http_status) && row.http_status >= 100 && row.http_status <= 599) &&
    (row.counts === null || validCounts(row.counts));
}
function validLatest(value: unknown, task: Task): value is Latest {
  const row = value as Latest;
  return !!row && typeof row === 'object' && Object.keys(row).sort().join(',') === ['schema','scope','task_id','latest','last_success'].sort().join(',') &&
    row.schema === 'delta-scheduled-latest/v1' && row.scope === 'observational' && row.task_id === task && validRun(row.latest, task) &&
    (row.last_success === null || validRun(row.last_success, task) && row.last_success.outcome === 'success');
}
function position(run: Run): string { return `${run.scheduled_at}|${run.started_at}|${run.run_id}`; }

// Only execution metadata lives here. This is neither a scheduler lock nor a
// business dedupe/financial authority. The original Watch lease still owns work.
async function observe(env: RuntimeEnv, run: Run): Promise<Observation> {
  if (env.SCHEDULED_OPERATIONS_OBSERVABILITY_ENABLED !== 'true') return 'disabled';
  const snapshot = createOrderReadSnapshot(env, 8_192);
  try {
    return await withinDeadline((async (): Promise<Observation> => {
      const encoded = JSON.stringify(run);
      if (!validRun(run, run.task_id) || new TextEncoder().encode(encoded).byteLength > 4_096) throw new Error('observation_invalid');
      const phase = run.outcome === 'running' ? 'started' : 'completed';
      const created = await snapshot.env.PROOFS.put(`${PREFIX}runs/${run.task_id}/${run.run_id}/${phase}.json`, encoded, {
        onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' },
      });
      snapshot.assertActive();
      if (!created) return 'conflict';
      const key = `${PREFIX}latest/${run.task_id}.json`;
      const object = await snapshot.env.PROOFS.get(key); snapshot.assertActive();
      const previous = object ? await object.json<Latest>() : null; snapshot.assertActive();
      if (previous && !validLatest(previous, run.task_id)) throw new Error('observation_invalid');
      const previousPosition = previous ? position(previous.latest) : '';
      // Same run may advance running->final; an old completion cannot regress a
      // newer started run. A late started write cannot replace its own final.
      const useCurrent = !previous || position(run) > previousPosition || position(run) === previousPosition && previous.latest.outcome === 'running';
      const lastSuccess = run.outcome === 'success' && (!previous?.last_success || position(run) > position(previous.last_success)) ? run : previous?.last_success ?? null;
      const next: Latest = { schema: 'delta-scheduled-latest/v1', scope: 'observational', task_id: run.task_id,
        latest: useCurrent ? run : previous!.latest, last_success: lastSuccess };
      if (previous && JSON.stringify(next) === JSON.stringify(previous)) return 'recorded';
      snapshot.assertActive();
      const saved = await snapshot.env.PROOFS.put(key, JSON.stringify(next), {
        onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' },
      });
      snapshot.assertActive();
      // No retry, deletion or takeover after a CAS conflict/uncertain write.
      return saved ? 'recorded' : 'conflict';
    })(), SCHEDULED_OBSERVATION_TIMEOUT_MS, 'observation_timeout', snapshot.cancel);
  } catch { return 'unconfirmed'; }
  finally { snapshot.cancel(); }
}

async function lane(env: RuntimeEnv, task: Task, scheduledAt: string, work: ScheduledWork): Promise<ScheduledLaneResult> {
  const initial: Run = { schema: 'delta-scheduled-run/v1', scope: 'observational', task_id: task,
    source: 'cloudflare_cron_handler', source_status: 'recorded_handler_execution',
    run_id: crypto.randomUUID(), idempotency_key: `${task}:${scheduledAt}`, scheduled_at: scheduledAt, started_at: new Date().toISOString(),
    completed_at: null, duration_ms: null, outcome: 'running', reason: 'none', http_status: null, counts: null };
  const startObservation = await observe(env, initial);
  const controller = new AbortController();
  let outcome: Outcome, reason: Reason = 'none', httpStatus: number | null = null, counts: WatchRunSummary | null = null;
  try {
    const result = await withinDeadline(Promise.resolve().then(() => work(controller.signal)), SCHEDULED_LANE_TIMEOUT_MS[task], 'scheduled_lane_timeout', () => controller.abort());
    if (!result || !['success','degraded','skipped'].includes(result.outcome) || result.reason !== undefined && !REASONS.includes(result.reason) ||
        result.http_status !== undefined && (!Number.isInteger(result.http_status) || result.http_status < 100 || result.http_status > 599) ||
        result.counts !== undefined && !validCounts(result.counts)) throw new Error('invalid_work_result');
    outcome = result.outcome; reason = result.reason ?? 'none'; httpStatus = result.http_status ?? null; counts = result.counts ?? null;
  } catch (error) {
    outcome = controller.signal.aborted ? 'timeout' : 'failed';
    reason = controller.signal.aborted ? 'lane_deadline' : error instanceof WatchRunError ? 'watch_inventory_failed' : 'transport_failure';
    if (error instanceof WatchRunError && validCounts(error.summary)) counts = { ...error.summary };
  } finally { controller.abort(); }
  const final: Run = { ...initial, completed_at: new Date().toISOString(), duration_ms: Math.max(0, Date.now() - Date.parse(initial.started_at)), outcome, reason, http_status: httpStatus, counts };
  const finished = await observe(env, final);
  const observation: Observation = [startObservation, finished].includes('unconfirmed') ? 'unconfirmed' :
    [startObservation, finished].includes('conflict') ? 'conflict' : finished;
  const result = { ...final, observation };
  console.log(JSON.stringify({ event: 'scheduled_lane_outcome', ...result }));
  return result;
}

export async function runScheduledOperations(env: RuntimeEnv, controller: Pick<ScheduledController, 'cron' | 'scheduledTime'>,
  work: Record<Task, ScheduledWork>): Promise<ScheduledLaneResult[]> {
  if (!Number.isFinite(controller.scheduledTime)) throw new Error('invalid_scheduled_time');
  const scheduledAt = new Date(controller.scheduledTime).toISOString();
  const date = new Date(controller.scheduledTime);
  const tasks: Task[] = controller.cron === '*/3 * * * *' ? ['meshkore'] : controller.cron === '*/15 * * * *' ?
    ['watch', ...(date.getUTCHours() === 3 && date.getUTCMinutes() < 15 ? ['indexnow' as const] : [])] : [];
  if (tasks.length === 0) { console.log(JSON.stringify({ event: 'scheduled_trigger_unrecognized', scope: 'observational' })); return []; }
  // Each lane records its own result. Optional indexing does not prevent Watch
  // execution; the caller can mark the combined invocation degraded afterwards.
  return Promise.all(tasks.map(task => lane(env, task, scheduledAt, work[task])));
}

export async function scheduledStatus(env: RuntimeEnv): Promise<Record<string, unknown>> {
  if (env.SCHEDULED_OPERATIONS_OBSERVABILITY_ENABLED !== 'true') return { ok: false, scope: 'observational', error: 'scheduled_observation_disabled' };
  const snapshot = createOrderReadSnapshot(env, 8_192);
  try {
    const tasks = await withinDeadline(Promise.all(TASKS.map(async task => {
      const object = await snapshot.env.PROOFS.get(`${PREFIX}latest/${task}.json`); snapshot.assertActive();
      if (!object) return { task_id: task, source: 'cloudflare_cron_handler', source_status: 'unknown', outcome: 'unknown', last_success_at: null, recorded: null };
      const stored = await object.json<Latest>(); snapshot.assertActive();
      if (!validLatest(stored, task)) throw new Error('observation_invalid');
      return { ...stored.latest, last_success_at: stored.last_success?.completed_at ?? null, recorded: stored };
    })), SCHEDULED_OBSERVATION_TIMEOUT_MS, 'observation_timeout', snapshot.cancel);
    return { ok: true, scope: 'observational', checked_at: new Date().toISOString(), provider_scheduler_enabled: null, next_run: null,
      business_scope: 'existing_cron_lanes_only', paid_order_recovery_connected: false, revenue_observed: false, tasks };
  } catch { return { ok: false, scope: 'observational', error: 'scheduled_observation_unavailable' }; }
  finally { snapshot.cancel(); }
}

// Body bytes and late responses share the lane deadline. No token or upstream
// response payload is ever copied into an observation or error message.
export async function scheduledFetch(input: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) throw new Error('scheduled_cancelled');
  const response = await fetch(input, { ...init, redirect: 'error', signal });
  if (signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error('scheduled_cancelled'); }
  return response;
}
export async function readScheduledJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error('invalid_scheduled_response');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    if (signal.aborted) throw new Error('scheduled_cancelled');
    while (true) {
      const next = await reader.read(); if (signal.aborted) throw new Error('scheduled_cancelled');
      if (next.done) break; size += next.value.byteLength;
      if (size > 16_384) throw new Error('invalid_scheduled_response'); chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}
