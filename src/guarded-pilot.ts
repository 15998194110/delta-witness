import type { Context, Next } from "hono";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  paymentIdentifierResourceServerExtension,
} from "@x402/extensions/payment-identifier";
import type { RuntimeEnv } from "./env";
import { sha256, stableJson, uuidFromDigest } from "./crypto";
import {
  getPaymentHeader,
  readJsonRequestBounded,
  referrerChannel,
  resolvePublicRedirects,
  validateTarget,
  type RedirectResolution,
} from "./security";
import { capturePage, readStoredCapture, storeCapture, MAX_BROWSER_MS, MAX_TOTAL_ARTIFACT_BYTES, type CaptureArtifacts } from "./capture";
import { evaluatePreflight, parsePreflightRequest, type PreflightRequest } from "./fulfillment";
import { estimateVariableCost } from "./pricing";
import { recordEvent } from "./telemetry";
import { GUARDED_ACTION_PILOT_INPUT_SCHEMA, GUARDED_ACTION_PILOT_OUTPUT_SCHEMA } from "./discovery";
import { mirrorX402ChallengeBody } from "./x402-compat";
import { guardedFacilitator, readSettlement, settlementBlockedBody, validatePaymentBinding } from "./settlement";
import { captureFailure, safeErrorCode, MAX_FULFILLMENT_ATTEMPTS } from "./failures";
import { commitClaim, createClaim, lostClaimBody } from "./claims";
import { withinDeadline } from "./deadline";
import { createOrderReadSnapshot } from "./order-storage";

export const GUARDED_ACTION_PILOT_PRICE_USD = 10;
const PILOT_ROUTE = "/v1/guarded-action-pilot";
const MAX_PILOT_BODY_BYTES = 16_384;
const PROCESSING_LEASE_MS = 90_000;
export const PILOT_DEADLINE_MS = 90_000;
export const MAX_PILOT_BROWSER_CALLS = 3;
export const MAX_PILOT_TOTAL_BYTES = 3 * MAX_TOTAL_ARTIFACT_BYTES;

export type GuardedPilotInput = {
  urls: string[];
  preflight?: {
    url_index: number;
    expected: NonNullable<PreflightRequest["expected"]>;
  };
};

type PilotProof = {
  url: string;
  proof_id: string;
  manifest_url: string;
  public_proof_url: string;
  bundle_root: string;
  observed_at: string;
  allocated_price_usd: number;
};

type PilotResponse = {
  ok: true;
  product: "guarded_action_pilot";
  price_usd: 10;
  proofs: PilotProof[];
  preflight?: {
    url_index: number;
    url: string;
    safe: boolean | null;
    changed: boolean | null;
    reason: string;
    diff: Record<string, unknown>;
  };
  economics: {
    variable_cost_usd: number;
    contribution_margin_usd: number;
    basis?: "sum_of_proof_cost_models_not_actual_total";
  };
  idempotent_replay?: boolean;
};

type PilotRecord = {
  schema: "delta-guarded-action-pilot/v1";
  state: "processing" | "retryable_failure" | "blocked_failure" | "complete";
  route: typeof PILOT_ROUTE;
  request_hash: string;
  payment_fingerprint: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  error?: string;
  response?: PilotResponse;
  response_hash?: string;
  progress?: PilotProgress;
};

type PilotObservation = {
  proof: PilotProof;
  preflight?: PilotResponse["preflight"];
  browser_ms: number | null;
  storage_bytes: number;
  variable_cost_usd: number;
};
type PilotPage = {
  index: number; url: string; fingerprint: string;
  phase: "pending" | "observing" | "observed" | "complete" | "retryable_failure" | "blocked_failure" | "unknown";
  attempts: number;
  observation?: PilotObservation;
  observation_hash?: string;
  error?: string;
};
type PilotProgress = {
  schema: "delta-pilot-progress/v1";
  browser_calls_reserved: number;
  conservative_cost_reserved_usd: number;
  pages: PilotPage[];
};

type StoredPilotRecord = { record: PilotRecord; etag: string };

function allocatedPrice(length: number, index: number): number {
  const unit = Math.floor((GUARDED_ACTION_PILOT_PRICE_USD / length) * 1_000_000) / 1_000_000;
  return index === length - 1 ? GUARDED_ACTION_PILOT_PRICE_USD - unit * (length - 1) : unit;
}
async function pageFingerprint(record: PilotRecord, index: number): Promise<string> {
  return sha256(`${record.payment_fingerprint}\n${record.request_hash}\n${index}`);
}
async function observationHash(record: PilotRecord, page: PilotPage): Promise<string> {
  return sha256(`delta-pilot-page/v1\n${stableJson({ request_hash: record.request_hash, payment_fingerprint: record.payment_fingerprint,
    index: page.index, url: page.url, fingerprint: page.fingerprint, observation: page.observation })}`);
}
async function responseHash(record: PilotRecord, response: PilotResponse): Promise<string> {
  return sha256(`delta-pilot-response/v1\n${stableJson({ request_hash: record.request_hash, payment_fingerprint: record.payment_fingerprint, response })}`);
}
async function initialProgress(record: PilotRecord, body: GuardedPilotInput): Promise<PilotProgress> {
  return { schema: "delta-pilot-progress/v1", browser_calls_reserved: 0, conservative_cost_reserved_usd: 0,
    pages: await Promise.all(body.urls.map(async (url, index) => ({ index, url, fingerprint: await pageFingerprint(record, index), phase: "pending", attempts: 0 }))) };
}
async function validateProgress(record: PilotRecord, body: GuardedPilotInput): Promise<void> {
  const progress = record.progress;
  if (!progress || progress.schema !== "delta-pilot-progress/v1" || progress.pages.length !== body.urls.length ||
      !Number.isInteger(progress.browser_calls_reserved) || progress.browser_calls_reserved < 0 || progress.browser_calls_reserved > MAX_PILOT_BROWSER_CALLS ||
      !Number.isFinite(progress.conservative_cost_reserved_usd) || progress.conservative_cost_reserved_usd < 0 || progress.conservative_cost_reserved_usd >= 10) throw new Error("invalid_pilot_record");
  let calls = 0;
  for (const [index, page] of progress.pages.entries()) {
    if (page.index !== index || page.url !== body.urls[index] || page.fingerprint !== await pageFingerprint(record, index) ||
      !Number.isInteger(page.attempts) || page.attempts < 0 || page.attempts > MAX_FULFILLMENT_ATTEMPTS ||
      !["pending", "observing", "observed", "complete", "retryable_failure", "blocked_failure", "unknown"].includes(page.phase)) throw new Error("invalid_pilot_record");
    calls += page.attempts;
    if (page.phase === "pending" && page.attempts !== 0 || page.phase !== "pending" && page.attempts === 0 ||
      page.observation && !["observed", "complete"].includes(page.phase) ||
      page.phase === "retryable_failure" && !/^capture_upstream_(408|429|5[0-9]{2})$/.test(page.error ?? "")) throw new Error("invalid_pilot_record");
    if (["observed", "complete"].includes(page.phase) && (!page.observation || page.observation_hash !== await observationHash(record, page))) throw new Error("invalid_pilot_record");
    if (page.observation && (page.observation_hash !== await observationHash(record, page) || !Number.isSafeInteger(page.observation.storage_bytes) ||
      page.observation.storage_bytes <= 0 || page.observation.storage_bytes > MAX_TOTAL_ARTIFACT_BYTES)) throw new Error("invalid_pilot_record");
  }
  if (calls !== progress.browser_calls_reserved) throw new Error("invalid_pilot_record");
}
async function verifyPage(env: RuntimeEnv, record: PilotRecord, page: PilotPage, body: GuardedPilotInput): Promise<boolean> {
  if (!page.observation || page.observation_hash !== await observationHash(record, page)) return false;
  const price = allocatedPrice(body.urls.length, page.index);
  const artifacts = await readStoredCapture({ env, fulfillmentFingerprint: page.fingerprint, product: "capture", requestedUrl: page.url,
    grossPriceUsd: price, paymentProtocol: "x402-v2-upfront" });
  const observation = page.observation, proof = observation.proof;
  return Boolean(artifacts && proof.url === page.url && proof.allocated_price_usd === price && proof.proof_id === artifacts.manifest.proof_id &&
    proof.bundle_root === artifacts.manifest.hashes.bundle_root && proof.observed_at === artifacts.manifest.capture_completed_at &&
    observation.storage_bytes === artifacts.manifest.artifact_sizes.total_bytes && observation.browser_ms === artifacts.manifest.execution.browser_ms_used &&
    observation.variable_cost_usd === artifacts.manifest.execution.estimated_variable_cost_usd);
}
function aggregateResponse(record: PilotRecord): PilotResponse {
  const observations = record.progress!.pages.map(page => page.observation!);
  const cost = observations.reduce((sum, value) => sum + value.variable_cost_usd, 0);
  return { ok: true, product: "guarded_action_pilot", price_usd: 10, proofs: observations.map(value => value.proof),
    preflight: observations.find(value => value.preflight)?.preflight,
    economics: { variable_cost_usd: cost, contribution_margin_usd: GUARDED_ACTION_PILOT_PRICE_USD - cost,
      basis: "sum_of_proof_cost_models_not_actual_total" } };
}
function partialBody(record: PilotRecord, state: string, retryable: boolean) {
  return { ok: false, state, retryable, payment_will_not_be_charged_again: true,
    completed_pages: record.progress?.pages.filter(page => page.phase === "complete").length ?? 0,
    pages: record.progress?.pages.map(page => ({ index: page.index, phase: page.phase })) };
}

// Reconcile original page drafts only. Missing/partial artifacts and observing
// outcomes never become permission to capture again.
async function reconcilePages(env: RuntimeEnv, key: string, stored: StoredPilotRecord, body: GuardedPilotInput): Promise<StoredPilotRecord | null> {
  await validateProgress(stored.record, body);
  let current = stored;
  for (const [index, page] of current.record.progress!.pages.entries()) {
    if (!["observed", "complete"].includes(page.phase)) continue;
    if (!await verifyPage(env, current.record, page, body)) throw new Error("invalid_pilot_record");
    if (page.phase === "observed") {
      const pages = current.record.progress!.pages.map((value, offset) => offset === index ? { ...value, phase: "complete" as const } : value);
      const next = await commitClaim(env, key, current, { ...current.record, progress: { ...current.record.progress!, pages } });
      if (!next) return null;
      current = next;
    }
  }
  return current;
}

async function withPilotReads<T>(env: RuntimeEnv, record: PilotRecord, operation: (bounded: RuntimeEnv) => Promise<T>): Promise<T> {
  const snapshot = createOrderReadSnapshot(env);
  try {
    for (const page of record.progress?.pages ?? []) snapshot.allowArtifactsFor(uuidFromDigest(await sha256(`${page.fingerprint}\ncapture`)));
    return await withinDeadline(operation(snapshot.env), 15_000, "pilot_evidence_timeout", snapshot.cancel);
  } finally { snapshot.cancel(); }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("unknown_request_field");
}

export function parseGuardedPilotInput(value: unknown): GuardedPilotInput {
  if (!isPlainObject(value)) throw new Error("invalid_request_body");
  assertOnlyKeys(value, ["urls", "preflight"]);
  if (!Array.isArray(value.urls) || value.urls.length < 1 || value.urls.length > 3) throw new Error("invalid_urls");
  const urls = value.urls.map((item) => {
    if (typeof item !== "string") throw new Error("invalid_urls");
    const parsed = validateTarget(item);
    if (parsed.protocol !== "https:") throw new Error("pilot_requires_https");
    return parsed.toString();
  });
  const result: GuardedPilotInput = { urls };
  if (value.preflight !== undefined) {
    if (!isPlainObject(value.preflight)) throw new Error("invalid_preflight");
    assertOnlyKeys(value.preflight, ["url_index", "expected"]);
    const index = value.preflight.url_index;
    if (!Number.isInteger(index) || Number(index) < 0 || Number(index) >= urls.length) throw new Error("invalid_preflight_url_index");
    const parsed = parsePreflightRequest({ url: urls[Number(index)], expected: value.preflight.expected });
    if (!parsed.expected) throw new Error("empty_expected");
    result.preflight = { url_index: Number(index), expected: parsed.expected };
  }
  return result;
}

export function guardedPilotEconomics(env: RuntimeEnv): Record<string, number | string> {
  const expectedVariableCostUsd = estimateVariableCost(env, 75_000, 27_000_000, 15);
  return {
    product: "guarded_action_pilot",
    grossPriceUsd: GUARDED_ACTION_PILOT_PRICE_USD,
    expectedVariableCostUsd,
    estimatedContributionMarginUsd: GUARDED_ACTION_PILOT_PRICE_USD - expectedVariableCostUsd,
    maxUrls: 3,
  };
}

function pilotRecordKey(fingerprint: string): string {
  return `guarded-pilot/${fingerprint.replace(/^sha256:/, "")}.json`;
}

async function readPilotRecord(env: RuntimeEnv, key: string): Promise<StoredPilotRecord | null> {
  const object = await env.PROOFS.get(key);
  if (!object) return null;
  if (!Number.isSafeInteger(object.size) || object.size > 32_000) throw new Error("invalid_pilot_record");
  const record = await object.json<PilotRecord>();
  if (record.schema !== "delta-guarded-action-pilot/v1") throw new Error("invalid_pilot_record");
  return { record, etag: object.etag };
}

async function recoverPilot(env: RuntimeEnv, key: string, stored: StoredPilotRecord, body: GuardedPilotInput, fingerprint: string): Promise<PilotResponse | null> {
  const { record } = stored;
  const response = record.response;
  if (record.state !== "processing" || record.payment_fingerprint !== fingerprint || record.route !== PILOT_ROUTE || !response || response.ok !== true || response.product !== "guarded_action_pilot" || response.price_usd !== 10 || !Array.isArray(response.proofs) || response.proofs.length !== body.urls.length) return null;
  const unit = Math.floor((GUARDED_ACTION_PILOT_PRICE_USD / body.urls.length) * 1_000_000) / 1_000_000;
  for (let index = 0; index < body.urls.length; index++) {
    const price = index === body.urls.length - 1 ? GUARDED_ACTION_PILOT_PRICE_USD - unit * (body.urls.length - 1) : unit;
    const artifacts = await readStoredCapture({ env, fulfillmentFingerprint: await sha256(`${record.payment_fingerprint}\n${record.request_hash}\n${index}`),
      product: "capture", requestedUrl: body.urls[index], grossPriceUsd: price, paymentProtocol: "x402-v2-upfront" });
    const proof = response.proofs[index];
    if (!artifacts || proof.url !== body.urls[index] || proof.allocated_price_usd !== price || proof.proof_id !== artifacts.manifest.proof_id ||
      proof.bundle_root !== artifacts.manifest.hashes.bundle_root || proof.observed_at !== artifacts.manifest.capture_completed_at) return null;
  }
  const completed = await commitClaim(env, key, stored, { ...record, state: "complete", updated_at: new Date().toISOString() });
  return completed ? response : null;
}

function isProcessingFresh(record: PilotRecord): boolean {
  return record.state === "processing" && Date.now() - Date.parse(record.updated_at) < PROCESSING_LEASE_MS;
}

function noStore(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

export async function guardedPilotPrevalidate(c: Context<any>, next: Next): Promise<Response | void> {
  if (c.req.method !== "POST") return next();
  const payment = getPaymentHeader(c.req.raw);
  const channel = referrerChannel(c.req.raw);
  c.set("pilotChannel", channel);
  c.set("pilotReplayAuthorized", false);
  if (!payment) return next();
  try {
    const raw = await readJsonRequestBounded(c.req.raw, MAX_PILOT_BODY_BYTES);
    const body = parseGuardedPilotInput(raw);
    const requestHash = await sha256(`${PILOT_ROUTE}\n${stableJson(body)}`);
    const paymentFingerprint = await sha256(payment);
    const key = pilotRecordKey(paymentFingerprint);
    c.set("pilotBody", body);
    c.set("pilotRequestHash", requestHash);
    c.set("pilotPaymentFingerprint", paymentFingerprint);
    c.set("pilotRecordKey", key);
    await recordEvent(c.env as RuntimeEnv, {
      event: "qualified_request",
      route: PILOT_ROUTE,
      channel,
      grossUsd: GUARDED_ACTION_PILOT_PRICE_USD,
      success: true,
    });
    let stored = await readPilotRecord(c.env as RuntimeEnv, key);
    if (!stored) {
      const settlement = await readSettlement(c.env as RuntimeEnv, payment);
      validatePaymentBinding(c.env as RuntimeEnv, payment, `${((c.env as RuntimeEnv).PUBLIC_ORIGIN || "https://delta-witness-api.ruphussten.workers.dev").replace(/\/+$/, "")}${PILOT_ROUTE}`, settlement?.amount ?? "10000000");
      if (settlement) {
        if (settlement.request_hash !== requestHash || settlement.payment_fingerprint !== paymentFingerprint) return noStore(c.json(settlementBlockedBody("settlement_identity_conflict"), 409));
        if (settlement.state !== "settlement_confirmed") return noStore(c.json(settlementBlockedBody(settlement.state), 503));
        c.set("pilotReplayAuthorized", true);
      }
      c.set("pilotTargets", await Promise.all(body.urls.map((url) => resolvePublicRedirects(url))));
      return next();
    }
    if (stored.record.request_hash !== requestHash) return c.json({ error: "payment_already_used_for_different_request" }, 409);
    if (stored.record.progress) {
      if (stored.record.state === "blocked_failure") return noStore(c.json(partialBody(stored.record, "blocked_failure", false), 503));
      let reconciled: StoredPilotRecord | null;
      try { reconciled = await withPilotReads(c.env as RuntimeEnv, stored.record, env => reconcilePages(env, key, stored!, body)); }
      catch { return noStore(c.json(partialBody(stored.record, "fulfillment_unknown", false), 503)); }
      if (!reconciled) return noStore(c.json(lostClaimBody(), 503));
      stored = reconciled;
      if (stored.record.progress!.pages.every(page => page.phase === "complete")) {
        const response = aggregateResponse(stored.record);
        if (stored.record.response && (stored.record.response_hash !== await responseHash(stored.record, stored.record.response) || stableJson(response) !== stableJson(stored.record.response))) {
          return noStore(c.json(partialBody(stored.record, "fulfillment_unknown", false), 503));
        }
        if (stored.record.state !== "complete") {
          let completed: StoredPilotRecord | null;
          try { completed = await withinDeadline(commitClaim(c.env as RuntimeEnv, key, stored, { ...stored.record, state: "complete", response,
            response_hash: await responseHash(stored.record, response), updated_at: new Date().toISOString() }), 15_000, "pilot_evidence_timeout"); }
          catch { return noStore(c.json(partialBody(stored.record, "fulfillment_unknown", false), 503)); }
          if (!completed) return noStore(c.json(lostClaimBody(), 503));
        }
        return noStore(c.json({ ...response, idempotent_replay: true }));
      }
      if (stored.record.state === "complete") return noStore(c.json(partialBody(stored.record, "fulfillment_unknown", false), 503));
      if (stored.record.progress!.pages.some(page => ["observing", "unknown", "blocked_failure"].includes(page.phase))) {
        const live = !stored.record.progress!.pages.some(page => ["unknown", "blocked_failure"].includes(page.phase)) && isProcessingFresh(stored.record);
        return noStore(c.json(partialBody(stored.record, live ? "processing" : "fulfillment_unknown", false), live ? 202 : 503));
      }
    }
    if (stored.record.state === "complete" && stored.record.response) {
      await recordEvent(c.env as RuntimeEnv, { event: "repeat_call", route: PILOT_ROUTE, channel, success: true });
      return noStore(c.json({ ...stored.record.response, idempotent_replay: true }));
    }
    const recovered = await recoverPilot(c.env as RuntimeEnv, key, stored, body, paymentFingerprint);
    if (recovered) return noStore(c.json({ ...recovered, idempotent_replay: true }));
    if (stored.record.state === "blocked_failure" || stored.record.attempts >= MAX_FULFILLMENT_ATTEMPTS) return noStore(c.json({ ok: false, state: "blocked_failure", error: "fulfillment_requires_review", retryable: false }, 503));
    if (isProcessingFresh(stored.record)) {
      c.header("retry-after", "5");
      return c.json({ ok: false, state: "processing", retryable: true }, 202);
    }
    if (stored.record.state === "processing" && !stored.record.progress) return noStore(c.json({ ok: false, state: "fulfillment_unknown", retryable: false, requires_fulfillment_reconciliation: true }, 503));
    if (!stored.record.progress && stored.record.state === "retryable_failure" && !/^capture_upstream_(408|429|5[0-9]{2})$/.test(stored.record.error ?? "")) {
      return noStore(c.json(partialBody(stored.record, "fulfillment_unknown", false), 503));
    }
    c.set("pilotTargets", await Promise.all(body.urls.map((url, index) => stored!.record.progress?.pages[index].phase === "complete" ? undefined : resolvePublicRedirects(url))));
    const claimed: PilotRecord = {
      ...stored.record,
      state: "processing",
      attempts: stored.record.attempts + 1,
      updated_at: new Date().toISOString(),
      error: undefined,
    };
    const result = await commitClaim(c.env as RuntimeEnv, key, stored, claimed);
    if (!result) {
      c.header("retry-after", "5");
      return c.json({ ok: false, state: "processing", retryable: true }, 202);
    }
    c.set("pilotRecord", result);
    c.set("pilotReplayAuthorized", true);
    await recordEvent(c.env as RuntimeEnv, { event: "repeat_call", route: PILOT_ROUTE, channel, success: true });
    return next();
  } catch (error) {
    const reason = safeErrorCode(error);
    const status = reason === "request_too_large" || reason === "body_too_large" ? 413 : 400;
    return c.json({ error: reason }, status);
  }
}

export async function guardedPilotProtect(c: Context<any>, next: Next): Promise<Response | void> {
  if (c.get("pilotReplayAuthorized")) return next();
  const env = c.env as RuntimeEnv;
  const facilitator = guardedFacilitator(env, c.get("pilotRequestHash"), c.get("pilotPaymentFingerprint") ?? "");
  const server = new x402ResourceServer(facilitator.client);
  registerExactEvmScheme(server);
  server.registerExtension(bazaarResourceServerExtension);
  server.registerExtension(paymentIdentifierResourceServerExtension);
  const middleware = paymentMiddleware(
    {
      [`POST ${PILOT_ROUTE}`]: {
        accepts: [{
          scheme: "exact",
          price: "$10",
          network: env.NETWORK as `eip155:${string}`,
          payTo: env.PAY_TO,
          maxTimeoutSeconds: 300,
          extra: { paymentFlow: "upfront" },
        }],
        resource: `${(env.PUBLIC_ORIGIN || "https://delta-witness-api.ruphussten.workers.dev").replace(/\/+$/, "")}${PILOT_ROUTE}`,
        description: "One $10 guarded-action pilot: capture 1-3 public URLs as page-state evidence and optionally run one deterministic preflight check before a browser, shopping, procurement, coding, or workflow action.",
        mimeType: "application/json",
        serviceName: "delta-witness",
        tags: [
          "guarded-action-pilot",
          "browser-agent-pilot",
          "page-state-evidence-bundle",
          "preflight-verification",
          "shopping",
          "procurement",
          "workflow-safety",
        ],
        extensions: {
          ...declareDiscoveryExtension({
            bodyType: "json",
            input: { urls: ["https://example.com"], preflight: { url_index: 0, expected: { contains: ["Example Domain"] } } },
            inputSchema: GUARDED_ACTION_PILOT_INPUT_SCHEMA,
            output: {
              example: {
                ok: true,
                product: "guarded_action_pilot",
                price_usd: 10,
                proofs: [{
                  url: "https://example.com/",
                  proof_id: "7d9d12f7-8f91-5f41-9f0c-5ef257d9ea5d",
                  manifest_url: "https://delta-witness-api.ruphussten.workers.dev/v1/proofs/7d9d12f7-8f91-5f41-9f0c-5ef257d9ea5d",
                  public_proof_url: "https://delta-witness-api.ruphussten.workers.dev/p/7d9d12f7-8f91-5f41-9f0c-5ef257d9ea5d",
                  bundle_root: `sha256:${"0".repeat(64)}`,
                  observed_at: "2026-09-07T00:00:00.000Z",
                  allocated_price_usd: 10,
                }],
                economics: { variable_cost_usd: 0.004, contribution_margin_usd: 9.996, basis: "sum_of_proof_cost_models_not_actual_total" },
              },
              schema: GUARDED_ACTION_PILOT_OUTPUT_SCHEMA,
            },
          }),
          [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false),
        },
        unpaidResponseBody: () => ({
          contentType: "application/json",
          body: {
            error: "payment_required",
            product: "guarded_action_pilot",
            price_usd: GUARDED_ACTION_PILOT_PRICE_USD,
            network: env.NETWORK,
            asset: "USDC",
            payment_flow: "upfront",
            max_urls: 3,
          },
        }),
      },
    },
    server,
  );
  const middlewareResponse = await middleware(c, next);
  if (facilitator.blocked()) return noStore(c.json(settlementBlockedBody(facilitator.blocked()!), 503));
  if (middlewareResponse instanceof Response) c.res = middlewareResponse;
  if (c.res.status === 402) {
    c.res = mirrorX402ChallengeBody(c.res, {
      error: "payment_required",
      product: "guarded_action_pilot",
      price_usd: GUARDED_ACTION_PILOT_PRICE_USD,
      payment_flow: "upfront",
      max_urls: 3,
    });
    await recordEvent(env, {
      event: "payment_required",
      route: PILOT_ROUTE,
      channel: c.get("pilotChannel") || referrerChannel(c.req.raw),
      grossUsd: GUARDED_ACTION_PILOT_PRICE_USD,
      success: false,
    });
  }
  return c.res;
}

export async function guardedPilotHandler(c: Context<any>): Promise<Response> {
  const env = c.env as RuntimeEnv;
  const body = c.get("pilotBody") as GuardedPilotInput | undefined;
  const targets = c.get("pilotTargets") as Array<RedirectResolution | undefined> | undefined;
  const requestHash = c.get("pilotRequestHash") as string | undefined;
  const paymentFingerprint = c.get("pilotPaymentFingerprint") as string | undefined;
  const key = c.get("pilotRecordKey") as string | undefined;
  const channel = (c.get("pilotChannel") as string | undefined) || referrerChannel(c.req.raw);
  if (!body || !targets || !requestHash || !paymentFingerprint || !key) return c.json({ error: "settled_payment_identity_missing" }, 500);

  const snapshot = createOrderReadSnapshot(env);
  const bounded = snapshot.env;
  let claim = c.get("pilotRecord") as StoredPilotRecord | undefined;
  const firstAttempt = !claim;
  const origin = (env.PUBLIC_ORIGIN || "https://delta-witness-api.ruphussten.workers.dev").replace(/\/+$/, "");
  const reserveCost = estimateVariableCost(env, MAX_BROWSER_MS, MAX_TOTAL_ARTIFACT_BYTES, 8);
  const save = async (record: PilotRecord): Promise<boolean> => {
    snapshot.assertActive();
    const saved = await commitClaim(bounded, key, claim!, record);
    snapshot.assertActive();
    if (saved) claim = saved;
    return Boolean(saved);
  };
  try {
    return await withinDeadline((async () => {
      if (!claim) {
        const now = new Date().toISOString();
        const initial: PilotRecord = { schema: "delta-guarded-action-pilot/v1", state: "processing", route: PILOT_ROUTE,
          request_hash: requestHash, payment_fingerprint: paymentFingerprint, attempts: 1, created_at: now, updated_at: now };
        initial.progress = await initialProgress(initial, body);
        const created = await createClaim(bounded, key, initial);
        snapshot.assertActive();
        if (!created) return noStore(c.json(partialBody(initial, "processing", false), 202));
        claim = created;
      }
      if (!claim.record.progress) {
        // A legacy confirmed first-page failure has no earlier successful pages.
        // Preserve its already consumed attempt allowance when introducing phases.
        const progress = await initialProgress(claim.record, body);
        const consumed = Math.max(0, claim.record.attempts - 1);
        progress.browser_calls_reserved = consumed;
        progress.conservative_cost_reserved_usd = consumed * reserveCost;
        progress.pages[0].attempts = consumed;
        if (consumed > 0) { progress.pages[0].phase = "retryable_failure"; progress.pages[0].error = claim.record.error; }
        if (!await save({ ...claim.record, progress })) return noStore(c.json(lostClaimBody(), 503));
      }
      await validateProgress(claim.record, body);
      for (const page of claim.record.progress!.pages) snapshot.allowArtifactsFor(uuidFromDigest(await sha256(`${page.fingerprint}\ncapture`)));
      if (firstAttempt) await recordEvent(env, { event: "payment_verified", route: PILOT_ROUTE, channel, grossUsd: 10, success: true });
      await recordEvent(env, { event: "capture_started", route: PILOT_ROUTE, channel, success: true });
      for (let index = 0; index < body.urls.length; index++) {
        snapshot.assertActive();
        let record = claim!.record, progress = record.progress!, page = progress.pages[index];
        if (page.phase === "complete") {
          if (!await verifyPage(bounded, record, page, body)) return noStore(c.json(partialBody(record, "fulfillment_unknown", false), 503));
          continue;
        }
        if (!["pending", "retryable_failure"].includes(page.phase) || !targets[index]) return noStore(c.json(partialBody(record, "fulfillment_unknown", false), 503));
        if (progress.browser_calls_reserved >= MAX_PILOT_BROWSER_CALLS || page.attempts >= MAX_FULFILLMENT_ATTEMPTS ||
            !Number.isFinite(reserveCost) || progress.conservative_cost_reserved_usd + reserveCost >= GUARDED_ACTION_PILOT_PRICE_USD) {
          await save({ ...record, state: "blocked_failure", error: "pilot_budget_exhausted", updated_at: new Date().toISOString() });
          return noStore(c.json(partialBody(claim!.record, "blocked_failure", false), 503));
        }
        page = { ...page, phase: "observing", attempts: page.attempts + 1, error: undefined };
        progress = { ...progress, browser_calls_reserved: progress.browser_calls_reserved + 1,
          conservative_cost_reserved_usd: progress.conservative_cost_reserved_usd + reserveCost,
          pages: progress.pages.map((value, offset) => offset === index ? page : value) };
        if (!await save({ ...record, progress, updated_at: new Date().toISOString() })) return noStore(c.json(lostClaimBody(), 503));
        let artifacts: CaptureArtifacts;
        try {
          artifacts = await capturePage({ env: bounded, product: "capture", target: targets[index]!, fulfillmentFingerprint: page.fingerprint,
            grossPriceUsd: allocatedPrice(body.urls.length, index), paymentProtocol: "x402-v2-upfront", channel });
          snapshot.assertActive();
        } catch (error) {
          snapshot.assertActive();
          const { reason } = captureFailure(error);
          const status = /^capture_upstream_([0-9]{3})$/.exec(reason)?.[1];
          const confirmedFailure = status !== undefined;
          const retryable = confirmedFailure && ([408, 429].includes(Number(status)) || Number(status) >= 500) &&
            claim!.record.attempts < MAX_FULFILLMENT_ATTEMPTS && claim!.record.progress!.browser_calls_reserved < MAX_PILOT_BROWSER_CALLS;
          const phase = retryable ? "retryable_failure" : confirmedFailure ? "blocked_failure" : "unknown";
          const pages = claim!.record.progress!.pages.map((value, offset) => offset === index ? { ...value, phase, error: reason } as PilotPage : value);
          const failed: PilotRecord = { ...claim!.record, progress: { ...claim!.record.progress!, pages },
            state: retryable ? "retryable_failure" : confirmedFailure ? "blocked_failure" : "processing", error: reason, updated_at: new Date().toISOString() };
          if (!await save(failed)) return noStore(c.json(lostClaimBody(), 503));
          await recordEvent(env, { event: "capture_failed", route: PILOT_ROUTE, channel, grossUsd: 10, success: false, reason });
          return noStore(c.json({ ...partialBody(failed, retryable ? "partial_failure" : confirmedFailure ? "blocked_failure" : "fulfillment_unknown", retryable),
            error: "guarded_action_pilot_failed", reason }, retryable ? 502 : 503));
        }
        const proof: PilotProof = { url: page.url, proof_id: artifacts.manifest.proof_id,
          manifest_url: `${origin}/v1/proofs/${artifacts.manifest.proof_id}`, public_proof_url: `${origin}/p/${artifacts.manifest.proof_id}`,
          bundle_root: artifacts.manifest.hashes.bundle_root, observed_at: artifacts.manifest.capture_completed_at,
          allocated_price_usd: allocatedPrice(body.urls.length, index) };
        const execution = artifacts.manifest.execution;
        const observation: PilotObservation = { proof, browser_ms: execution.browser_ms_used,
          storage_bytes: artifacts.manifest.artifact_sizes.total_bytes, variable_cost_usd: execution.estimated_variable_cost_usd };
        if (body.preflight?.url_index === index) {
          const evaluated = evaluatePreflight({ url: page.url, expected: body.preflight.expected }, artifacts.manifest, artifacts.markdown);
          observation.preflight = { url_index: index, url: page.url, ...evaluated };
        }
        page = { ...page, phase: "observed", observation };
        page.observation_hash = await observationHash(claim!.record, page);
        const pages = claim!.record.progress!.pages.map((value, offset) => offset === index ? page : value);
        if (pages.reduce((total, value) => total + (value.observation?.storage_bytes ?? 0), 0) > MAX_PILOT_TOTAL_BYTES) throw new Error("pilot_budget_exhausted");
        if (!await save({ ...claim!.record, progress: { ...claim!.record.progress!, pages } })) return noStore(c.json(lostClaimBody(), 503));
        // A rejection may have committed part of this immutable bundle. Keep the
        // observed phase for evidence reconciliation; never repeat Browser here.
        await storeCapture(bounded, artifacts);
        snapshot.assertActive();
        if (!await verifyPage(bounded, claim!.record, page, body)) return noStore(c.json(partialBody(claim!.record, "fulfillment_unknown", false), 503));
        if (!await save({ ...claim!.record, progress: { ...claim!.record.progress!, pages: pages.map((value, offset) => offset === index ? { ...value, phase: "complete" } : value) } })) return noStore(c.json(lostClaimBody(), 503));
      }
      const response = aggregateResponse(claim!.record);
      const digest = await responseHash(claim!.record, response);
      if (!await save({ ...claim!.record, response, response_hash: digest })) return noStore(c.json(lostClaimBody(), 503));
      if (!await save({ ...claim!.record, state: "complete", response, response_hash: digest, updated_at: new Date().toISOString(), error: undefined })) return noStore(c.json(lostClaimBody(), 503));
      const observations = claim!.record.progress!.pages.map(page => page.observation!);
      await recordEvent(env, { event: "capture_completed", route: PILOT_ROUTE, channel, success: true, grossUsd: 10,
        browserMs: observations.some(value => value.browser_ms === null) ? null : observations.reduce((sum, value) => sum + value.browser_ms!, 0), storageBytes: observations.reduce((sum, value) => sum + value.storage_bytes, 0),
        variableCostUsd: response.economics.variable_cost_usd, contributionMarginUsd: response.economics.contribution_margin_usd });
      return noStore(c.json(response));
    })(), PILOT_DEADLINE_MS, "pilot_deadline_exceeded", snapshot.cancel);
  } catch {
    return noStore(c.json(partialBody(claim?.record ?? { progress: undefined } as PilotRecord, "fulfillment_unknown", false), 503));
  } finally { snapshot.cancel(); }
}
