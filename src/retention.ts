import { sha256, stableJson } from "./crypto";

export const RETENTION_CLASSES = ["raw_artifacts", "minimal_metadata", "transaction_audit"] as const;
export type RetentionClass = typeof RETENTION_CLASSES[number];
export type RetentionEvent = "settlement_confirmed" | "fulfillment_completed";
export type RetentionPolicy = {
  schema: "delta-retention-policy/v1";
  policy_id: string;
  classes: Record<RetentionClass, { start_event: RetentionEvent; retain_seconds: number; deletion_window_seconds: number }>;
  export_rights: { raw_artifacts: "authenticated_until_raw_expiry"; minimal_metadata: "authenticated_until_metadata_expiry" };
};
export type RetentionIdentity = { order_id: string; tenant_id: string; proof_id: string; payment_fingerprint: string; purchased_at: string };
export type RetentionSnapshot = RetentionIdentity & { schema: "delta-retention-snapshot/v1"; policy: RetentionPolicy; policy_hash: string; snapshot_hash: string };
export type RetentionEvents = { settlement_confirmed_at?: string; fulfillment_completed_at?: string };
export type RetentionTimeline = Record<RetentionClass, { start_event: RetentionEvent; starts_at: string | null; expires_at: string | null; deletion_not_before: string | null; deletion_not_after: string | null; state: "pending_start" | "retained" | "expired_in_window" | "expired_window_missed" }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_INPUT_BYTES = 2_000_000;
const MAX_PLAN_ORDERS = 500;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("invalid_retention_input");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) throw new Error("invalid_retention_input");
}
function iso(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error("invalid_retention_time");
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) throw new Error("invalid_retention_time");
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms)) throw new Error("invalid_retention_time");
  return new Date(ms).toISOString();
}
function seconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) throw new Error("invalid_retention_duration");
  return value;
}
function later(time: string, duration: number): string {
  const result = Date.parse(time) + duration * 1000;
  if (!Number.isSafeInteger(result) || !Number.isFinite(new Date(result).getTime())) throw new Error("invalid_retention_time");
  return new Date(result).toISOString();
}
function identity(value: RetentionIdentity): RetentionIdentity {
  if (!UUID.test(value.order_id) || !UUID.test(value.proof_id) || !LABEL.test(value.tenant_id) || !DIGEST.test(value.payment_fingerprint)) throw new Error("invalid_retention_identity");
  return { order_id: value.order_id, tenant_id: value.tenant_id, proof_id: value.proof_id, payment_fingerprint: value.payment_fingerprint, purchased_at: iso(value.purchased_at) };
}

// No default policy or retention period is supplied. A configured proposal is
// not an approved customer promise, nor authority to migrate/delete old data.
export function parseRetentionPolicy(value: unknown): RetentionPolicy | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).length > 8000) throw new Error("invalid_retention_policy");
    try { value = JSON.parse(value); } catch { throw new Error("invalid_retention_policy"); }
  }
  const input = record(value); exact(input, ["schema", "policy_id", "classes", "export_rights"]);
  if (input.schema !== "delta-retention-policy/v1" || typeof input.policy_id !== "string" || !LABEL.test(input.policy_id)) throw new Error("invalid_retention_policy");
  const classes = record(input.classes); exact(classes, [...RETENTION_CLASSES]);
  const parsed = {} as RetentionPolicy["classes"];
  for (const category of RETENTION_CLASSES) {
    const policy = record(classes[category]); exact(policy, ["start_event", "retain_seconds", "deletion_window_seconds"]);
    if (policy.start_event !== "settlement_confirmed" && policy.start_event !== "fulfillment_completed") throw new Error("invalid_retention_event");
    parsed[category] = { start_event: policy.start_event, retain_seconds: seconds(policy.retain_seconds), deletion_window_seconds: seconds(policy.deletion_window_seconds) };
  }
  // Validate obligations before payment, without assuming an upper bound on
  // the time between settlement and fulfillment. This conservative subset
  // requires both duration and start-event rank to be nondecreasing.
  const eventRank: Record<RetentionEvent, number> = { settlement_confirmed: 0, fulfillment_completed: 1 };
  for (let index = 1; index < RETENTION_CLASSES.length; index++) {
    const previous = parsed[RETENTION_CLASSES[index - 1]], next = parsed[RETENTION_CLASSES[index]];
    if (next.retain_seconds < previous.retain_seconds || eventRank[next.start_event] < eventRank[previous.start_event]) {
      throw new Error("retention_policy_conflicts_with_evidence_obligation");
    }
  }
  const rights = record(input.export_rights); exact(rights, ["raw_artifacts", "minimal_metadata"]);
  if (rights.raw_artifacts !== "authenticated_until_raw_expiry" || rights.minimal_metadata !== "authenticated_until_metadata_expiry") throw new Error("invalid_retention_export_rights");
  return { schema: "delta-retention-policy/v1", policy_id: input.policy_id, classes: parsed,
    export_rights: { raw_artifacts: rights.raw_artifacts, minimal_metadata: rights.minimal_metadata } };
}

export async function createRetentionSnapshot(policy: unknown, order: RetentionIdentity): Promise<RetentionSnapshot> {
  const originalPolicy = parseRetentionPolicy(policy);
  if (!originalPolicy) throw new Error("retention_policy_not_configured");
  const snapshot = { schema: "delta-retention-snapshot/v1" as const, ...identity(order), policy: originalPolicy, policy_hash: await sha256(stableJson(originalPolicy)) };
  return { ...snapshot, snapshot_hash: await sha256(stableJson(snapshot)) };
}
export async function verifyRetentionSnapshot(value: unknown, authoritativeHash: string): Promise<RetentionSnapshot> {
  const input = record(value); exact(input, ["schema", "order_id", "tenant_id", "proof_id", "payment_fingerprint", "purchased_at", "policy", "policy_hash", "snapshot_hash"]);
  if (input.schema !== "delta-retention-snapshot/v1" || typeof authoritativeHash !== "string" || !DIGEST.test(authoritativeHash)) throw new Error("retention_authority_missing");
  const reconstructed = await createRetentionSnapshot(input.policy, input as unknown as RetentionIdentity);
  if (stableJson(reconstructed) !== stableJson(input) || reconstructed.snapshot_hash !== authoritativeHash) throw new Error("retention_snapshot_inconsistent");
  return reconstructed;
}
export function retentionTimeline(snapshot: RetentionSnapshot, suppliedEvents: RetentionEvents, at: string): RetentionTimeline {
  const checked = parseRetentionPolicy(snapshot.policy), now = Date.parse(iso(at)), bought = Date.parse(iso(snapshot.purchased_at));
  if (!checked) throw new Error("retention_policy_not_configured");
  const events = record(suppliedEvents);
  if (Object.keys(events).some(key => !["settlement_confirmed_at", "fulfillment_completed_at"].includes(key))) throw new Error("invalid_retention_event");
  const settled = events.settlement_confirmed_at === undefined ? undefined : iso(events.settlement_confirmed_at);
  const completed = events.fulfillment_completed_at === undefined ? undefined : iso(events.fulfillment_completed_at);
  if (settled && Date.parse(settled) < bought || completed && (!settled || Date.parse(completed) < Date.parse(settled))) throw new Error("retention_event_inconsistent");
  if (settled && Date.parse(settled) > now || completed && Date.parse(completed) > now) throw new Error("retention_event_in_future");
  const timelines = {} as RetentionTimeline;
  for (const category of RETENTION_CLASSES) {
    const rule = checked.classes[category], start = rule.start_event === "settlement_confirmed" ? settled : completed;
    if (!start) { timelines[category] = { start_event: rule.start_event, starts_at: null, expires_at: null, deletion_not_before: null, deletion_not_after: null, state: "pending_start" }; continue; }
    if (Date.parse(start) > now) throw new Error("retention_event_in_future");
    const expiry = later(start, rule.retain_seconds), end = later(expiry, rule.deletion_window_seconds);
    timelines[category] = { start_event: rule.start_event, starts_at: start, expires_at: expiry, deletion_not_before: expiry, deletion_not_after: end,
      state: now < Date.parse(expiry) ? "retained" : now < Date.parse(end) ? "expired_in_window" : "expired_window_missed" };
  }
  const raw = timelines.raw_artifacts.expires_at, metadata = timelines.minimal_metadata.expires_at, audit = timelines.transaction_audit.expires_at;
  if (raw && metadata && Date.parse(metadata) < Date.parse(raw) || metadata && audit && Date.parse(audit) < Date.parse(metadata)) throw new Error("retention_policy_conflicts_with_evidence_obligation");
  return timelines;
}
export function retentionExportState(timeline: RetentionTimeline): "allowed_by_retention" | "pending_start" | "expired" {
  return timeline.raw_artifacts.state === "retained" ? "allowed_by_retention" : timeline.raw_artifacts.state === "pending_start" ? "pending_start" : "expired";
}

// Policy permission only. The caller must still authenticate the buyer and
// validate the immutable journal binding; this never extends credential TTL.
export async function evaluateRetention(snapshot: RetentionSnapshot | undefined, events: RetentionEvents, at: string) {
  iso(at);
  if (!snapshot) return { state: "legacy_policy_unknown" as const, raw_expires_at: null, export_allowed: null, timeline: null };
  const verified = await verifyRetentionSnapshot(snapshot, snapshot.snapshot_hash);
  const timeline = retentionTimeline(verified, events, at);
  const state = retentionExportState(timeline);
  return { state, raw_expires_at: timeline.raw_artifacts.expires_at, export_allowed: state === "allowed_by_retention" ? true : state === "expired" ? false : null, timeline };
}
export type RetentionInventoryOrder = RetentionIdentity & {
  snapshot?: RetentionSnapshot; authoritative_snapshot_hash?: string; events: RetentionEvents;
  fulfillment_state: "complete" | "processing" | "unknown"; settlement_state: "settlement_confirmed" | "settlement_unknown" | "unknown";
  obligation_state: "cleared" | "open" | "unknown"; legal_hold: boolean | "unknown";
  objects: Array<{ key: string; etag: string; sha256: string; bytes: number }>;
};
export type RetentionDryRunInput = { schema: "delta-retention-inventory/v1"; tenant_id: string; at: string; orders: RetentionInventoryOrder[] };

// A pure plan; it has no storage/network handle and no executor. The caller must
// obtain authoritative snapshot hashes/events/ownership from original journals.
// These supplied assertions are never treated as real-world verification here.
export async function planRetentionDryRun(input: RetentionDryRunInput) {
  if (!input || input.schema !== "delta-retention-inventory/v1" || !LABEL.test(input.tenant_id) || !Array.isArray(input.orders) || input.orders.length > MAX_PLAN_ORDERS || new TextEncoder().encode(JSON.stringify(input)).length > MAX_INPUT_BYTES) throw new Error("invalid_retention_inventory");
  const at = iso(input.at);
  const candidates: Array<{ candidate_id: string; order_id: string; tenant_id: string; proof_id: string; snapshot_hash: string; category: "raw_artifacts"; action: "dry_run_candidate_only"; not_before: string; not_after: string; objects: RetentionInventoryOrder["objects"] }> = [];
  const excluded: Array<{ order_id: string; reason: string }> = [];
  const schedules: Array<{ order_id: string; timeline: RetentionTimeline; raw_export_state: ReturnType<typeof retentionExportState>; metadata_action: "preserve_requires_separate_review"; audit_action: "preserve_requires_separate_review" }> = [];
  const seenOrders = new Map<string, number>(), seenKeys = new Map<string, number>();
  for (const order of input.orders) {
    seenOrders.set(order.order_id, (seenOrders.get(order.order_id) ?? 0) + 1);
    for (const key of new Set((order.objects ?? []).map(object => object.key))) seenKeys.set(key, (seenKeys.get(key) ?? 0) + 1);
  }
  for (const order of input.orders) {
    let reason: string | undefined;
    try {
      const original = identity(order);
      if (order.tenant_id !== input.tenant_id) reason = "other_tenant";
      else if (!order.snapshot || !order.authoritative_snapshot_hash) reason = "legacy_or_missing_retention_authority";
      else if (seenOrders.get(order.order_id)! > 1 || order.objects.some(object => seenKeys.get(object.key)! > 1)) reason = "duplicate_or_conflicting_ownership";
      else if (order.fulfillment_state !== "complete" || order.settlement_state !== "settlement_confirmed") reason = "live_or_unknown_order";
      else if (order.obligation_state !== "cleared" || order.legal_hold !== false) reason = "obligation_or_hold_not_cleared";
      else {
        const snapshot = await verifyRetentionSnapshot(order.snapshot, order.authoritative_snapshot_hash);
        if (Object.entries(original).some(([key, value]) => snapshot[key as keyof RetentionIdentity] !== value)) throw new Error("retention_identity_mismatch");
        const timeline = retentionTimeline(snapshot, order.events, at);
        schedules.push({ order_id: order.order_id, timeline, raw_export_state: retentionExportState(timeline), metadata_action: "preserve_requires_separate_review", audit_action: "preserve_requires_separate_review" });
        const raw = timeline.raw_artifacts;
        if (raw.state !== "expired_in_window") reason = raw.state;
        else {
          const expected = [`${order.proof_id}/page.html`, `${order.proof_id}/page.md`, `${order.proof_id}/screenshot.png`].sort();
          const objects = order.objects.map(value => {
            const object = record(value); exact(object, ["key", "etag", "sha256", "bytes"]);
            if (typeof object.key !== "string" || typeof object.etag !== "string" || typeof object.sha256 !== "string" || typeof object.bytes !== "number") throw new Error("retention_object_inventory_inconsistent");
            return { key: object.key, etag: object.etag, sha256: object.sha256, bytes: object.bytes };
          }).sort((a, b) => a.key.localeCompare(b.key));
          if (objects.length !== 3 || stableJson(objects.map(object => object.key)) !== stableJson(expected) || objects.some(object =>
            !object.etag || object.etag.length > 256 || /[\r\n\x00-\x1f]/.test(object.etag) || !DIGEST.test(object.sha256) || !Number.isSafeInteger(object.bytes) || object.bytes <= 0)) throw new Error("retention_object_inventory_inconsistent");
          const candidate = { order_id: order.order_id, tenant_id: order.tenant_id, proof_id: order.proof_id, snapshot_hash: snapshot.snapshot_hash,
            category: "raw_artifacts" as const, action: "dry_run_candidate_only" as const, not_before: raw.deletion_not_before!, not_after: raw.deletion_not_after!, objects };
          candidates.push({ candidate_id: await sha256(stableJson(candidate)), ...candidate });
        }
      }
    } catch { reason = "invalid_or_inconsistent_evidence"; }
    if (reason) excluded.push({ order_id: typeof order.order_id === "string" && UUID.test(order.order_id) ? order.order_id : "invalid-order-id", reason });
  }
  candidates.sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
  excluded.sort((a, b) => `${a.order_id}:${a.reason}`.localeCompare(`${b.order_id}:${b.reason}`));
  schedules.sort((a, b) => a.order_id.localeCompare(b.order_id));
  const plan = { schema: "delta-retention-dry-run/v1", dry_run: true, execution_authorized: false, authority_status: "supplied_fixture_not_live_verified",
    tenant_id: input.tenant_id, evaluated_at: at, inventory_hash: await sha256(stableJson(input)), candidates, excluded, schedules,
    protected_categories: ["minimal_metadata", "transaction_audit"], actual_deletions: 0 };
  return { ...plan, plan_hash: await sha256(stableJson(plan)) };
}
