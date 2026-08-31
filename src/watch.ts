import type { RuntimeEnv } from "./env";
import { capturePage, storeCapture, type ProofManifest } from "./capture";
import { hmacSha256, randomSecret, sha256, stableJson, uuidFromDigest } from "./crypto";
import { evaluatePreflight, parsePreflightRequest, type PreflightRequest } from "./fulfillment";
import { quoteProductWithOverride, raisePriceAfterNegativeMargin } from "./pricing";
import { assertPublicDns, resolvePublicRedirects, sanitizeDimension, validateTarget } from "./security";
import { recordEvent } from "./telemetry";

const MIN_INTERVAL_SECONDS = 900;
const MAX_INTERVAL_SECONDS = 2_592_000;
const MAX_PREPAID_CHECKS = 1_000;
const WATCH_BATCH_SIZE = 25;
const WATCH_LEASE_MS = 60_000;

export type WatchRegistration = {
  url: string;
  checks: number;
  interval_seconds: number;
  webhook_url?: string;
  prior_proof_id?: string;
  expected?: PreflightRequest["expected"];
};

type WatchState = "active" | "exhausted" | "paused_margin";

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
  };
}

async function assertPriorTarget(env: RuntimeEnv, request: WatchRegistration): Promise<void> {
  if (!request.prior_proof_id) return;
  const object = await env.PROOFS.get(`${request.prior_proof_id}/manifest.json`);
  if (!object) throw new Error("prior_proof_not_found");
  const manifest = await object.json<Pick<ProofManifest, "requested_url">>();
  if (validateTarget(manifest.requested_url).toString() !== request.url) throw new Error("prior_proof_target_mismatch");
}

export async function registerWatch(input: {
  env: RuntimeEnv;
  request: WatchRegistration;
  requestHash: string;
  fingerprint: string;
  partner: string;
  channel: string;
  grossPaidUsd: number;
}): Promise<RegistrationResult> {
  await assertPriorTarget(input.env, input.request);
  const quote = await quoteProductWithOverride(input.env, "watch_check");
  const requiredTotal = Math.ceil(quote.grossPriceUsd * input.request.checks * 1_000_000) / 1_000_000;
  if (!Number.isFinite(input.grossPaidUsd) || input.grossPaidUsd < requiredTotal) {
    return { status: 402, body: { error: "watch_prepaid_amount_below_floor", required_total_usd: requiredTotal } };
  }
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
  const stored = await input.env.PROOFS.put(key, JSON.stringify(record), {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  if (!stored) return registerWatch(input);
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
    },
  };
}

export async function getWatch(env: RuntimeEnv, id: string, partner: string): Promise<RegistrationResult> {
  const object = await env.PROOFS.get(watchKey(id));
  if (!object) return { status: 404, body: { error: "watch_not_found" } };
  const record = await object.json<WatchRecord>();
  if (record.partner !== sanitizeDimension(partner, "unknown")) return { status: 404, body: { error: "watch_not_found" } };
  return { status: 200, body: { ok: true, ...publicWatch(record) } };
}

async function loadManifest(env: RuntimeEnv, proofId: string | undefined): Promise<ProofManifest | undefined> {
  if (!proofId) return undefined;
  const object = await env.PROOFS.get(`${proofId}/manifest.json`);
  return object ? object.json<ProofManifest>() : undefined;
}

async function sendWebhook(env: RuntimeEnv, record: WatchRecord, payload: Record<string, unknown>): Promise<void> {
  if (!record.webhook_url || !record.webhook_secret) return;
  const url = validateTarget(record.webhook_url);
  await assertPublicDns(url.hostname);
  const raw = stableJson(payload);
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const signature = await hmacSha256(record.webhook_secret, `${timestamp}.${raw}`);
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      "x-delta-timestamp": timestamp,
      "x-delta-signature": `sha256=${signature}`,
      "user-agent": "DELTA-Witness-Watch/0.6",
    },
    body: raw,
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  await recordEvent(env, {
    event: "watch_webhook",
    route: "/watch/webhook",
    partner: record.partner,
    channel: record.channel,
    success: response.ok,
    reason: response.ok ? "delivered" : `http_${response.status}`,
  });
}

async function processWatch(env: RuntimeEnv, key: string): Promise<void> {
  const object = await env.PROOFS.get(key);
  if (!object) return;
  const record = await object.json<WatchRecord>();
  const nowMs = Date.now();
  if (record.schema !== "delta-watch/v1" || record.state !== "active" || record.checks_remaining <= 0) return;
  if (Date.parse(record.next_check_at) > nowMs || (record.lease_until && Date.parse(record.lease_until) > nowMs)) return;
  const quote = await quoteProductWithOverride(env, "watch_check");
  if (record.prepaid_check_price_usd < quote.grossPriceUsd) {
    record.state = "paused_margin";
    record.updated_at = new Date().toISOString();
    record.last_result = { ok: false, reason: "current_price_floor_exceeds_prepaid_check_price", required_price_usd: quote.grossPriceUsd };
    await env.PROOFS.put(key, JSON.stringify(record), {
      onlyIf: { etagMatches: object.etag },
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    return;
  }
  const leased: WatchRecord = {
    ...record,
    lease_until: new Date(nowMs + WATCH_LEASE_MS).toISOString(),
    updated_at: new Date().toISOString(),
  };
  const claimed = await env.PROOFS.put(key, JSON.stringify(leased), {
    onlyIf: { etagMatches: object.etag },
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  if (!claimed) return;

  const sequence = record.checks_attempted + 1;
  let payload: Record<string, unknown>;
  let variableCost = 0;
  let margin = record.prepaid_check_price_usd;
  let browserMs = 0;
  let storageBytes = 0;
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
    payload = { ok: false, watch_id: record.watch_id, sequence, reason: error instanceof Error ? error.message : "watch_check_failed" };
  }
  record.checks_attempted = sequence;
  record.checks_remaining -= 1;
  if (record.checks_remaining <= 0) record.state = "exhausted";
  record.next_check_at = new Date(Date.now() + record.interval_seconds * 1_000).toISOString();
  record.updated_at = new Date().toISOString();
  record.lease_until = undefined;
  record.last_result = payload;
  await env.PROOFS.put(key, JSON.stringify(record), { httpMetadata: { contentType: "application/json; charset=utf-8" } });
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
  try {
    await sendWebhook(env, record, payload);
  } catch (error) {
    await recordEvent(env, {
      event: "watch_webhook",
      route: "/watch/webhook",
      partner: record.partner,
      channel: record.channel,
      success: false,
      reason: error instanceof Error ? error.message : "webhook_failed",
    });
  }
}

export async function runDueWatches(env: RuntimeEnv): Promise<void> {
  const cursorKey = "ops/watch-list-cursor.json";
  const cursorObject = await env.PROOFS.get(cursorKey);
  const saved = cursorObject ? await cursorObject.json<{ cursor?: string }>() : {};
  const listed = await env.PROOFS.list({ prefix: "watches/", limit: WATCH_BATCH_SIZE, cursor: saved.cursor });
  await Promise.allSettled(listed.objects.map((object) => processWatch(env, object.key)));
  await env.PROOFS.put(cursorKey, JSON.stringify({ cursor: listed.truncated ? listed.cursor : undefined }), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}
