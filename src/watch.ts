import type { RuntimeEnv } from "./env";
import { capturePage, storeCapture, type ProofManifest } from "./capture";
import { hmacSha256, randomSecret, sha256, stableJson, uuidFromDigest } from "./crypto";
import { evaluatePreflight, parsePreflightRequest, type PreflightRequest } from "./fulfillment";
import { quoteProductWithOverride, raisePriceAfterNegativeMargin } from "./pricing";
import { assertPublicDns, resolvePublicRedirects, sanitizeDimension, validateTarget } from "./security";
import { recordEvent } from "./telemetry";
import { safeErrorCode } from "./failures";
import { createClaim, commitClaim } from "./claims";
import { withinDeadline } from "./deadline";
import { createOrderReadSnapshot } from "./order-storage";

const MIN_INTERVAL_SECONDS = 900;
const MAX_INTERVAL_SECONDS = 2_592_000;
const MAX_PREPAID_CHECKS = 1_000;
const WATCH_BATCH_SIZE = 25;
const WATCH_LEASE_MS = 60_000;
// Includes metadata, DNS, capture, immutable artifacts, final CAS and telemetry.
// Must expire before the original lease; expiry retains that lease as unknown.
const WATCH_CHECK_OPERATION_MS = 50_000;
const WEBHOOK_TIMEOUT_MS = 15_000;
const NOTIFICATION_OPERATION_MS = 20_000;
const WEBHOOK_LEASE_MS = 30_000;
const WEBHOOK_MAX_ATTEMPTS = 5;
const WEBHOOK_MAX_BODY_BYTES = 32_000;
const WATCH_METADATA_BYTES = 262_144;
const MAX_REGISTRATION_CAS_ATTEMPTS = 3;
const WEBHOOK_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000];

export type WatchRegistration = {
  url: string;
  checks: number;
  interval_seconds: number;
  webhook_url?: string;
  prior_proof_id?: string;
  expected?: PreflightRequest["expected"];
};

type WatchState = "active" | "exhausted" | "paused" | "expired" | "paused_margin" | "recovery_required";

export type WatchNotification = {
  schema: "delta-watch-notification/v1";
  event_id: string;
  watch_id: string;
  sequence: number;
  webhook_url: string;
  raw_body: string;
  body_hash: string;
  created_at: string;
  state: "queued" | "delivering" | "retry_wait" | "delivered" | "failed";
  attempts: number;
  next_attempt_at: string;
  attempt_timestamp?: string;
  lease_until?: string;
  last_outcome?: string;
  last_http_status?: number;
  delivered_at?: string;
};

export type WatchRecord = {
  schema: "delta-watch/v1";
  watch_id: string;
  request_hash: string;
  partner: string;
  channel: string;
  url: string;
  expected?: PreflightRequest["expected"];
  prior_proof_id?: string;
  last_proof_id?: string;
  checks_purchased: number;
  checks_remaining: number;
  checks_attempted: number;
  interval_seconds: number;
  next_check_at: string;
  state: WatchState;
  prepaid_check_price_usd: number;
  webhook_url?: string;
  webhook_secret?: string;
  lease_until?: string;
  created_at: string;
  updated_at: string;
  last_result?: Record<string, unknown>;
  // No expiry is imposed on old prepaid obligations. Enforce only an explicit
  // pre-existing deadline; changing a registration policy is a separate task.
  expires_at?: string;
  pending_notification?: WatchNotification;
};

type RegistrationResult = {
  status: number;
  body: Record<string, unknown>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function parseWatchRegistration(value: unknown): Promise<WatchRegistration> {
  if (!isPlainObject(value)) throw new Error("invalid_request_body");
  const allowed = ["url", "checks", "interval_seconds", "webhook_url", "prior_proof_id", "expected"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("unknown_request_field");
  const checks = Number(value.checks);
  if (!Number.isInteger(checks) || checks < 1 || checks > MAX_PREPAID_CHECKS) throw new Error("invalid_checks");
  const interval = Number(value.interval_seconds);
  if (!Number.isInteger(interval) || interval < MIN_INTERVAL_SECONDS || interval > MAX_INTERVAL_SECONDS) {
    throw new Error("invalid_interval_seconds");
  }
  const preflight = parsePreflightRequest({
    url: value.url,
    prior_proof_id: value.prior_proof_id,
    expected: value.expected,
  });
  const result: WatchRegistration = {
    url: preflight.url,
    checks,
    interval_seconds: interval,
    prior_proof_id: preflight.prior_proof_id,
    expected: preflight.expected,
  };
  if (value.webhook_url !== undefined) {
    const webhook = validateTarget(value.webhook_url);
    if (webhook.protocol !== "https:") throw new Error("webhook_https_required");
    await assertPublicDns(webhook.hostname);
    result.webhook_url = webhook.toString();
  }
  return result;
}

function watchKey(id: string): string {
  return `watches/${id}.json`;
}

function watchJson(record: WatchRecord): string {
  const raw = JSON.stringify(record);
  if (new TextEncoder().encode(raw).byteLength > WATCH_METADATA_BYTES) throw new Error("watch_metadata_unavailable");
  return raw;
}

function publicWatch(record: WatchRecord): Record<string, unknown> {
  return {
    watch_id: record.watch_id,
    url: record.url,
    state: record.state,
    checks_purchased: record.checks_purchased,
    checks_remaining: record.checks_remaining,
    checks_attempted: record.checks_attempted,
    interval_seconds: record.interval_seconds,
    next_check_at: record.next_check_at,
    prepaid_check_price_usd: record.prepaid_check_price_usd,
    last_proof_id: record.last_proof_id,
    last_result: record.last_result,
    created_at: record.created_at,
    updated_at: record.updated_at,
    expires_at: record.expires_at,
  };
}

async function assertPriorTarget(env: RuntimeEnv, request: WatchRegistration): Promise<void> {
  if (!request.prior_proof_id) return;
  const object = await env.PROOFS.get(`${request.prior_proof_id}/manifest.json`);
  if (!object) throw new Error("prior_proof_not_found");
  const manifest = await object.json<Pick<ProofManifest, "requested_url">>();
  if (validateTarget(manifest.requested_url).toString() !== request.url) throw new Error("prior_proof_target_mismatch");
}

type WatchRegistrationInput = {
  env: RuntimeEnv;
  request: WatchRegistration;
  requestHash: string;
  fingerprint: string;
  partner: string;
  channel: string;
  grossPaidUsd: number;
};

export async function registerWatch(input: WatchRegistrationInput): Promise<RegistrationResult> {
  try {
    // One bounded view spans every read, CAS conflict/readback and registration
    // telemetry. A late write may exist, but cannot emit 201 or start a check.
    return await withNotificationBounds(input.env, bounded => registerWatchWithinBounds({...input,env:bounded},0));
  } catch (error) {
    const reason = safeErrorCode(error);
    if (reason === 'prior_proof_not_found' || reason === 'prior_proof_target_mismatch') return {status:400,body:{error:reason}};
    return {status:503,body:{error:'watch_registration_unconfirmed',retryable:false,
      recovery_action:'retain_original_idempotency_key_and_request_for_reconciliation'}};
  }
}

async function registerWatchWithinBounds(input: WatchRegistrationInput, conflicts: number): Promise<RegistrationResult> {
  const id = uuidFromDigest(await sha256(`watch\n${input.fingerprint}`));
  const key = watchKey(id);
  const existing = await input.env.PROOFS.get(key);
  if (existing) {
    const record = await existing.json<WatchRecord>();
    if (record.request_hash !== input.requestHash || record.partner !== input.partner) {
      return { status: 409, body: { error: "idempotency_key_reused_for_different_watch" } };
    }
    return { status: 200, body: { ok: true, ...publicWatch(record), idempotent_replay: true } };
  }
  await assertPriorTarget(input.env, input.request);
  const quote = await quoteProductWithOverride(input.env, "watch_check");
  const requiredTotal = Math.ceil(quote.grossPriceUsd * input.request.checks * 1_000_000) / 1_000_000;
  if (!Number.isFinite(input.grossPaidUsd) || input.grossPaidUsd < requiredTotal) {
    return { status: 402, body: { error: "watch_prepaid_amount_below_floor", required_total_usd: requiredTotal } };
  }
  const now = new Date();
  const webhookSecret = input.request.webhook_url ? randomSecret() : undefined;
  const record: WatchRecord = {
    schema: "delta-watch/v1",
    watch_id: id,
    request_hash: input.requestHash,
    partner: sanitizeDimension(input.partner, "unknown"),
    channel: sanitizeDimension(input.channel, "partner"),
    url: input.request.url,
    expected: input.request.expected,
    prior_proof_id: input.request.prior_proof_id,
    checks_purchased: input.request.checks,
    checks_remaining: input.request.checks,
    checks_attempted: 0,
    interval_seconds: input.request.interval_seconds,
    next_check_at: new Date(now.getTime() + input.request.interval_seconds * 1_000).toISOString(),
    state: "active",
    prepaid_check_price_usd: input.grossPaidUsd / input.request.checks,
    webhook_url: input.request.webhook_url,
    webhook_secret: webhookSecret,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  const stored = await input.env.PROOFS.put(key, watchJson(record), {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  if (!stored) {
    // A timer cannot interrupt an endless chain of immediately resolved CAS
    // conflicts. Keep retries finite and never replace/delete the original key.
    if (conflicts + 1 >= MAX_REGISTRATION_CAS_ATTEMPTS) throw new Error('watch_registration_unconfirmed');
    return registerWatchWithinBounds(input,conflicts+1);
  }
  await recordEvent(input.env, {
    event: "watch_registered",
    route: "/partner/watch",
    partner: record.partner,
    channel: record.channel,
    grossUsd: input.grossPaidUsd,
    success: true,
  });
  return {
    status: 201,
    body: {
      ok: true,
      ...publicWatch(record),
      webhook_secret: webhookSecret,
      webhook_signature: webhookSecret ? "HMAC-SHA256 over <timestamp>.<raw-json-body>" : undefined,
      webhook_delivery: webhookSecret ? "At-least-once; atomically deduplicate the signed event_id before processing" : undefined,
    },
  };
}

export async function getWatch(env: RuntimeEnv, id: string, partner: string): Promise<RegistrationResult> {
  try {
    return await withNotificationBounds(env, async bounded => {
      const object = await bounded.PROOFS.get(watchKey(id));
      if (!object) return { status: 404, body: { error: "watch_not_found" } };
      const record = await object.json<WatchRecord>();
      if (record.partner !== sanitizeDimension(partner, "unknown")) return { status: 404, body: { error: "watch_not_found" } };
      let notification: Record<string, unknown> | undefined;
      if (record.webhook_url && record.checks_attempted > 0) {
        const eventId = uuidFromDigest(await sha256(`watch-event/v1\n${record.watch_id}\n${record.checks_attempted}`));
        const eventKey = notificationKey(eventId);
        const saved = await bounded.PROOFS.get(eventKey);
        const event = saved ? await saved.json<WatchNotification>() : record.pending_notification;
        if (event && (!await validNotification(event, eventKey) || event.watch_id !== record.watch_id)) throw new Error("watch_notification_invalid");
        notification = { event_id: eventId, state: event?.state ?? "unknown", attempts: event?.attempts ?? null,
          next_attempt_at: event && ["queued", "retry_wait"].includes(event.state) ? event.next_attempt_at : null,
          last_outcome: event?.last_outcome ?? null,
          recovery_action: !event || event.state === "failed" ? "receiver_reconciliation_required_no_automatic_resend" : "retain_event_id_and_original_check" };
      }
      return { status: 200, body: { ok: true, ...publicWatch(record), notification } };
    });
  } catch { return {status: 503, body: {error: "watch_evidence_unavailable", retryable: true}}; }
}

async function loadManifest(env: RuntimeEnv, proofId: string | undefined): Promise<ProofManifest | undefined> {
  if (!proofId) return undefined;
  const object = await env.PROOFS.get(`${proofId}/manifest.json`);
  return object ? object.json<ProofManifest>() : undefined;
}

function notificationKey(id: string): string { return `watch-notifications/${id}.json`; }

// Reuse Core's actual-byte metadata reader, while keeping the original R2 CAS
// authority. Cancellation fences future calls; an already submitted write may
// still commit and must be reconciled from its durable record, never erased.
async function withNotificationBounds<T>(source: RuntimeEnv, operation: (env: RuntimeEnv, signal: AbortSignal) => Promise<T>): Promise<T> {
  const view = createOrderReadSnapshot(source, WATCH_METADATA_BYTES);
  const controller = new AbortController();
  const env = { ...view.env, PROOFS: {
    get: view.env.PROOFS.get,
    put: async (key: string, value: Parameters<R2Bucket["put"]>[1], options?: R2PutOptions) => {
      view.assertActive();
      if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > WATCH_METADATA_BYTES) throw new Error("watch_metadata_unavailable");
      const result = await view.env.PROOFS.put(key, value, options);
      view.assertActive();
      return result;
    },
    list: async (options?: R2ListOptions) => {
      view.assertActive();
      const result = await source.PROOFS.list(options);
      view.assertActive();
      if (result.objects.length > WATCH_BATCH_SIZE) throw new Error("watch_metadata_unavailable");
      return result;
    },
  } as R2Bucket };
  const cancel = () => { view.cancel(); controller.abort(); };
  try { return await withinDeadline(operation(env, controller.signal), NOTIFICATION_OPERATION_MS, "notification_operation_timeout", cancel); }
  finally { cancel(); }
}

async function notificationFor(record: WatchRecord, payload: Record<string, unknown>): Promise<WatchNotification | undefined> {
  if (!record.webhook_url || !record.webhook_secret) return;
  const eventId = uuidFromDigest(await sha256(`watch-event/v1\n${record.watch_id}\n${record.checks_attempted}`));
  const createdAt = record.updated_at;
  const raw = stableJson({ ...payload, event_id: eventId, event_created_at: createdAt });
  if (new TextEncoder().encode(raw).byteLength > WEBHOOK_MAX_BODY_BYTES) throw new Error("watch_notification_too_large");
  return { schema: "delta-watch-notification/v1", event_id: eventId, watch_id: record.watch_id, sequence: record.checks_attempted,
    webhook_url: record.webhook_url, raw_body: raw, body_hash: await sha256(raw), created_at: createdAt,
    state: "queued", attempts: 0, next_attempt_at: createdAt };
}

async function validNotification(event: WatchNotification, key: string): Promise<boolean> {
  if (!event || event.schema !== "delta-watch-notification/v1" || typeof event.raw_body !== "string" ||
      new TextEncoder().encode(event.raw_body).byteLength > WEBHOOK_MAX_BODY_BYTES || event.body_hash !== await sha256(event.raw_body) ||
      !Number.isSafeInteger(event.sequence) || event.sequence < 1 || !Number.isInteger(event.attempts) || event.attempts < 0 || event.attempts > WEBHOOK_MAX_ATTEMPTS ||
      !["queued", "delivering", "retry_wait", "delivered", "failed"].includes(event.state) ||
      !Number.isFinite(Date.parse(event.created_at)) || !Number.isFinite(Date.parse(event.next_attempt_at))) return false;
  const expectedId = uuidFromDigest(await sha256(`watch-event/v1\n${event.watch_id}\n${event.sequence}`));
  if (event.event_id !== expectedId || key !== notificationKey(expectedId)) return false;
  try {
    const body = JSON.parse(event.raw_body);
    return body.event_id === event.event_id && body.watch_id === event.watch_id && body.sequence === event.sequence && body.event_created_at === event.created_at;
  } catch { return false; }
}

// The check's final CAS commits quota, baseline and this outbox atomically.
// Promotion is replayable after a crash; notification delivery owns a separate
// CAS record and never mutates checks_remaining or starts another capture.
async function materializeNotification(env: RuntimeEnv, key: string): Promise<void> {
  await withNotificationBounds(env, bounded => materializeNotificationWithinBounds(bounded, key));
}

async function materializeNotificationWithinBounds(env: RuntimeEnv, key: string): Promise<void> {
  const object = await env.PROOFS.get(key);
  if (!object) return;
  const watch = await object.json<WatchRecord>(), event = watch.pending_notification;
  if (!event) return;
  const eventKey = notificationKey(event.event_id);
  if (!await validNotification(event, eventKey) || event.watch_id !== watch.watch_id) throw new Error("watch_notification_invalid");
  const created = await createClaim(env, eventKey, event);
  if (!created) {
    const prior = await env.PROOFS.get(eventKey), saved = prior ? await prior.json<WatchNotification>() : null;
    if (!saved || !await validNotification(saved, eventKey) || saved.body_hash !== event.body_hash || saved.webhook_url !== event.webhook_url) throw new Error("watch_notification_conflict");
  }
  const next = { ...watch };
  delete next.pending_notification;
  await commitClaim(env, key, { record: watch, etag: object.etag }, next);
}

type WatchWorkOutcome = "skipped" | "completed" | "failed" | "deferred";

async function processNotification(env: RuntimeEnv, key: string): Promise<WatchWorkOutcome> {
  return withNotificationBounds(env, (bounded, signal) => processNotificationWithinBounds(bounded, key, signal));
}

async function processNotificationWithinBounds(env: RuntimeEnv, key: string, operationSignal: AbortSignal): Promise<WatchWorkOutcome> {
  const object = await env.PROOFS.get(key);
  if (!object) return "skipped";
  const event = await object.json<WatchNotification>();
  if (!await validNotification(event, key) || event.state === "failed") return "failed";
  if (event.state === "delivered") return "skipped";
  const now = Date.now();
  if (Date.parse(event.next_attempt_at) > now || (event.lease_until && Date.parse(event.lease_until) > now)) return ["retry_wait", "delivering"].includes(event.state) ? "deferred" : "skipped";
  if (event.attempts >= WEBHOOK_MAX_ATTEMPTS) {
    await commitClaim(env, key, { record: event, etag: object.etag }, { ...event, state: "failed", last_outcome: "attempts_exhausted_unknown", lease_until: undefined });
    return "failed";
  }
  const watchObject = await env.PROOFS.get(watchKey(event.watch_id));
  const watch = watchObject ? await watchObject.json<WatchRecord>() : null;
  if (!watch?.webhook_secret || watch.webhook_url !== event.webhook_url) {
    await commitClaim(env, key, { record: event, etag: object.etag }, { ...event, state: "failed", last_outcome: "destination_unavailable", lease_until: undefined });
    return "failed";
  }
  const attempt: WatchNotification = { ...event, attempts: event.attempts + 1, state: "delivering",
    attempt_timestamp: Math.floor(now / 1000).toString(), lease_until: new Date(now + WEBHOOK_LEASE_MS).toISOString(), last_outcome: "delivery_unknown" };
  const claim = await commitClaim(env, key, { record: event, etag: object.etag }, attempt);
  if (!claim) return "deferred";
  let outcome = "delivery_unknown", status: number | undefined, delivered = false, retry = true;
  const controller = new AbortController();
  if (operationSignal.aborted) throw new Error("notification_operation_timeout");
  operationSignal.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    await withinDeadline((async () => {
      const url = validateTarget(event.webhook_url);
      if (url.protocol !== "https:") throw new Error("webhook_https_required");
      await assertPublicDns(url.hostname);
      const current = await env.PROOFS.get(key);
      if (controller.signal.aborted || current?.etag !== claim.etag) throw new Error("notification_claim_lost");
      const signature = await hmacSha256(watch.webhook_secret!, `${attempt.attempt_timestamp}.${event.raw_body}`);
      if (controller.signal.aborted) throw new Error("notification_timeout");
      const response = await fetch(url, { method: "POST", redirect: "manual", signal: controller.signal,
        headers: { "content-type": "application/json", "x-delta-event-id": event.event_id,
          "x-delta-timestamp": attempt.attempt_timestamp!, "x-delta-signature": `sha256=${signature}`, "user-agent": "DELTA-Witness-Watch/0.7" }, body: event.raw_body });
      void response.body?.cancel().catch(() => {});
      if (controller.signal.aborted) throw new Error("notification_timeout");
      status = response.status;
      delivered = response.ok;
      outcome = delivered ? "delivered" : `http_${status}`;
      retry = status === 408 || status === 429 || status >= 500;
      // Redirects are terminal: never forward the signed payload to another URL.
    })(), WEBHOOK_TIMEOUT_MS, "notification_timeout", () => controller.abort());
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    outcome = ["notification_timeout", "notification_claim_lost", "private_target_not_allowed", "private_dns_target_not_allowed", "webhook_https_required", "unsafe_port_not_allowed", "userinfo_not_allowed"].includes(code) ? code : "delivery_unknown";
    retry = !["private_target_not_allowed", "private_dns_target_not_allowed", "webhook_https_required", "unsafe_port_not_allowed", "userinfo_not_allowed"].includes(outcome);
  }
  const next: WatchNotification = { ...attempt, state: delivered ? "delivered" : retry && attempt.attempts < WEBHOOK_MAX_ATTEMPTS ? "retry_wait" : "failed",
    next_attempt_at: new Date(Date.now() + (WEBHOOK_BACKOFF_MS[attempt.attempts - 1] ?? 3_600_000)).toISOString(),
    lease_until: undefined, last_outcome: outcome, last_http_status: status, ...(delivered ? { delivered_at: new Date().toISOString() } : {}) };
  const saved = await commitClaim(env, key, claim, next);
  if (saved) await recordEvent(env, { event: "watch_webhook", route: "/watch/webhook", partner: watch.partner, channel: watch.channel, success: delivered, reason: outcome });
  return !saved ? "deferred" : delivered ? "completed" : "failed";
}

async function processWatch(env: RuntimeEnv, key: string): Promise<WatchWorkOutcome> {
  const view = createOrderReadSnapshot(env, WATCH_METADATA_BYTES);
  const source = env;
  const bounded = { ...env, PROOFS: {
    get: async (name: string) => {
      const proof = /^([0-9a-f-]{36})\/(?:page\.html|page\.md|screenshot\.png|manifest\.json)$/.exec(name);
      if (proof) view.allowArtifactsFor(proof[1]);
      const object = await view.env.PROOFS.get(name);
      if (!object) return null;
      const bytes = new Uint8Array(await object.arrayBuffer());
      view.assertActive();
      return { ...object, body: new ReadableStream<Uint8Array>({start(controller) { controller.enqueue(bytes); controller.close(); }}) };
    },
    put: async (name: string, value: Parameters<R2Bucket["put"]>[1], options?: R2PutOptions) => {
      view.assertActive();
      const result = await source.PROOFS.put(name, value, options);
      view.assertActive();
      return result;
    },
  } as R2Bucket, BROWSER: {
    quickAction: async (...args: Parameters<BrowserRun["quickAction"]>) => {
      view.assertActive();
      const response = await source.BROWSER.quickAction(...args);
      try { view.assertActive(); } catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
      return response;
    },
  } as BrowserRun };
  try { return await withinDeadline(processWatchWithinBounds(bounded, key), WATCH_CHECK_OPERATION_MS, "watch_check_timeout", view.cancel); }
  finally { view.cancel(); }
}

async function processWatchWithinBounds(env: RuntimeEnv, key: string): Promise<WatchWorkOutcome> {
  await materializeNotification(env, key);
  const object = await env.PROOFS.get(key);
  if (!object) return "skipped";
  const record = await object.json<WatchRecord>();
  const nowMs = Date.now();
  if (record.schema !== "delta-watch/v1") return "failed";
  if (["recovery_required", "paused_margin"].includes(record.state)) return "deferred";
  if (record.state !== "active" || record.checks_remaining <= 0) return record.last_result?.ok === false ? "failed" : "skipped";
  if (record.pending_notification || !Number.isSafeInteger(record.checks_remaining) || !Number.isSafeInteger(record.checks_attempted) ||
      record.checks_attempted < 0 || record.checks_remaining + record.checks_attempted !== record.checks_purchased) return "deferred";
  if (record.expires_at) {
    if (!Number.isFinite(Date.parse(record.expires_at))) return "failed";
    if (Date.parse(record.expires_at) <= nowMs) {
      const expired = await commitClaim(env, key, { record, etag: object.etag }, { ...record, state: "expired", updated_at: new Date().toISOString() });
      return expired ? "skipped" : "deferred";
    }
  }
  if (Date.parse(record.next_check_at) > nowMs || (record.lease_until && Date.parse(record.lease_until) > nowMs)) return record.lease_until || record.last_result?.ok === false ? "deferred" : "skipped";
  if (record.lease_until) {
    // An expired lease proves neither cancellation nor failed artifact storage.
    // Preserve the paid sequence and quota until the prior attempt is reconciled.
    await env.PROOFS.put(key, JSON.stringify({ ...record, state: "recovery_required", updated_at: new Date().toISOString() }), {
      onlyIf: { etagMatches: object.etag }, httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    return "deferred";
  }
  // The current list price applies to new Watch purchases only. Existing prepaid
  // checks are grandfathered at their recorded unit price and are not
  // retroactively repriced merely because the owner changes today's ladder.
  const quote = await quoteProductWithOverride(env, "watch_check");
  const expectedMargin = record.prepaid_check_price_usd - quote.expectedVariableCostUsd;
  if (!Number.isFinite(record.prepaid_check_price_usd) || !Number.isFinite(quote.expectedVariableCostUsd) ||
      quote.expectedVariableCostUsd < 0 || !Number.isFinite(expectedMargin) || expectedMargin <= 0) {
    await commitClaim(env, key, { record, etag: object.etag }, { ...record, state: "paused_margin", updated_at: new Date().toISOString() });
    return "deferred";
  }
  const leased: WatchRecord = {
    ...record,
    lease_until: new Date(nowMs + WATCH_LEASE_MS).toISOString(),
    updated_at: new Date().toISOString(),
  };
  const claimed = await env.PROOFS.put(key, watchJson(leased), {
    onlyIf: { etagMatches: object.etag },
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  if (!claimed) return "deferred";

  const sequence = record.checks_attempted + 1;
  let payload: Record<string, unknown>;
  let variableCost: number | null = null;
  let margin: number | null = null;
  let browserMs: number | null = null;
  let storageBytes: number | null = null;
  try {
    const target = await resolvePublicRedirects(record.url);
    const fingerprint = await sha256(`watch\n${record.watch_id}\n${sequence}`);
    const artifacts = await capturePage({
      env,
      product: "watch_check",
      target,
      fulfillmentFingerprint: fingerprint,
      grossPriceUsd: record.prepaid_check_price_usd,
      paymentProtocol: "partner-prepaid",
      channel: record.channel,
      partner: record.partner,
    });
    await storeCapture(env, artifacts);
    const priorId = record.last_proof_id ?? record.prior_proof_id;
    const prior = await loadManifest(env, priorId);
    const request = parsePreflightRequest({ url: record.url, prior_proof_id: priorId, expected: record.expected });
    const evaluation = evaluatePreflight(request, artifacts.manifest, artifacts.markdown, prior);
    record.last_proof_id = artifacts.manifest.proof_id;
    variableCost = artifacts.manifest.execution.estimated_variable_cost_usd;
    margin = artifacts.manifest.execution.estimated_contribution_margin_usd;
    browserMs = artifacts.manifest.execution.browser_ms_used;
    storageBytes = artifacts.manifest.artifact_sizes.total_bytes;
    payload = {
      ok: true,
      watch_id: record.watch_id,
      sequence,
      safe: evaluation.safe,
      changed: evaluation.changed,
      reason: evaluation.reason,
      diff: evaluation.diff,
      proof_id: artifacts.manifest.proof_id,
      public_proof_url: `${(env.PUBLIC_ORIGIN || "").replace(/\/$/, "")}/p/${artifacts.manifest.proof_id}`,
      observed_at: artifacts.manifest.capture_completed_at,
    };
    if (margin < 0) {
      await raisePriceAfterNegativeMargin(env, "watch_check", variableCost);
      record.state = "paused_margin";
    }
  } catch (error) {
    payload = { ok: false, watch_id: record.watch_id, sequence, reason: safeErrorCode(error) };
  }
  record.checks_attempted = sequence;
  record.checks_remaining -= 1;
  if (record.checks_remaining <= 0) record.state = "exhausted";
  record.next_check_at = new Date(Date.now() + record.interval_seconds * 1_000).toISOString();
  record.updated_at = new Date().toISOString();
  record.lease_until = undefined;
  record.last_result = payload;
  record.pending_notification = await notificationFor(record, payload);
  const completed = await env.PROOFS.put(key, watchJson(record), {
    onlyIf: { etagMatches: claimed.etag }, httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  if (!completed) return "deferred";
  await recordEvent(env, {
    event: "watch_checked",
    route: "/watch/check",
    partner: record.partner,
    channel: record.channel,
    grossUsd: record.prepaid_check_price_usd,
    variableCostUsd: variableCost,
    contributionMarginUsd: margin,
    browserMs,
    storageBytes,
    success: payload.ok === true,
    reason: String(payload.reason ?? "observed"),
  });
  await materializeNotification(env, key);
  return payload.ok !== true ? "failed" : record.state === "paused_margin" ? "deferred" : "completed";
}

export type WatchRunSummary = {
  checks_selected: number; checks_settled: number; checks_rejected: number;
  checks_failed: number; checks_deferred: number;
  notifications_selected: number; notifications_settled: number; notifications_rejected: number;
  notifications_failed: number; notifications_deferred: number;
  inventory_failures: number;
};
export class WatchRunError extends Error {
  constructor(readonly summary: WatchRunSummary, cause: unknown) {
    // Preserve the existing caller's error contract. Scheduled observation never
    // emits this provider message; it records only its own sanitized category.
    super(cause instanceof Error ? cause.message : "watch_inventory_failed");
  }
}
export async function runDueWatches(env: RuntimeEnv): Promise<WatchRunSummary> {
  // Existing events do not wait on the older check inventory/capture path.
  // The after-check pass also picks up newly committed events. Independent CAS
  // claims make overlapping passes safe; neither pass can create a new check.
  const summary: WatchRunSummary = { checks_selected: 0, checks_settled: 0, checks_rejected: 0,
    checks_failed: 0, checks_deferred: 0, notifications_selected: 0, notifications_settled: 0, notifications_rejected: 0,
    notifications_failed: 0, notifications_deferred: 0, inventory_failures: 0 };
  const outcomes = await Promise.allSettled([dispatchNotifications(env, summary), runWatchChecks(env, summary)]);
  const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  if (failure) throw new WatchRunError({ ...summary }, failure.reason);
  return { ...summary };
}

async function runWatchChecks(env: RuntimeEnv, summary: WatchRunSummary): Promise<void> {
  try {
    const cursorKey = "ops/watch-list-cursor.json";
    const listed = await withNotificationBounds(env, async bounded => {
      const cursorObject = await bounded.PROOFS.get(cursorKey);
      const saved = cursorObject ? await cursorObject.json<{ cursor?: string }>() : {};
      return bounded.PROOFS.list({ prefix: "watches/", limit: WATCH_BATCH_SIZE, cursor: saved.cursor });
    });
    summary.checks_selected += listed.objects.length;
    const outcomes = await Promise.allSettled(listed.objects.map((object) => processWatch(env, object.key)));
    summary.checks_settled += outcomes.filter(value => value.status === "fulfilled").length;
    summary.checks_rejected += outcomes.filter(value => value.status === "rejected").length;
    summary.checks_failed += outcomes.filter(value => value.status === "fulfilled" && value.value === "failed").length;
    summary.checks_deferred += outcomes.filter(value => value.status === "fulfilled" && value.value === "deferred").length;
    await withNotificationBounds(env, bounded => bounded.PROOFS.put(cursorKey, JSON.stringify({ cursor: listed.truncated ? listed.cursor : undefined }), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    }));
  } catch (error) {
    summary.inventory_failures += 1;
    throw error;
  } finally {
    // A check-list or cursor-write rejection must not strand earlier events.
    await dispatchNotifications(env, summary);
  }
}

async function dispatchNotifications(env: RuntimeEnv, summary: WatchRunSummary): Promise<void> {
  // Notification dispatch has its own cursor and runs even when no Watch may
  // start a new check. A receiver must deduplicate event_id atomically because
  // a lost acknowledgement can cause the identical event to be delivered again.
  const notificationCursorKey = "ops/watch-notification-list-cursor.json";
  try {
    const notifications = await withNotificationBounds(env, async bounded => {
      const notificationCursor = await bounded.PROOFS.get(notificationCursorKey);
      const notificationSaved = notificationCursor ? await notificationCursor.json<{ cursor?: string }>() : {};
      return bounded.PROOFS.list({ prefix: "watch-notifications/", limit: WATCH_BATCH_SIZE, cursor: notificationSaved.cursor });
    });
    summary.notifications_selected += notifications.objects.length;
    const outcomes = await Promise.allSettled(notifications.objects.map((object) => processNotification(env, object.key)));
    summary.notifications_settled += outcomes.filter(value => value.status === "fulfilled").length;
    summary.notifications_rejected += outcomes.filter(value => value.status === "rejected").length;
    summary.notifications_failed += outcomes.filter(value => value.status === "fulfilled" && value.value === "failed").length;
    summary.notifications_deferred += outcomes.filter(value => value.status === "fulfilled" && value.value === "deferred").length;
    await withNotificationBounds(env, bounded => bounded.PROOFS.put(notificationCursorKey, JSON.stringify({ cursor: notifications.truncated ? notifications.cursor : undefined }), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    }));
  } catch (error) {
    summary.inventory_failures += 1;
    throw error;
  }
}
