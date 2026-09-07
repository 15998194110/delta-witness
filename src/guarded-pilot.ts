import type { Context, Next } from "hono";
import { paymentMiddleware } from "@x402/hono";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  paymentIdentifierResourceServerExtension,
} from "@x402/extensions/payment-identifier";
import type { RuntimeEnv } from "./env";
import { sha256, stableJson } from "./crypto";
import {
  getPaymentHeader,
  readJsonRequestBounded,
  referrerChannel,
  resolvePublicRedirects,
  validateTarget,
  type RedirectResolution,
} from "./security";
import { capturePage, storeCapture, type CaptureArtifacts } from "./capture";
import { evaluatePreflight, parsePreflightRequest, type PreflightRequest } from "./fulfillment";
import { estimateVariableCost } from "./pricing";
import { recordEvent } from "./telemetry";
import { GUARDED_ACTION_PILOT_INPUT_SCHEMA, GUARDED_ACTION_PILOT_OUTPUT_SCHEMA } from "./discovery";
import { mirrorX402ChallengeBody } from "./x402-compat";

export const GUARDED_ACTION_PILOT_PRICE_USD = 10;
const PILOT_ROUTE = "/v1/guarded-action-pilot";
const MAX_PILOT_BODY_BYTES = 16_384;
const PROCESSING_LEASE_MS = 90_000;

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
  };
  idempotent_replay?: boolean;
};

type PilotRecord = {
  schema: "delta-guarded-action-pilot/v1";
  state: "processing" | "retryable_failure" | "complete";
  route: typeof PILOT_ROUTE;
  request_hash: string;
  payment_fingerprint: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  error?: string;
  response?: PilotResponse;
};

type StoredPilotRecord = { record: PilotRecord; etag: string };

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
  const record = await object.json<PilotRecord>();
  if (record.schema !== "delta-guarded-action-pilot/v1") throw new Error("invalid_pilot_record");
  return { record, etag: object.etag };
}

async function writePilotRecord(env: RuntimeEnv, key: string, record: PilotRecord): Promise<void> {
  await env.PROOFS.put(key, JSON.stringify(record), { httpMetadata: { contentType: "application/json; charset=utf-8" } });
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
    const targets = await Promise.all(body.urls.map((url) => resolvePublicRedirects(url)));
    const requestHash = await sha256(`${PILOT_ROUTE}\n${stableJson(body)}`);
    const paymentFingerprint = await sha256(payment);
    const key = pilotRecordKey(paymentFingerprint);
    c.set("pilotBody", body);
    c.set("pilotTargets", targets);
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
    const stored = await readPilotRecord(c.env as RuntimeEnv, key);
    if (!stored) return next();
    if (stored.record.request_hash !== requestHash) return c.json({ error: "payment_already_used_for_different_request" }, 409);
    if (stored.record.state === "complete" && stored.record.response) {
      await recordEvent(c.env as RuntimeEnv, { event: "repeat_call", route: PILOT_ROUTE, channel, success: true });
      return noStore(c.json({ ...stored.record.response, idempotent_replay: true }));
    }
    if (isProcessingFresh(stored.record)) {
      c.header("retry-after", "5");
      return c.json({ ok: false, state: "processing", retryable: true }, 202);
    }
    const claimed: PilotRecord = {
      ...stored.record,
      state: "processing",
      attempts: stored.record.attempts + 1,
      updated_at: new Date().toISOString(),
      error: undefined,
    };
    const result = await (c.env as RuntimeEnv).PROOFS.put(key, JSON.stringify(claimed), {
      onlyIf: { etagMatches: stored.etag },
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    if (!result) {
      c.header("retry-after", "5");
      return c.json({ ok: false, state: "processing", retryable: true }, 202);
    }
    c.set("pilotRecord", claimed);
    c.set("pilotReplayAuthorized", true);
    await recordEvent(c.env as RuntimeEnv, { event: "repeat_call", route: PILOT_ROUTE, channel, success: true });
    return next();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid_request";
    const status = reason === "request_too_large" || reason === "body_too_large" ? 413 : 400;
    return c.json({ error: reason }, status);
  }
}

export async function guardedPilotProtect(c: Context<any>, next: Next): Promise<Response | void> {
  if (c.get("pilotReplayAuthorized")) return next();
  const env = c.env as RuntimeEnv;
  const facilitator = new HTTPFacilitatorClient({ url: env.FACILITATOR_URL });
  const server = new x402ResourceServer(facilitator);
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
                economics: { variable_cost_usd: 0.004, contribution_margin_usd: 9.996 },
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
  const targets = c.get("pilotTargets") as RedirectResolution[] | undefined;
  const requestHash = c.get("pilotRequestHash") as string | undefined;
  const paymentFingerprint = c.get("pilotPaymentFingerprint") as string | undefined;
  const key = c.get("pilotRecordKey") as string | undefined;
  const channel = (c.get("pilotChannel") as string | undefined) || referrerChannel(c.req.raw);
  if (!body || !targets || !requestHash || !paymentFingerprint || !key) return c.json({ error: "settled_payment_identity_missing" }, 500);

  let record = c.get("pilotRecord") as PilotRecord | undefined;
  let firstAttempt = false;
  if (!record) {
    firstAttempt = true;
    const now = new Date().toISOString();
    record = {
      schema: "delta-guarded-action-pilot/v1",
      state: "processing",
      route: PILOT_ROUTE,
      request_hash: requestHash,
      payment_fingerprint: paymentFingerprint,
      attempts: 1,
      created_at: now,
      updated_at: now,
    };
    const created = await env.PROOFS.put(key, JSON.stringify(record), {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    if (!created) {
      const existing = await readPilotRecord(env, key);
      if (!existing || existing.record.request_hash !== requestHash) return c.json({ error: "fulfillment_key_conflict" }, 409);
      if (existing.record.state === "complete" && existing.record.response) {
        return noStore(c.json({ ...existing.record.response, idempotent_replay: true }));
      }
      c.header("retry-after", "5");
      return c.json({ ok: false, state: "processing", retryable: true }, 202);
    }
  }

  if (firstAttempt) {
    await recordEvent(env, {
      event: "payment_verified",
      route: PILOT_ROUTE,
      channel,
      grossUsd: GUARDED_ACTION_PILOT_PRICE_USD,
      success: true,
    });
  }
  await recordEvent(env, { event: "capture_started", route: PILOT_ROUTE, channel, success: true });

  try {
    const captures: CaptureArtifacts[] = [];
    const proofs: PilotProof[] = [];
    let browserMs = 0;
    let storageBytes = 0;
    let variableCostUsd = 0;
    const unit = Math.floor((GUARDED_ACTION_PILOT_PRICE_USD / targets.length) * 1_000_000) / 1_000_000;
    const origin = (env.PUBLIC_ORIGIN || "https://delta-witness-api.ruphussten.workers.dev").replace(/\/+$/, "");
    for (let index = 0; index < targets.length; index += 1) {
      const allocatedPrice = index === targets.length - 1
        ? GUARDED_ACTION_PILOT_PRICE_USD - unit * (targets.length - 1)
        : unit;
      const fulfillmentFingerprint = await sha256(`${paymentFingerprint}\n${requestHash}\n${index}`);
      const artifacts = await capturePage({
        env,
        product: "capture",
        target: targets[index],
        fulfillmentFingerprint,
        grossPriceUsd: allocatedPrice,
        paymentProtocol: "x402-v2-upfront",
        channel,
      });
      await storeCapture(env, artifacts);
      captures.push(artifacts);
      browserMs += artifacts.manifest.execution.browser_ms_used;
      storageBytes += artifacts.manifest.artifact_sizes.total_bytes;
      variableCostUsd += artifacts.manifest.execution.estimated_variable_cost_usd;
      proofs.push({
        url: body.urls[index],
        proof_id: artifacts.manifest.proof_id,
        manifest_url: `${origin}/v1/proofs/${artifacts.manifest.proof_id}`,
        public_proof_url: `${origin}/p/${artifacts.manifest.proof_id}`,
        bundle_root: artifacts.manifest.hashes.bundle_root,
        observed_at: artifacts.manifest.capture_completed_at,
        allocated_price_usd: allocatedPrice,
      });
    }

    let preflight: PilotResponse["preflight"];
    if (body.preflight) {
      const index = body.preflight.url_index;
      const evaluation = evaluatePreflight(
        { url: body.urls[index], expected: body.preflight.expected },
        captures[index].manifest,
        captures[index].markdown,
      );
      preflight = {
        url_index: index,
        url: body.urls[index],
        safe: evaluation.safe,
        changed: evaluation.changed,
        reason: evaluation.reason,
        diff: evaluation.diff,
      };
    }
    const response: PilotResponse = {
      ok: true,
      product: "guarded_action_pilot",
      price_usd: 10,
      proofs,
      preflight,
      economics: {
        variable_cost_usd: variableCostUsd,
        contribution_margin_usd: GUARDED_ACTION_PILOT_PRICE_USD - variableCostUsd,
      },
    };
    await writePilotRecord(env, key, {
      ...record,
      state: "complete",
      updated_at: new Date().toISOString(),
      error: undefined,
      response,
    });
    await recordEvent(env, {
      event: "capture_completed",
      route: PILOT_ROUTE,
      channel,
      success: true,
      grossUsd: GUARDED_ACTION_PILOT_PRICE_USD,
      browserMs,
      storageBytes,
      variableCostUsd,
      contributionMarginUsd: GUARDED_ACTION_PILOT_PRICE_USD - variableCostUsd,
    });
    return noStore(c.json(response));
  } catch (error) {
    const reason = (error instanceof Error ? error.message : "pilot_capture_failed").slice(0, 160);
    await writePilotRecord(env, key, {
      ...record,
      state: "retryable_failure",
      error: reason,
      updated_at: new Date().toISOString(),
    });
    await recordEvent(env, {
      event: "capture_failed",
      route: PILOT_ROUTE,
      channel,
      grossUsd: GUARDED_ACTION_PILOT_PRICE_USD,
      success: false,
      reason,
    });
    return noStore(c.json({ error: "guarded_action_pilot_failed", reason, retryable: true, payment_will_not_be_charged_again: true }, 502));
  }
}
