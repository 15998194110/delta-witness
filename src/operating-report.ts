// Pure, allowlisted observations. This module cannot schedule, settle, recover,
// acknowledge, persist or send anything, and is never an accounting authority.
export type Evidence<T> = { value: T; observed_at: string; evidence_id: string };
export type Coverage = { status: 'complete' | 'partial'; from: string; through: string };
export type MetricInput = Evidence<number> & { coverage: Coverage };
type Observed<T> = Evidence<T> & { freshness: 'fresh' | 'stale' };
type Projection<T> = { state: 'known' | 'stale' | 'unknown'; value: T | null; observed_at: string | null; evidence_id: string | null; freshness: 'fresh' | 'stale' | 'unknown' };
export const EVIDENCE_MAX_AGE_SECONDS = 3600;
export type RunOutcome = 'running' | 'success' | 'degraded' | 'failed' | 'timeout' | 'cancelled' | 'skipped';
export type RunObservation = { id: string; outcome: RunOutcome; started_at: string; completed_at: string | null; duration_ms: number | null };
export type SchedulerInput = {
  id: string; provider_config?: Evidence<'enabled' | 'disabled'>; run?: Evidence<RunObservation>;
  expected_interval_seconds?: Evidence<number>; last_success?: Evidence<string>; next_run?: Evidence<string>;
  consecutive_failures?: Evidence<number>;
};
export const METRIC_KEYS = ['payment_intent_count', 'payment_authorized_count', 'settlement_confirmed_count',
  'treasury_received_usdc', 'fulfillment_completed_count', 'customer_revenue_usdc', 'variable_cost_usdc',
  'contribution_margin_usdc', 'refunds_usdc'] as const;
type MetricKey = typeof METRIC_KEYS[number];
type Issue = { id: string; confirmed: Evidence<boolean>; since: string };
type MarginIssue = { id: string; margin_usdc: Evidence<number>; cost_basis: 'actual' | 'modeled' };
export type NotificationInput = { status?: Evidence<'not_attempted' | 'provider_accepted' | 'delivered' | 'failed' | 'unconfirmed'>;
  receipt_id?: string; permission?: Evidence<'available' | 'missing' | 'expired'> };
export type LeadInput = {
  id: string; independent?: Evidence<boolean>; need?: Evidence<boolean>; product_fit?: Evidence<boolean>;
  payment_capability?: Evidence<boolean>; automatic_invocation?: Evidence<boolean>; repeat_need?: Evidence<boolean>;
  budget_usdc?: Evidence<number>; purchase_authorized?: Evidence<boolean>;
};
export type AlertHistoryInput = {
  dedupe_key: string; first_seen_at: string; acknowledgment?: Evidence<{ severity: Severity }>; notification?: NotificationInput;
  last_emission?: Evidence<{ severity: Severity; stage: 'initial' | 'escalated'; status: 'queued' | 'provider_accepted' | 'delivered' | 'failed' | 'unconfirmed' }>;
};
export type OperatingReportInput = {
  schedulers?: SchedulerInput[];
  business?: { metrics?: Partial<Record<MetricKey, MetricInput>>; paid_undelivered?: Issue[];
    receipt_unmatched?: Issue[]; negative_margin?: MarginIssue[] };
  rpc_coverage?: Evidence<{ status: 'complete' | 'gap'; from_block: number; through_block: number;
    gap_from_block?: number; gap_through_block?: number }>;
  permissions?: { id: string; status: Evidence<'valid' | 'expired' | 'revoked'> }[];
  persistence?: Evidence<'stored' | 'failed' | 'pending'>; notification?: NotificationInput;
  leads?: LeadInput[]; alert_history?: AlertHistoryInput[];
};
export type AlertPolicy = { scheduler_stale_intervals: number; consecutive_failure_threshold: number;
  paid_undelivered_grace_seconds: number; escalate_after_seconds: number };
export const DEFAULT_ALERT_POLICY: Readonly<AlertPolicy> = Object.freeze({ scheduler_stale_intervals: 3,
  consecutive_failure_threshold: 3, paid_undelivered_grace_seconds: 300, escalate_after_seconds: 3600 });
export type AlertCode = 'scheduler_stale' | 'scheduler_consecutive_failures' | 'paid_undelivered' | 'receipt_unmatched' |
  'rpc_coverage_gap' | 'permission_expired' | 'negative_margin' | 'notification_permission_missing' | 'notification_unconfirmed';
export type Severity = 'SEV1' | 'SEV2' | 'SEV3';
type AlertCandidate = { code: AlertCode; subject: string; severity: Severity; fact: Evidence<unknown>; since?: string;
  cost_basis?: 'actual' | 'modeled'; local_only?: boolean };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
// Opaque local references only. URLs, email addresses, arbitrary messages and
// provider response bodies must never enter this projection.
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value);
function iso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const boolean = (value: unknown): value is boolean => typeof value === 'boolean';
function choice<T extends string>(...values: T[]) { return (value: unknown): value is T => typeof value === 'string' && values.includes(value as T); }
function evidence<T>(value: unknown, valid: (value: unknown) => value is T, now: number): Observed<T> | null {
  if (!object(value) || !valid(value.value) || !iso(value.observed_at) || Date.parse(value.observed_at) > now || !id(value.evidence_id)) return null;
  return { value: value.value, observed_at: value.observed_at, evidence_id: value.evidence_id,
    freshness: now - Date.parse(value.observed_at) > EVIDENCE_MAX_AGE_SECONDS * 1000 ? 'stale' : 'fresh' };
}
function projected<T>(value: Observed<T> | null): Projection<T> {
  return value ? { state: value.freshness === 'fresh' ? 'known' : 'stale', ...value } :
    { state: 'unknown', value: null, observed_at: null, evidence_id: null, freshness: 'unknown' };
}
const fresh = <T>(value: Observed<T> | null): Observed<T> | null => value?.freshness === 'fresh' ? value : null;
function rows(value: unknown): Record<string, unknown>[] {
  // Refuse duplicate identities and oversized collections rather than silently
  // producing a plausible partial total. There are no totals over these rows.
  if (!Array.isArray(value) || value.length > 200) return [];
  const identities = new Set<string>(), duplicate = new Set<string>();
  for (const row of value) if (object(row) && id(row.id)) {
    if (identities.has(row.id)) duplicate.add(row.id); identities.add(row.id);
  }
  return value.filter((row): row is Record<string, unknown> => object(row) && id(row.id) && !duplicate.has(row.id));
}
function receipt(value: unknown, now: number) {
  const source = object(value) ? value : {};
  let status = evidence(source.status, choice('not_attempted', 'provider_accepted', 'delivered', 'failed', 'unconfirmed'), now);
  const receiptId = id(source.receipt_id) ? source.receipt_id : null;
  if (status && ['provider_accepted', 'delivered'].includes(status.value) && !receiptId) status = null;
  return { ...projected(status), receipt_id: status && receiptId ? receiptId : null };
}
function metric(value: unknown, key: MetricKey, now: number) {
  const valid = key.endsWith('_count') ? count : key === 'contribution_margin_usdc' ? finite : nonnegative;
  const observed = evidence(value, valid, now);
  const coverage = object(value) && object(value.coverage) ? value.coverage : null;
  const validCoverage = coverage && choice('complete', 'partial')(coverage.status) && iso(coverage.from) && iso(coverage.through) &&
    Date.parse(coverage.from) <= Date.parse(coverage.through) && Date.parse(coverage.through) <= now &&
    observed && Date.parse(coverage.through) <= Date.parse(observed.observed_at);
  const unit = key.endsWith('_count') ? 'count' : 'USDC';
  if (!observed || !validCoverage) return { state: 'unknown', value: null, unit, coverage: null, observed_at: null, evidence_id: null, freshness: 'unknown', all_time: false };
  // Partial financial totals are not lower bounds for signed margin/refunds:
  // preserve them only as interval observations, never extrapolate revenue.
  return { state: observed.freshness === 'stale' ? 'stale' : coverage.status === 'complete' ? 'known' : 'partial', ...observed, unit,
    coverage: { status: coverage.status, from: coverage.from, through: coverage.through }, all_time: false };
}
function run(value: unknown, now: number): value is RunObservation {
  if (!object(value) || !id(value.id) || !choice('running','success','degraded','failed','timeout','cancelled','skipped')(value.outcome) ||
      !iso(value.started_at) || Date.parse(value.started_at) > now) return false;
  if (value.outcome === 'running') return value.completed_at === null && value.duration_ms === null;
  return iso(value.completed_at) && Date.parse(value.completed_at) >= Date.parse(value.started_at) && Date.parse(value.completed_at) <= now &&
    (value.duration_ms === null || count(value.duration_ms));
}
function policy(input: unknown): AlertPolicy {
  const source = object(input) ? input : {};
  const result = { ...DEFAULT_ALERT_POLICY };
  for (const key of Object.keys(result) as (keyof AlertPolicy)[]) {
    const value = source[key];
    if (count(value) && value > 0 && value <= 31_536_000) result[key] = value;
  }
  return result;
}

/** Projection only: supplied evidence remains the authority, not this report. */
export function projectOperatingReport(input: OperatingReportInput, nowMs: number, requestedPolicy?: Partial<AlertPolicy>) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 8_640_000_000_000_000) throw new Error('invalid_report_time');
  const source: Record<string, unknown> = object(input) ? input : {};
  const thresholds = policy(requestedPolicy), alerts: AlertCandidate[] = [];
  const schedulers = rows(source.schedulers).map(row => {
    const provider = evidence(row.provider_config, choice('enabled', 'disabled'), nowMs);
    const observedRun = evidence(row.run, (value): value is RunObservation => run(value, nowMs), nowMs);
    const latest = observedRun && Date.parse(observedRun.value.completed_at ?? observedRun.value.started_at) <= Date.parse(observedRun.observed_at) ? observedRun : null;
    const interval = evidence(row.expected_interval_seconds, (value): value is number => count(value) && value > 0, nowMs);
    const failures = evidence(row.consecutive_failures, count, nowMs);
    const observedSuccess = evidence(row.last_success, (value): value is string => iso(value) && Date.parse(value) <= nowMs, nowMs);
    const lastSuccess = observedSuccess && Date.parse(observedSuccess.value) <= Date.parse(observedSuccess.observed_at) ? observedSuccess : null;
    const next = evidence(row.next_run, iso, nowMs);
    if (fresh(provider)?.value === 'enabled' && latest && fresh(interval) && nowMs - Date.parse(latest.value.started_at) > interval!.value * thresholds.scheduler_stale_intervals * 1000)
      alerts.push({ code: 'scheduler_stale', subject: row.id as string, severity: 'SEV2', fact: latest });
    if (fresh(failures) && failures!.value >= thresholds.consecutive_failure_threshold)
      alerts.push({ code: 'scheduler_consecutive_failures', subject: row.id as string, severity: 'SEV2', fact: failures! });
    // Rebuild nested run metadata too: never leak unknown properties.
    const safeRun = latest ? { ...latest, value: { id: latest.value.id, outcome: latest.value.outcome, started_at: latest.value.started_at,
      completed_at: latest.value.completed_at, duration_ms: latest.value.duration_ms } } : null;
    return { id: row.id as string, provider_config: projected(provider), run: projected(safeRun), expected_interval_seconds: projected(interval),
      last_success: projected(lastSuccess), next_run: projected(next), consecutive_failures: projected(failures) };
  });
  const business = object(source.business) ? source.business : {};
  const metrics = object(business.metrics) ? business.metrics : {};
  const financial = Object.fromEntries(METRIC_KEYS.map(key => [key, metric(metrics[key], key, nowMs)]));
  for (const code of ['paid_undelivered', 'receipt_unmatched'] as const) for (const row of rows(business[code])) {
    const fact = fresh(evidence(row.confirmed, boolean, nowMs));
    if (fact?.value && iso(row.since) && Date.parse(row.since) <= Date.parse(fact.observed_at) &&
        (code !== 'paid_undelivered' || nowMs - Date.parse(row.since) >= thresholds.paid_undelivered_grace_seconds * 1000))
      alerts.push({ code, subject: row.id as string, severity: code === 'paid_undelivered' ? 'SEV1' : 'SEV2', fact, since: row.since });
  }
  for (const row of rows(business.negative_margin)) {
    const fact = fresh(evidence(row.margin_usdc, finite, nowMs));
    if (fact && fact.value < 0 && choice('actual', 'modeled')(row.cost_basis))
      alerts.push({ code: 'negative_margin', subject: row.id as string, severity: row.cost_basis === 'actual' ? 'SEV2' : 'SEV3', fact, cost_basis: row.cost_basis });
  }
  const rpc = evidence(source.rpc_coverage, (value): value is NonNullable<OperatingReportInput['rpc_coverage']>['value'] =>
    object(value) && choice('complete', 'gap')(value.status) && count(value.from_block) && count(value.through_block) && value.from_block <= value.through_block &&
    (value.status === 'complete' ? value.gap_from_block === undefined && value.gap_through_block === undefined :
      count(value.gap_from_block) && count(value.gap_through_block) && value.gap_from_block >= value.from_block &&
      value.gap_through_block <= value.through_block && value.gap_from_block <= value.gap_through_block), nowMs);
  if (fresh(rpc)?.value.status === 'gap') alerts.push({ code: 'rpc_coverage_gap', subject: 'treasury', severity: 'SEV2', fact: rpc! });
  const permissions = rows(source.permissions).map(row => {
    const fact = evidence(row.status, choice('valid','expired','revoked'), nowMs);
    if (fresh(fact) && fact!.value !== 'valid') alerts.push({ code: 'permission_expired', subject: row.id as string, severity: 'SEV2', fact: fact! });
    return { id: row.id as string, status: projected(fact) };
  });
  const notificationInput = object(source.notification) ? source.notification : {};
  const notificationPermission = fresh(evidence(notificationInput.permission,choice('available','missing','expired'),nowMs));
  const notificationStatus = fresh(evidence(notificationInput.status,choice('not_attempted','provider_accepted','delivered','failed','unconfirmed'),nowMs));
  if (notificationPermission && notificationPermission.value !== 'available') alerts.push({ code:'notification_permission_missing',
    subject:'reporter',severity:'SEV2',fact:notificationPermission,local_only:true });
  if (notificationStatus?.value === 'unconfirmed') alerts.push({ code:'notification_unconfirmed',subject:'reporter',severity:'SEV2',fact:notificationStatus,local_only:true });
  const history = Array.isArray(source.alert_history) && source.alert_history.length <= 200 ? source.alert_history.filter(object) : [];
  const projectedAlerts = alerts.map(alert => {
    // The adapter must supply a stable condition/episode evidence ID. A new
    // episode gets a new key so an old acknowledgment cannot suppress it.
    const dedupeKey = `delta:${alert.code}:${alert.subject}:${alert.fact.evidence_id}`;
    const matches = history.filter(item => item.dedupe_key === dedupeKey);
    const prior = matches.length === 1 ? matches[0] : null;
    const firstSeen = prior && iso(prior.first_seen_at) && Date.parse(prior.first_seen_at) <= Date.parse(alert.fact.observed_at) ? prior.first_seen_at : alert.since ?? alert.fact.observed_at;
    const rank = { SEV1:3, SEV2:2, SEV3:1 };
    const ack = prior ? evidence(prior.acknowledgment, (value): value is { severity: Severity } => object(value) && choice('SEV1','SEV2','SEV3')(value.severity), nowMs) : null;
    const acknowledged = ack && rank[ack.value.severity] >= rank[alert.severity] && Date.parse(ack.observed_at) >= Date.parse(firstSeen) ?
      { ...ack,value:{severity:ack.value.severity} } : null;
    const dueAtMs = Date.parse(firstSeen) + thresholds.escalate_after_seconds * 1000;
    const stage = !acknowledged && nowMs >= dueAtMs ? 'escalated' : 'initial';
    const observedEmission = prior ? evidence(prior.last_emission, (value): value is { severity:Severity;stage:'initial'|'escalated';status:'queued'|'provider_accepted'|'delivered'|'failed'|'unconfirmed' } =>
      object(value) && choice('SEV1','SEV2','SEV3')(value.severity) && choice('initial','escalated')(value.stage) &&
      choice('queued','provider_accepted','delivered','failed','unconfirmed')(value.status),nowMs) : null;
    const emission = observedEmission && Date.parse(observedEmission.observed_at) >= Date.parse(firstSeen) ? observedEmission : null;
    const observedNotification = receipt(prior?.notification, nowMs);
    const episodeNotification = observedNotification.observed_at && Date.parse(observedNotification.observed_at) >= Date.parse(firstSeen) ? observedNotification : receipt(undefined, nowMs);
    let action = 'queue_candidate', reason = 'new_condition';
    if (alert.local_only) { action='local_only'; reason='notification_failure_never_recursively_notifies'; }
    else if (acknowledged) { action='suppress'; reason='explicit_acknowledgment'; }
    else if (matches.length > 1 || prior && !emission) { action='reconcile'; reason='previous_emission_unknown'; }
    else if (emission && ['queued','provider_accepted','unconfirmed'].includes(emission.value.status)) { action='reconcile'; reason='original_delivery_unconfirmed'; }
    else if (emission && rank[alert.severity] <= rank[emission.value.severity] && (stage==='initial' || emission.value.stage==='escalated')) { action='suppress'; reason='unchanged_condition'; }
    else if (emission) reason='worsened_or_escalated';
    if (action==='queue_candidate' && notificationPermission?.value !== 'available') { action='blocked'; reason='notification_permission_unverified'; }
    return { code: alert.code, subject: alert.subject, severity: alert.severity, condition: 'active', dedupe_key: dedupeKey,
      first_seen_at: firstSeen, last_observed_at: alert.fact.observed_at, evidence_ids: [alert.fact.evidence_id],
      ...(alert.cost_basis ? { cost_basis: alert.cost_basis } : {}), acknowledgment: projected(acknowledged),
      notification: episodeNotification, escalation: { state: acknowledged ? 'acknowledged' : nowMs >= dueAtMs ? 'due' : 'pending',
        due_at: new Date(dueAtMs).toISOString(), dispatched: false }, notification_decision:{action,reason,enqueued:false} };
  });
  const leads = rows(source.leads).map(row => {
    const criteria = { independent: evidence(row.independent, boolean, nowMs), need: evidence(row.need, boolean, nowMs),
      product_fit: evidence(row.product_fit, boolean, nowMs), payment_capability: evidence(row.payment_capability, boolean, nowMs),
      automatic_invocation: evidence(row.automatic_invocation, boolean, nowMs), repeat_need: evidence(row.repeat_need, boolean, nowMs) };
    for (const key of Object.keys(criteria) as (keyof typeof criteria)[]) criteria[key]=fresh(criteria[key]);
    const budget = fresh(evidence(row.budget_usdc, nonnegative, nowMs)), authorized = fresh(evidence(row.purchase_authorized, boolean, nowMs));
    const weighted = [[criteria.independent,10], [criteria.need,20], [criteria.product_fit,20], [criteria.payment_capability,15],
      [criteria.automatic_invocation,10], [criteria.repeat_need,5], [budget && { ...budget, value: budget.value > 0 },20]] as const;
    const required = [criteria.independent, criteria.need, criteria.product_fit, criteria.payment_capability, budget && { ...budget, value: budget.value > 0 }];
    return { id: row.id as string, criteria: Object.fromEntries(Object.entries(criteria).map(([key, fact]) => [key, projected(fact)])),
      budget_usdc: projected(budget), purchase_authorized: projected(authorized), qualification: required.some(fact => fact?.value === false) ? 'not_qualified' :
        required.every(fact => fact?.value === true) ? 'evidence_supported_for_review' : 'unknown',
      evidence_score: { supported_points: weighted.reduce((total,[fact,weight]) => total + (fact?.value === true ? weight : 0),0),
        assessed_points: weighted.reduce((total,[fact,weight]) => total + (fact ? weight : 0),0), maximum:100, meaning:'evidence_support_not_conversion_probability' },
      outreach_performed:false, purchasing_authority_granted:false, expected_roi:null };
  });
  const safeRpc = rpc ? { ...rpc, value: { status: rpc.value.status, from_block: rpc.value.from_block, through_block: rpc.value.through_block,
    ...(rpc.value.status === 'gap' ? { gap_from_block: rpc.value.gap_from_block, gap_through_block: rpc.value.gap_through_block } : {}) } } : null;
  return { schema:'delta-operating-report/v1', generated_at:new Date(nowMs).toISOString(), scope:'evidence_projection_only',
    policy: { ...thresholds, evidence_max_age_seconds:EVIDENCE_MAX_AGE_SECONDS, source:'local_candidate_thresholds_not_recovered_attachment_text' }, schedulers,
    business: { metrics: financial, financial_authority:'original_order_and_canonical_receipt_records', all_time_verified:false },
    rpc_coverage:projected(safeRpc), permissions, persistence:projected(evidence(source.persistence,choice('stored','failed','pending'),nowMs)),
    notification:{...receipt(source.notification,nowMs),permission:projected(notificationPermission)}, alerts:projectedAlerts, leads,
    limitations:['No missing observation proves zero or success.','No absence of an alert proves resolution.',
      'No score grants purchase or outreach authority.','No report is evidence of persistence or notification delivery.'] };
}
export type OperatingReport = ReturnType<typeof projectOperatingReport>;
