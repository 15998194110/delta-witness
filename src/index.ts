import { Hono, type Context, type Next } from "hono";
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
import { sha256, stableJson, timingSafeEqualSecret } from "./crypto";
import {
  MAX_CAPTURE_BODY_BYTES,
  MAX_PARTNER_BODY_BYTES,
  MAX_PREFLIGHT_BODY_BYTES,
  getPaymentHeader,
  readJsonRequestBounded,
  referrerChannel,
  resolvePublicRedirects,
  sanitizeDimension,
  validateTarget,
  type RedirectResolution,
} from "./security";
import {
  claimRetry,
  evaluatePreflight,
  fulfillmentMatches,
  fulfillmentRecordKey,
  initialFulfillment,
  paidRequestHash,
  parseCaptureRequest,
  parsePreflightRequest,
  readFulfillment,
  recoverDelivery,
  deliveryDigest,
  validDeliveryDigest,
  settledRetryPrice,
  writeFulfillment,
  type DeliveryResponse,
  type FulfillmentRecord,
  type PaidRequest,
  type PreflightRequest,
  type StoredFulfillment,
} from "./fulfillment";
import { capturePage, readStoredCapture, storeCapture, verifyManifestIntegrity, type ProofManifest } from "./capture";
import {
  quoteProductWithOverride,
  raisePriceAfterNegativeMargin,
  x402Price,
  type PricingQuote,
  type Product,
} from "./pricing";
import { recordEvent } from "./telemetry";
import {
  CAPTURE_INPUT_SCHEMA,
  DELIVERY_SCHEMA,
  PREFLIGHT_INPUT_SCHEMA,
  GUARDED_ACTION_PILOT_INPUT_SCHEMA,
  docsHtml,
  landingHtml,
  openApi,
  postmanCollection,
  skillMarkdown,
  USE_CASE_SLUGS,
  useCaseHtml,
} from "./discovery";
import { getWatch, parseWatchRegistration, registerWatch, runDueWatches } from "./watch";
import { guardedPilotEconomics, guardedPilotHandler, guardedPilotPrevalidate, guardedPilotProtect } from "./guarded-pilot";
import { mirrorX402ChallengeBody } from "./x402-compat";
import { agentJsonManifest } from "./agent-manifest";
import { guardedFacilitator, readSettlement, readOrderSettlement, settlementBlockedBody, validatePaymentBinding } from "./settlement";
import { captureFailure, safeErrorCode, MAX_FULFILLMENT_ATTEMPTS } from "./failures";
import { commitClaim, createClaim, lostClaimBody } from "./claims";
import { parseOrderEnrollment, assertOrderReplay, OrderAccessError, orderStatusResponse, retentionDisclosure, orderRecoveryDisclosure, readOrderBinding, orderRetention, type OrderEnrollment } from "./orders";
import type { RetentionPolicy } from "./retention";
import { createOrderReadSnapshot, MetadataReadError, StorageWriteError, readProofManifestMetadata } from "./order-storage";
import { withinDeadline } from "./deadline";
import { partnerBusinessIdentity, coordinatePartnerBilling } from "./partner-billing";
import { exportOrderArtifact } from "./order-export";
import { orderExportAuthorizationResponse } from "./order-export-authorization";
import { runScheduledOperations, scheduledStatus, scheduledFetch, readScheduledJson, type ScheduledWorkResult } from "./scheduled-operations";
import { pulseWatchdog } from "./pulse-watchdog";
import { operatingStatus, recordOperatingPulse, operatingPulseReceipt, readOperatingJson, recordWatchdogObservation } from "./operating-control";
import { operatingDashboard } from "./operating-dashboard";
import { handleTreasuryCustody } from "./treasury-custody";

type PaidProduct = "capture" | "preflight";
type PriorManifest = Pick<ProofManifest, "proof_id" | "requested_url" | "capture_completed_at" | "hashes">;

type AppVariables = {
  paidBody: PaidRequest;
  redirectResolution: RedirectResolution;
  requestHash: string;
  quote: PricingQuote;
  channel: string;
  paymentFingerprint?: string;
  fulfillmentKey?: string;
  claimedRecord?: StoredFulfillment;
  replayAuthorized: boolean;
  priorManifest?: PriorManifest;
  orderEnrollment?: OrderEnrollment;
};

type App = { Bindings: RuntimeEnv; Variables: AppVariables };
type AppContext = Context<App>;

const app = new Hono<App>();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROCESSING_LEASE_MS = 90_000;

function origin(env: RuntimeEnv): string {
  return (env.PUBLIC_ORIGIN || "https://delta-witness-api.ruphussten.workers.dev").replace(/\/+$/, "");
}

function message(error: unknown): string {
  return safeErrorCode(error);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function noStore(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

function publicVerifier(manifest: Record<string, unknown>, integrity: boolean | null): Record<string, unknown> {
  const payment = manifest.payment && typeof manifest.payment === "object"
    ? manifest.payment as Record<string, unknown>
    : undefined;
  return {
    schema: manifest.schema,
    proof_id: manifest.proof_id,
    product: manifest.product ?? "capture",
    requested_url: manifest.requested_url,
    requested_url_sha256: manifest.requested_url_sha256,
    capture_started_at: manifest.capture_started_at,
    capture_completed_at: manifest.capture_completed_at ?? manifest.captured_at,
    observed_http_status: manifest.observed_http_status,
    observed_title: manifest.observed_title,
    observed_final_url: manifest.observed_final_url,
    redirects: manifest.redirects,
    hashes: manifest.hashes,
    artifact_sizes: manifest.artifact_sizes,
    execution: manifest.execution,
    payment: payment ? {
      protocol: payment.protocol,
      network: payment.network,
      asset: payment.asset,
      listed_price_usd: payment.listed_price_usd,
      channel: payment.channel,
      partner: payment.partner,
    } : undefined,
    attestation: manifest.attestation,
    disclaimer: manifest.disclaimer,
    integrity: integrity === null ? "legacy_unverifiable" : integrity ? "verified" : "failed",
  };
}

function isProcessingFresh(record: FulfillmentRecord): boolean {
  return record.state === "processing" && Date.now() - Date.parse(record.updated_at) < PROCESSING_LEASE_MS;
}

async function loadPriorManifest(env: RuntimeEnv, request: PreflightRequest): Promise<PriorManifest | undefined> {
  if (!request.prior_proof_id) return undefined;
  const stored = await readProofManifestMetadata<PriorManifest>(env, request.prior_proof_id);
  if (!stored) throw new Error("prior_proof_not_found");
  const manifest = stored.record;
  if (!manifest.hashes?.html || !manifest.hashes?.markdown) throw new Error("prior_proof_invalid");
  if (validateTarget(manifest.requested_url).toString() !== request.url) throw new Error("prior_proof_target_mismatch");
  return manifest;
}

// Read the original purchased obligation even when signed retries omit newer
// capability headers. Never charge/capture again after its raw retention ends.
async function purchasedPolicyForCapture(env: RuntimeEnv, payment: string, product: PaidProduct, fingerprint: string): Promise<RetentionPolicy | undefined> {
  const snapshot = createOrderReadSnapshot(env);
  try {
    return await withinDeadline((async () => {
      const journal = await readSettlement(snapshot.env, payment);
      if (!journal?.order_id) return undefined;
      const order = await readOrderBinding(snapshot.env, journal.order_id);
      if (!order || order.payment_fingerprint !== fingerprint || order.product !== product) throw new Error("order_evidence_inconsistent");
      const settlement = await readOrderSettlement(snapshot.env, order);
      if (settlement.state !== "settlement_confirmed") throw new Error("order_evidence_inconsistent");
      const retention = await orderRetention(order, settlement, null);
      snapshot.assertActive();
      if (retention.state === "expired") throw new OrderAccessError("raw_artifacts_expired", 410);
      return order.retention_snapshot?.policy;
    })(), 15_000, "order_evidence_unavailable");
  } catch (error) {
    if (error instanceof OrderAccessError) throw error;
    throw new OrderAccessError("order_evidence_inconsistent", 503);
  } finally { snapshot.cancel(); }
}

async function prevalidate(product: PaidProduct, c: AppContext, next: Next): Promise<Response | void> {
  if (c.req.method !== "POST") return next();
  const enrollmentSnapshot = createOrderReadSnapshot(c.env);
  try { c.set("orderEnrollment", await withinDeadline(parseOrderEnrollment(c.req.raw, enrollmentSnapshot.env), 15_000, "order_evidence_unavailable")); }
  catch (error) {
    if (error instanceof OrderAccessError) return noStore(c.json({ ok: false, error: error.code }, error.status));
    return noStore(c.json({ ok: false, error: "order_unavailable" }, 503));
  } finally { enrollmentSnapshot.cancel(); }
  // Keep the paywall ahead of request validation. Discovery clients (including
  // x402scan) are allowed to probe a paid route without knowing its body yet;
  // they must receive a 402 challenge rather than a validation error. We still
  // validate and reject the body before any paid fulfillment is attempted once
  // a payment header is present.
  const payment = getPaymentHeader(c.req.raw);
  if (!payment) {
    c.set("quote", await quoteProductWithOverride(c.env, product));
    c.set("channel", referrerChannel(c.req.raw));
    c.set("replayAuthorized", false);
    return next();
  }
  try {
    const value = await readJsonRequestBounded(
      c.req.raw,
      product === "capture" ? MAX_CAPTURE_BODY_BYTES : MAX_PREFLIGHT_BODY_BYTES,
    );
    const body = product === "capture" ? parseCaptureRequest(value) : parsePreflightRequest(value);
    const requestHash = await paidRequestHash(`/v1/${product}`, body);
    // A current proposal is not authority for an already paid observation.
    // Complete/draft replay below needs neither a new quote nor live DNS.
    const originalQuote = async (paidPrice: number, policy?: RetentionPolicy) => {
      const quote = await quoteProductWithOverride({ ...c.env,
        RETENTION_POLICY_JSON: policy ? JSON.stringify(policy) : undefined }, product);
      return { ...quote, grossPriceUsd: paidPrice, estimatedContributionMarginUsd: paidPrice - quote.expectedVariableCostUsd,
        assumptions: { ...quote.assumptions, ...(quote.assumptions.costModel ? { costModel: {
          ...quote.assumptions.costModel, storageDurationSource: policy ? "purchased_policy_maximum" as const : "one_month_fallback" as const,
        } } : {}) } };
    };
    const prepareCapture = async () => {
      const [target, prior] = await Promise.all([
        resolvePublicRedirects(body.url),
        product === "preflight" ? loadPriorManifest(c.env, body as PreflightRequest) : Promise.resolve(undefined),
      ]);
      c.set("redirectResolution", target);
      c.set("priorManifest", prior);
    };
    c.set("paidBody", body);
    c.set("requestHash", requestHash);
    c.set("channel", referrerChannel(c.req.raw));
    c.set("replayAuthorized", false);
    await recordEvent(c.env, {
      event: "qualified_request",
      route: `/v1/${product}`,
      channel: c.var.channel,
      // Qualified requests are not sales; original/new price is assigned only
      // after the stored payment identity has been classified below.
      success: true,
    });

    const paymentFingerprint = await sha256(payment);
    const key = fulfillmentRecordKey(paymentFingerprint);
    c.set("paymentFingerprint", paymentFingerprint);
    c.set("fulfillmentKey", key);
    const stored = await readFulfillment(c.env, key);
    if (c.var.orderEnrollment) await assertOrderReplay(c.env, c.var.orderEnrollment,
      { product, request_hash: requestHash, payment_fingerprint: paymentFingerprint }, await readSettlement(c.env, payment), Boolean(stored));
    if (!stored) {
      const settlement = await readSettlement(c.env, payment);
      if (settlement) {
        validatePaymentBinding(c.env, payment, `${origin(c.env)}/v1/${product}`, settlement.amount);
        if (settlement.request_hash !== requestHash || settlement.payment_fingerprint !== paymentFingerprint) {
          return noStore(c.json(settlementBlockedBody("settlement_identity_conflict"), 409));
        }
        if (settlement.state !== "settlement_confirmed") return noStore(c.json(settlementBlockedBody(settlement.state), 503));
        const paidPrice = Number(settlement.amount) / 1_000_000;
        const policy = await purchasedPolicyForCapture(c.env, payment, product, paymentFingerprint);
        c.set("quote", await originalQuote(paidPrice, policy));
        c.set("replayAuthorized", true);
      } else {
        const quote = await quoteProductWithOverride(c.env, product);
        validatePaymentBinding(c.env, payment, `${origin(c.env)}/v1/${product}`, String(Math.round(quote.grossPriceUsd * 1_000_000)));
        c.set("quote", quote);
      }
      await prepareCapture();
      return next();
    }
    if (!fulfillmentMatches(stored.record, `/v1/${product}`, requestHash)) {
      return c.json({ error: "payment_already_used_for_different_request" }, 409);
    }
    if (stored.record.response) {
      // A newly enrolled order cannot remove its digest and impersonate an old
      // hashless record by omitting capability headers on signed replay.
      if (stored.record.response_hash === undefined && (await readSettlement(c.env, payment, true))?.order_id) {
        return noStore(c.json({ ok: false, error: "delivery_evidence_inconsistent", retryable: false }, 503));
      }
      if (!await validDeliveryDigest(stored.record)) return noStore(c.json({ ok: false, error: "delivery_evidence_inconsistent", retryable: false }, 503));
    }
    if (stored.record.state === "complete" && stored.record.response) {
      await recordEvent(c.env, { event: "repeat_call", route: `/v1/${product}`, channel: c.var.channel, success: true });
      return noStore(c.json({ ...stored.record.response, idempotent_replay: true }));
    }
    const recovered = await recoverDelivery(c.env, key, stored, body, product, paymentFingerprint);
    if (recovered) return noStore(c.json({ ...recovered, idempotent_replay: true }));
    if (stored.record.state === "blocked_failure" || stored.record.attempts >= MAX_FULFILLMENT_ATTEMPTS) {
      return noStore(c.json({ ok: false, state: "blocked_failure", error: "fulfillment_requires_review", retryable: false }, 503));
    }
    if (isProcessingFresh(stored.record)) {
      c.header("retry-after", "5");
      return c.json({ ok: false, state: "processing", retryable: true }, 202);
    }
    if (stored.record.state === "processing") return noStore(c.json({ ok: false, state: "fulfillment_unknown", retryable: false, requires_fulfillment_reconciliation: true }, 503));
    const paidPrice = settledRetryPrice(stored.record, payment);
    const policy = await purchasedPolicyForCapture(c.env, payment, product, paymentFingerprint);
    c.set("quote", await originalQuote(paidPrice, policy));
    await prepareCapture();
    const claimed = await claimRetry(c.env, key, stored);
    if (!claimed) {
      c.header("retry-after", "5");
      return c.json({ ok: false, state: "processing", retryable: true }, 202);
    }
    c.set("claimedRecord", claimed);
    c.set("replayAuthorized", true);
    await recordEvent(c.env, { event: "repeat_call", route: `/v1/${product}`, channel: c.var.channel, success: true });
    return next();
  } catch (error) {
    if (error instanceof MetadataReadError || error instanceof StorageWriteError) return noStore(c.json({ ok: false, error: error.message, retryable: false, requires_fulfillment_reconciliation: true }, 503));
    if (error instanceof OrderAccessError) return noStore(c.json({ ok: false, error: error.code }, error.status));
    const reason = safeErrorCode(error);
    const status = reason === "request_too_large" || reason === "body_too_large" ? 413 : 400;
    return c.json({ error: reason }, status);
  }
}

function discoveryFor(product: PaidProduct): Record<string, unknown> {
  return declareDiscoveryExtension({
    bodyType: "json",
    input: product === "capture"
      ? { url: "https://example.com" }
      : { url: "https://example.com/terms", expected: { contains: ["Refund window: 30 days"] } },
    inputSchema: product === "capture" ? CAPTURE_INPUT_SCHEMA : PREFLIGHT_INPUT_SCHEMA,
    output: {
      example: {
        ok: true,
        product,
        proof_id: "7d9d12f7-8f91-5f41-9f0c-5ef257d9ea5d",
        manifest_url: "https://delta-witness-api.ruphussten.workers.dev/v1/proofs/7d9d12f7-8f91-5f41-9f0c-5ef257d9ea5d",
        public_proof_url: "https://delta-witness-api.ruphussten.workers.dev/p/7d9d12f7-8f91-5f41-9f0c-5ef257d9ea5d",
        bundle_root: `sha256:${"0".repeat(64)}`,
        observed_at: "2026-08-31T00:00:00.000Z",
        safe: product === "preflight" ? true : undefined,
        changed: product === "preflight" ? false : undefined,
      },
      schema: DELIVERY_SCHEMA,
    },
  });
}

async function protectWithX402(product: PaidProduct, c: AppContext, next: Next): Promise<Response | void> {
  // Only POST is a paid operation. Let unsupported methods fall through to the
  // router instead of touching POST-only quote state; this keeps discovery
  // probes from seeing an internal error when they first test the endpoint.
  if (c.req.method !== "POST") return next();
  if (c.var.replayAuthorized) return next();
  const facilitator = guardedFacilitator(c.env, c.var.requestHash, c.var.paymentFingerprint ?? "", c.var.orderEnrollment ? {
    enrollment: c.var.orderEnrollment, product, resource: `${origin(c.env)}/v1/${product}`, request_body: c.var.paidBody,
  } : undefined);
  const server = new x402ResourceServer(facilitator.client);
  registerExactEvmScheme(server);
  server.registerExtension(bazaarResourceServerExtension);
  server.registerExtension(paymentIdentifierResourceServerExtension);
  const route = `/v1/${product}`;
  const middleware = paymentMiddleware(
    {
      [`POST ${route}`]: {
        accepts: [{
          scheme: "exact",
          price: x402Price(c.var.quote),
          network: c.env.NETWORK as `eip155:${string}`,
          payTo: c.env.PAY_TO,
          maxTimeoutSeconds: 300,
          extra: { paymentFlow: "upfront" },
        }],
        resource: `${origin(c.env)}${route}`,
        description: product === "capture"
          ? "Browser verification and page state proof: preserve what a public webpage says now with timestamped artifact hashes"
          : "Preflight an autonomous action by comparing a fresh public-source observation with deterministic expectations",
        mimeType: "application/json",
        serviceName: "delta-witness",
        tags: product === "capture"
          ? ["web", "proof", "capture", "browser-verification", "page-state-proof", "autonomous-agents"]
          : ["web", "proof", "preflight", "browser-verification", "autonomous-action", "agent-guard"],
        extensions: {
          ...discoveryFor(product),
          [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false),
        },
        unpaidResponseBody: () => ({
          contentType: "application/json",
          body: {
            error: "payment_required",
            product,
            price_usd: c.var.quote.grossPriceUsd,
            network: c.env.NETWORK,
            asset: "USDC",
            payment_flow: "upfront",
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
      order_recovery: orderRecoveryDisclosure(c.env),
      retention: await retentionDisclosure(c.env),
      error: "payment_required",
      product,
      price_usd: c.var.quote.grossPriceUsd,
      payment_flow: "upfront",
    });
    await recordEvent(c.env, {
      event: getPaymentHeader(c.req.raw) ? "payment_required" : "payment_required",
      route,
      channel: c.var.channel,
      grossUsd: c.var.quote.grossPriceUsd,
      success: false,
    });
  }
  return c.res;
}

async function executeFulfillment(input: {
  env: RuntimeEnv;
  product: PaidProduct;
  body: PaidRequest;
  target: RedirectResolution;
  quote: PricingQuote;
  channel: string;
  requestHash: string;
  fingerprint: string;
  key: string;
  route: string;
  paymentProtocol: "x402-v2-upfront" | "partner-prepaid";
  existingClaim?: StoredFulfillment;
  partner?: string;
  priorManifest?: PriorManifest;
  retentionPolicy?: RetentionPolicy;
}): Promise<{ status: number; body: DeliveryResponse | Record<string, unknown> }> {
  const { env, product, route, requestHash, fingerprint, key } = input;
  let claim = input.existingClaim;
  if (!claim) {
    const initial = initialFulfillment({
      route,
      requestHash,
      requestedUrl: input.body.url,
      fulfillmentFingerprint: fingerprint,
      paymentFingerprint: input.paymentProtocol === "x402-v2-upfront" ? fingerprint : undefined,
      paidPriceUsd: input.quote.grossPriceUsd,
      partner: input.partner,
    });
    const created = await createClaim(env, key, initial);
    if (!created) {
      const existing = await readFulfillment(env, key);
      if (!existing || !fulfillmentMatches(existing.record, route, requestHash)) {
        return { status: 409, body: { error: "fulfillment_key_conflict" } };
      }
      if (existing.record.state === "complete" && existing.record.response) {
        if (!await validDeliveryDigest(existing.record)) return { status: 503, body: { ok: false, error: "delivery_evidence_inconsistent", retryable: false } };
        return { status: 200, body: { ...existing.record.response, idempotent_replay: true } };
      }
      return { status: 202, body: { ok: false, state: "processing", retryable: true } };
    }
    claim = created;
  }
  const record = claim.record;

  if (!input.existingClaim) await recordEvent(env, {
    event: input.paymentProtocol === "x402-v2-upfront" ? "payment_verified" : "partner_request",
    route,
    channel: input.channel,
    partner: input.partner,
    grossUsd: input.quote.grossPriceUsd,
    success: true,
  });
  await recordEvent(env, { event: "capture_started", route, channel: input.channel, partner: input.partner, success: true });

  let persistenceStarted = false;
  try {
    const artifacts = await capturePage({
      env,
      product,
      target: input.target,
      fulfillmentFingerprint: fingerprint,
      grossPriceUsd: input.quote.grossPriceUsd,
      paymentProtocol: input.paymentProtocol,
      channel: input.channel,
      partner: input.partner,
      retentionPolicy: input.retentionPolicy,
    });
    const base = `${origin(env)}`;
    const response: DeliveryResponse = {
      ok: true,
      product,
      proof_id: artifacts.manifest.proof_id,
      manifest_url: `${base}/v1/proofs/${artifacts.manifest.proof_id}`,
      public_proof_url: `${base}/p/${artifacts.manifest.proof_id}`,
      bundle_root: artifacts.manifest.hashes.bundle_root,
      observed_at: artifacts.manifest.capture_completed_at,
    };
    if (product === "preflight") {
      const evaluation = evaluatePreflight(
        input.body as PreflightRequest,
        artifacts.manifest,
        artifacts.markdown,
        input.priorManifest as ProofManifest | undefined,
      );
      response.safe = evaluation.safe;
      response.changed = evaluation.changed;
      response.reason = evaluation.reason;
      response.diff = evaluation.diff;
    }
    persistenceStarted = true;
    const responseHash = await deliveryDigest(record, response);
    const draft = await writeFulfillment(env, key, claim, { ...record, response, response_hash: responseHash });
    if (!draft) return { status: 503, body: lostClaimBody() };
    claim = draft;
    await storeCapture(env, artifacts);
    const complete: FulfillmentRecord = {
      ...record,
      state: "complete",
      completed_at: new Date().toISOString(),
      response,
      response_hash: responseHash,
      updated_at: new Date().toISOString(),
      error: undefined,
    };
    const completed = await writeFulfillment(env, key, claim, complete);
    if (!completed) return { status: 503, body: lostClaimBody() };
    const economics = artifacts.manifest.execution;
    await recordEvent(env, {
      event: "capture_completed",
      route,
      channel: input.channel,
      partner: input.partner,
      success: true,
      grossUsd: economics.gross_price_usd,
      browserMs: economics.browser_ms_used,
      storageBytes: artifacts.manifest.artifact_sizes.total_bytes,
      variableCostUsd: economics.estimated_variable_cost_usd,
      contributionMarginUsd: economics.estimated_contribution_margin_usd,
    });
    if (economics.estimated_contribution_margin_usd < 0) {
      await raisePriceAfterNegativeMargin(env, product, economics.estimated_variable_cost_usd);
    }
    return { status: 200, body: response };
  } catch (error) {
    // A rejected R2 promise does not prove that its write failed. Never replace
    // a possibly committed delivery or rerun captures after uncertain storage.
    if (persistenceStarted) return { status: 503, body: { ok: false, state: "fulfillment_unknown", retryable: false, requires_fulfillment_reconciliation: true } };
    const { reason, retryable } = captureFailure(error);
    const failed = await writeFulfillment(env, key, claim, {
      ...record,
      state: retryable && record.attempts < MAX_FULFILLMENT_ATTEMPTS ? "retryable_failure" : "blocked_failure",
      error: reason,
      updated_at: new Date().toISOString(),
    });
    if (!failed) return { status: 503, body: lostClaimBody() };
    await recordEvent(env, {
      event: "capture_failed",
      route,
      channel: input.channel,
      partner: input.partner,
      grossUsd: input.quote.grossPriceUsd,
      success: false,
      reason,
    });
    return { status: 502, body: { error: "capture_failed", reason, retryable: retryable && record.attempts < MAX_FULFILLMENT_ATTEMPTS, payment_will_not_be_charged_again: true } };
  }
}

async function paidHandler(product: PaidProduct, c: AppContext): Promise<Response> {
  const paymentFingerprint = c.var.paymentFingerprint;
  const key = c.var.fulfillmentKey;
  if (!paymentFingerprint || !key) return c.json({ error: "settled_payment_identity_missing" }, 500);
  let retentionPolicy: RetentionPolicy | undefined;
  try { retentionPolicy = await purchasedPolicyForCapture(c.env, getPaymentHeader(c.req.raw)!, product, paymentFingerprint); }
  catch (error) {
    return noStore(c.json({ ok: false, state: "fulfillment_unknown", error: error instanceof OrderAccessError ? error.code : "order_evidence_inconsistent", retryable: false }, error instanceof OrderAccessError ? error.status : 503));
  }
  const result = await executeFulfillment({
    env: c.env,
    product,
    body: c.var.paidBody,
    target: c.var.redirectResolution,
    quote: c.var.quote,
    channel: c.var.channel,
    requestHash: c.var.requestHash,
    fingerprint: paymentFingerprint,
    key,
    route: `/v1/${product}`,
    paymentProtocol: "x402-v2-upfront",
    existingClaim: c.var.claimedRecord,
    priorManifest: c.var.priorManifest,
    retentionPolicy,
  });
  c.status(result.status as 200 | 202 | 409 | 500 | 502 | 503);
  return noStore(c.json(result.body));
}

app.use("*", async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  c.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  if (!c.req.path.startsWith("/v1/orders/") || !c.res.headers.has("content-security-policy")) {
    c.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  }
  if (!c.req.path.startsWith("/v1/orders/") && (c.req.path.startsWith("/v1/") || c.req.path.endsWith(".json"))) {
    c.header("access-control-allow-origin", "*");
    // x402 v2 clients must read the challenge and settlement headers in a browser.
    c.header("access-control-expose-headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE");
  }
});

app.options("/v1/orders/*", (c) => orderStatusResponse(c.env, c.req.raw));
app.get("/v1/orders/:id", (c) => orderStatusResponse(c.env, c.req.raw, c.req.param("id")));
app.post("/v1/orders/:id/recover", (c) => orderStatusResponse(c.env, c.req.raw, c.req.param("id"), true));
app.get("/v1/orders/:id/artifacts/:artifact", (c) => exportOrderArtifact(c.env, c.req.param("id"), c.req.raw, c.req.param("artifact")));
app.get("/v1/orders/:id/export-authorization", (c) => orderExportAuthorizationResponse(c.env, c.req.param("id"), c.req.raw));
app.post("/v1/orders/:id/export-authorization", (c) => orderExportAuthorizationResponse(c.env, c.req.param("id"), c.req.raw));

app.options("/v1/*", (c) => {
  c.header("access-control-allow-origin", "*");
  c.header("access-control-allow-methods", "GET, POST, OPTIONS");
  c.header("access-control-allow-headers", "content-type, payment-signature, x-payment, x-delta-channel, x-delta-order-id, x-delta-recovery-token, x-delta-retention-policy-hash");
  c.header("access-control-max-age", "86400");
  return c.body(null, 204);
});

app.get("/.well-known/402index-verify.txt", (c) => c.text("1a44144b01cf2e59a16783ecf191b4f6e489c236dfad5168d913a4afc4bbca85"));

app.get("/health", (c) => c.json({ ok: true, version: c.env.APP_VERSION, network: c.env.NETWORK, ts: new Date().toISOString() }));

app.get("/v1/quote", async (c) => {
  const requestedProduct = c.req.query("product");
  if (requestedProduct === "guarded-action-pilot" || requestedProduct === "guarded_action_pilot") {
    const channel = referrerChannel(c.req.raw);
    const economics = guardedPilotEconomics(c.env);
    await recordEvent(c.env, { event: "quote_issued", route: "/v1/guarded-action-pilot", channel, grossUsd: 10, success: true });
    return c.json({
      ok: true,
      version: c.env.APP_VERSION,
      product: "guarded_action_pilot",
      price: "$10",
      network: c.env.NETWORK,
      asset: "USDC",
      pay_to: c.env.PAY_TO,
      payment_flow: "upfront",
      max_urls: 3,
      economics,
    });
  }
  const product = requestedProduct === "preflight" ? "preflight" : "capture";
  const quote = await quoteProductWithOverride(c.env, product);
  const channel = referrerChannel(c.req.raw);
  await recordEvent(c.env, { event: "quote_issued", route: `/v1/${product}`, channel, grossUsd: quote.grossPriceUsd, success: true });
  return c.json({
    ok: true,
    version: c.env.APP_VERSION,
    price: x402Price(quote),
    network: c.env.NETWORK,
    asset: "USDC",
    pay_to: c.env.PAY_TO,
    payment_flow: "upfront",
    economics: quote,
    order_recovery: orderRecoveryDisclosure(c.env),
    retention: await retentionDisclosure(c.env),
  });
});

app.use("/v1/capture", (c, next) => prevalidate("capture", c, next));
app.use("/v1/capture", (c, next) => protectWithX402("capture", c, next));
app.post("/v1/capture", (c) => paidHandler("capture", c));

app.use("/v1/preflight", (c, next) => prevalidate("preflight", c, next));
app.use("/v1/preflight", (c, next) => protectWithX402("preflight", c, next));
app.post("/v1/preflight", (c) => paidHandler("preflight", c));

app.use("/v1/guarded-action-pilot", async (c, next) => {
  if (c.req.header("x-delta-order-id") !== undefined || c.req.header("x-delta-recovery-token") !== undefined) {
    return noStore(c.json({ ok: false, error: "order_recovery_product_unsupported" }, 400));
  }
  return next();
});
app.use("/v1/guarded-action-pilot", (c, next) => guardedPilotPrevalidate(c, next));
app.use("/v1/guarded-action-pilot", (c, next) => guardedPilotProtect(c, next));
app.post("/v1/guarded-action-pilot", (c) => guardedPilotHandler(c));

async function partnerAuthorized(c: AppContext, next: Next): Promise<Response | void> {
  if (!c.env.PARTNER_GATEWAY_SECRET) return c.json({ error: "partner_gateway_not_configured" }, 503);
  const presented = c.req.header("x-delta-core-secret") ?? "";
  if (!(await timingSafeEqualSecret(presented, c.env.PARTNER_GATEWAY_SECRET))) return c.json({ error: "unauthorized" }, 401);
  return next();
}

app.use("/internal/partner/*", partnerAuthorized);

app.get("/internal/partner/business/capabilities", (c) => noStore(c.json({
  schema: "delta-partner-billing/v1", enabled: c.env.PARTNER_BILLING_COORDINATION_ENABLED === "true",
  business_order_id_required: true, trusted_user_id_required: true,
  charge_permission: "one_winning_original_fulfillment_cas", platform_settlement_verified: false,
})));

app.post("/internal/partner/business/:businessOrderId/:product", async (c) => {
  if (c.env.PARTNER_BILLING_COORDINATION_ENABLED !== "true") return noStore(c.json({ error: "partner_billing_not_enabled" }, 503));
  const product = c.req.param("product");
  if (product !== "capture" && product !== "preflight") return c.json({ error: "unknown_product" }, 404);
  try {
    const identity = await partnerBusinessIdentity(c.req.header("x-delta-partner") ?? "", c.req.header("x-delta-partner-user") ?? "", c.req.param("businessOrderId"));
    const body = await readJsonRequestBounded(c.req.raw, MAX_PARTNER_BODY_BYTES);
    const headers = new Headers(c.req.raw.headers);
    headers.set("idempotency-key", identity.idempotencyKey);
    headers.delete("content-length");
    // One existing partner fulfillment engine owns capture, claims and replay.
    return app.fetch(new Request(`https://delta.internal/internal/partner/${product}`, { method: "POST", headers, body: JSON.stringify(body) }), c.env);
  } catch { return noStore(c.json({ error: "invalid_partner_business_request" }, 400)); }
});

app.post("/internal/partner/business/:businessOrderId/:product/billing", async (c) => {
  if (c.env.PARTNER_BILLING_COORDINATION_ENABLED !== "true") return noStore(c.json({ error: "partner_billing_not_enabled" }, 503));
  const product = c.req.param("product");
  if (product !== "capture" && product !== "preflight") return c.json({ error: "unknown_product" }, 404);
  try {
    const raw = await readJsonRequestBounded(c.req.raw, MAX_PARTNER_BODY_BYTES);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).some(key => !["request", "operation", "attempt_id"].includes(key)) || !["status", "reserve_charge", "confirm_charge"].includes(String(body.operation))) throw new Error();
    const request = product === "capture" ? parseCaptureRequest(body.request) : parsePreflightRequest(body.request);
    const result = await coordinatePartnerBilling(c.env, { partner: c.req.header("x-delta-partner") ?? "", userId: c.req.header("x-delta-partner-user") ?? "",
      businessOrderId: c.req.param("businessOrderId"), product, request,
      operation: body.operation as "status" | "reserve_charge" | "confirm_charge", attemptId: body.attempt_id as string | undefined });
    return noStore(c.json(result.body, result.status as 200 | 202 | 400 | 404 | 409 | 503));
  } catch { return noStore(c.json({ error: "invalid_partner_billing_request" }, 400)); }
});

app.post("/internal/partner/watch", async (c) => {
  try {
    const raw = await readJsonRequestBounded(c.req.raw, MAX_PARTNER_BODY_BYTES);
    const request = await parseWatchRegistration(raw);
    const partner = sanitizeDimension(c.req.header("x-delta-partner"), "unknown");
    const channel = sanitizeDimension(c.req.header("x-delta-channel"), "partner");
    const idempotencyKey = c.req.header("idempotency-key") ?? "";
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return c.json({ error: "valid_idempotency_key_required" }, 400);
    const requestHash = await sha256(`/partner/watch\n${stableJson(request)}`);
    const fingerprint = await sha256(`partner-watch\n${partner}\n${idempotencyKey}`);
    const grossPaidUsd = Number(c.req.header("x-delta-gross-usd"));
    const result = await registerWatch({ env: c.env, request, requestHash, fingerprint, partner, channel, grossPaidUsd });
    c.status(result.status as 200 | 201 | 400 | 402 | 409 | 503);
    return noStore(c.json(result.body));
  } catch (error) {
    const reason = message(error);
    const status = reason === "request_too_large" || reason === "body_too_large" ? 413 : 400;
    return c.json({ error: reason }, status);
  }
});

app.get("/internal/partner/watch/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_PATTERN.test(id)) return c.json({ error: "invalid_watch_id" }, 400);
  const partner = sanitizeDimension(c.req.header("x-delta-partner"), "unknown");
  const result = await getWatch(c.env, id, partner);
  c.status(result.status as 200 | 404);
  return noStore(c.json(result.body));
});

app.post("/internal/partner/:product", async (c) => {
  const product = c.req.param("product");
  if (product !== "capture" && product !== "preflight") return c.json({ error: "unknown_product" }, 404);
  try {
    const raw = await readJsonRequestBounded(c.req.raw, MAX_PARTNER_BODY_BYTES);
    const body = product === "capture" ? parseCaptureRequest(raw) : parsePreflightRequest(raw);
    const partner = sanitizeDimension(c.req.header("x-delta-partner"), "unknown");
    const idempotencyKey = c.req.header("idempotency-key") ?? "";
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return c.json({ error: "valid_idempotency_key_required" }, 400);
    const requestHash = await paidRequestHash(`/partner/${product}`, body);
    const fingerprint = await sha256(`partner\n${partner}\n${idempotencyKey}`);
    const key = fulfillmentRecordKey(fingerprint);
    const stored = await readFulfillment(c.env, key);
    let claim: StoredFulfillment | undefined;
    if (stored) {
      if (!fulfillmentMatches(stored.record, `/partner/${product}`, requestHash)) {
        return c.json({ error: "idempotency_key_reused_for_different_request" }, 409);
      }
      if (stored.record.state === "complete" && stored.record.response) {
        if (!await validDeliveryDigest(stored.record)) return noStore(c.json({ ok: false, error: "delivery_evidence_inconsistent", retryable: false }, 503));
        return noStore(c.json({ ...stored.record.response, idempotent_replay: true }));
      }
      const recovered = await recoverDelivery(c.env, key, stored, body, product, fingerprint);
      if (recovered) return noStore(c.json({ ...recovered, idempotent_replay: true }));
      if (stored.record.state === "blocked_failure" || stored.record.attempts >= MAX_FULFILLMENT_ATTEMPTS) return noStore(c.json({ ok: false, state: "blocked_failure", error: "fulfillment_requires_review", retryable: false }, 503));
      if (isProcessingFresh(stored.record)) return c.json({ ok: false, state: "processing", retryable: true }, 202);
      if (stored.record.state === "processing") return noStore(c.json({ ok: false, state: "fulfillment_unknown", retryable: false, requires_fulfillment_reconciliation: true }, 503));
    }
    const quote = await quoteProductWithOverride(c.env, product);
    if (stored && (typeof stored.record.paid_price_usd !== "number" || !Number.isFinite(stored.record.paid_price_usd) || stored.record.paid_price_usd <= 0)) {
      return noStore(c.json({ ok: false, state: "fulfillment_unknown", error: "historical_prepaid_amount_requires_reconciliation", retryable: false }, 503));
    }
    const gross = stored?.record.paid_price_usd ?? Number(c.req.header("x-delta-gross-usd"));
    const partnerFloor = product === "preflight" ? Number(c.env.PARTNER_PREFLIGHT_BASE_PRICE_USD || "1") : quote.grossPriceUsd;
    if (!stored && (!Number.isFinite(partnerFloor) || partnerFloor !== 1)) return noStore(c.json({ error: "partner_price_configuration_invalid" }, 503));
    if (!stored && (!Number.isFinite(gross) || gross < partnerFloor)) {
      return c.json({ error: "partner_price_below_floor", minimum_price_usd: partnerFloor }, 402);
    }
    if (!stored && (!Number.isFinite(quote.expectedVariableCostUsd) || quote.expectedVariableCostUsd >= partnerFloor)) {
      return noStore(c.json({ error: "economics_unavailable", retryable: false, price_usd: partnerFloor }, 503));
    }
    const [target, priorManifest] = await Promise.all([
      resolvePublicRedirects(body.url),
      product === "preflight" ? loadPriorManifest(c.env, body as PreflightRequest) : Promise.resolve(undefined),
    ]);
    if (stored) {
      claim = await claimRetry(c.env, key, stored) ?? undefined;
      if (!claim) return c.json({ ok: false, state: "processing", retryable: true }, 202);
    }
    const result = await executeFulfillment({
      env: c.env,
      product,
      body,
      target,
      quote: { ...quote, grossPriceUsd: gross, estimatedContributionMarginUsd: gross - quote.expectedVariableCostUsd },
      channel: sanitizeDimension(c.req.header("x-delta-channel"), "partner"),
      requestHash,
      fingerprint,
      key,
      route: `/partner/${product}`,
      paymentProtocol: "partner-prepaid",
      existingClaim: claim,
      partner,
      priorManifest,
    });
    c.status(result.status as 200 | 202 | 409 | 502 | 503);
    return noStore(c.json(result.body));
  } catch (error) {
    if (error instanceof MetadataReadError || error instanceof StorageWriteError) return noStore(c.json({ ok: false, error: error.message, retryable: false, requires_fulfillment_reconciliation: true }, 503));
    const reason = message(error);
    const status = reason === "request_too_large" || reason === "body_too_large" ? 413 : 400;
    return c.json({ error: reason }, status);
  }
});

app.get("/v1/proofs/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_PATTERN.test(id)) return c.json({ error: "invalid_proof_id" }, 400);
  const object = await c.env.PROOFS.get(`${id}/manifest.json`);
  if (!object) return c.json({ error: "proof_not_found" }, 404);
  const manifest = await object.json<Record<string, unknown>>();
  const integrity = await verifyManifestIntegrity(manifest);
  await recordEvent(c.env, { event: "proof_opened", route: "/v1/proofs/:id", channel: referrerChannel(c.req.raw), success: integrity !== false });
  c.header("x-robots-tag", "noindex, nofollow, noarchive");
  return c.json(publicVerifier(manifest, integrity), integrity === false ? 422 : 200);
});

app.get("/p/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_PATTERN.test(id)) return c.text("Invalid proof id", 400);
  const object = await c.env.PROOFS.get(`${id}/manifest.json`);
  if (!object) return c.text("Proof not found", 404);
  const manifest = await object.json<Record<string, unknown>>();
  const integrity = await verifyManifestIntegrity(manifest);
  const view = publicVerifier(manifest, integrity);
  c.header("x-robots-tag", "noindex, nofollow, noarchive");
  await recordEvent(c.env, { event: "proof_opened", route: "/p/:id", channel: referrerChannel(c.req.raw), success: integrity !== false });
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>DELTA proof ${escapeHtml(id)}</title><style>body{max-width:820px;margin:3rem auto;padding:0 1rem;font:16px/1.5 system-ui;color:#14243a}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef2f6;padding:1rem;border-radius:8px}</style></head><body><h1>DELTA observation proof</h1><p>Verifier status: <strong>${escapeHtml(view.integrity)}</strong>. Raw artifacts are private.</p><pre>${escapeHtml(JSON.stringify(view, null, 2))}</pre><p>DELTA proves what its capture system observed, not that the source statement is true.</p></body></html>`);
});

app.get("/v1/demo", async (c) => {
  const id = c.env.DEMO_PROOF_ID;
  if (!id) return c.json({ error: "demo_not_configured" }, 404);
  return app.fetch(new Request(`${origin(c.env)}/v1/proofs/${id}`, c.req.raw), c.env, c.executionCtx);
});

app.get("/favicon.ico", (c) => c.body(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#132238"/><path d="M16 18h20c9 0 16 7 16 16S45 50 36 50H16V18zm10 9v14h10a7 7 0 0 0 0-14H26z" fill="#63d3c7"/></svg>',
  200,
  { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
));

app.get("/", async (c) => {
  await recordEvent(c.env, { event: "page_view", route: "/", channel: referrerChannel(c.req.raw), success: true });
  return c.html(landingHtml(origin(c.env), c.env.APP_VERSION));
});
app.get("/docs", async (c) => {
  await recordEvent(c.env, { event: "page_view", route: "/docs", channel: referrerChannel(c.req.raw), success: true });
  return c.html(docsHtml(origin(c.env)));
});
for (const slug of USE_CASE_SLUGS) {
  app.get("/use-cases/" + slug, async (c) => {
    const route = "/use-cases/" + slug;
    await recordEvent(c.env, { event: "page_view", route, channel: referrerChannel(c.req.raw), success: true });
    return c.html(useCaseHtml(origin(c.env), slug));
  });
}

app.get("/openapi.json", async (c) => c.json(openApi(
  origin(c.env),
  c.env.APP_VERSION,
  await quoteProductWithOverride(c.env, "capture"),
  await quoteProductWithOverride(c.env, "preflight"),
)));
app.get("/.well-known/openapi.json", (c) => app.fetch(new Request(`${origin(c.env)}/openapi.json`, c.req.raw), c.env, c.executionCtx));

app.get("/.well-known/x402", async (c) => {
  const [captureQuote, preflightQuote] = await Promise.all([
    quoteProductWithOverride(c.env, "capture"),
    quoteProductWithOverride(c.env, "preflight"),
  ]);
  const base = origin(c.env);
  const lastUpdated = new Date().toISOString();
  const canonicalBaseUsdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const rawUsdc = (usd: number) => String(Math.round(usd * 1_000_000));
  const accepts = (amount: string) => [{
    scheme: "exact",
    network: c.env.NETWORK,
    amount,
    asset: canonicalBaseUsdc,
    payTo: c.env.PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2", paymentFlow: "upfront" },
  }];
  return c.json({
    x402Version: 2,
    service: "delta-witness",
    version: c.env.APP_VERSION,
    network: c.env.NETWORK,
    payment_flow: "upfront",
    resources: [
      {
        resource: `${base}/v1/capture`,
        type: "http",
        x402Version: 2,
        accepts: accepts(rawUsdc(captureQuote.grossPriceUsd)),
        lastUpdated,
        method: "POST",
        path: "/v1/capture",
        product: "capture",
        description: "Browser verification and page-state proof for one public URL.",
        mimeType: "application/json",
        serviceName: "delta-witness",
        tags: ["web-evidence", "capture", "verification", "browser-agent"],
        inputSchema: CAPTURE_INPUT_SCHEMA,
        extensions: discoveryFor("capture"),
      },
      {
        resource: `${base}/v1/preflight`,
        type: "http",
        x402Version: 2,
        accepts: accepts(rawUsdc(preflightQuote.grossPriceUsd)),
        lastUpdated,
        method: "POST",
        path: "/v1/preflight",
        product: "guard",
        description: "Deterministic preflight verification against fresh public page state.",
        mimeType: "application/json",
        serviceName: "delta-witness",
        tags: ["preflight", "verification", "agent-safety", "web-evidence"],
        inputSchema: PREFLIGHT_INPUT_SCHEMA,
        extensions: discoveryFor("preflight"),
      },
      {
        resource: `${base}/v1/guarded-action-pilot`,
        type: "http",
        x402Version: 2,
        accepts: accepts("10000000"),
        lastUpdated,
        method: "POST",
        path: "/v1/guarded-action-pilot",
        product: "guarded_action_pilot",
        price_usd: 10,
        description: "Guarded-action evidence pilot covering 1-3 public HTTPS pages and an optional deterministic preflight.",
        mimeType: "application/json",
        serviceName: "delta-witness",
        tags: ["guarded-action", "verification", "workflow-safety", "browser-agent"],
        inputSchema: GUARDED_ACTION_PILOT_INPUT_SCHEMA,
      },
    ],
    openapi: `${base}/openapi.json`,
  });
});
for (const alias of ["/.well-known/x402.json", "/x402.json", "/.well-known/x402/resource-server.json"]) {
  app.get(alias, (c) => app.fetch(new Request(`${origin(c.env)}/.well-known/x402`, c.req.raw), c.env, c.executionCtx));
}
app.get("/.well-known/x402-service.json", (c) => c.json({
  x402: "1.0",
  name: "delta-witness-guarded-action-pilot",
  description: "DELTA Witness guarded-action evidence pilot for browser, shopping, procurement and workflow agents. One exact $10 USDC Base payment captures 1-3 public HTTPS page-state proofs and can run one deterministic preflight condition. No subscription.",
  capabilities: ["guarded-action-pilot", "browser-verification", "page-state-proof", "preflight-verification", "workflow-safety", "shopping", "procurement"],
  pricing: { currency: "USDC", base: "10.00", unit: "pilot" },
  payment: { address: c.env.PAY_TO, chain: "base", network: c.env.NETWORK, facilitator: c.env.FACILITATOR_URL },
  endpoint: `${origin(c.env)}/v1/guarded-action-pilot`,
}));
app.get("/.well-known/agent.json", async (c) => c.json(agentJsonManifest(
  origin(c.env),
  c.env.PAY_TO,
  c.env.FACILITATOR_URL,
  await quoteProductWithOverride(c.env, "capture"),
  await quoteProductWithOverride(c.env, "preflight"),
)));
app.get("/.well-known/api-catalog", (c) => c.json({ name: "DELTA Witness", version: c.env.APP_VERSION, openapi: `${origin(c.env)}/openapi.json`, skill: `${origin(c.env)}/SKILL.md` }));
app.get("/SKILL.md", (c) => c.text(skillMarkdown(origin(c.env)), 200, { "content-type": "text/markdown; charset=utf-8" }));
app.get("/AGENTS.md", (c) => c.text("# DELTA Witness\n\nUse /v1/preflight before consequential actions that depend on public web content. DELTA proves observation/change, not truth.\n", 200, { "content-type": "text/markdown; charset=utf-8" }));
app.get("/llms.txt", (c) => c.text(`# DELTA Witness\n\n> Trust Layer for Autonomous Actions\n\n- [API guide](${origin(c.env)}/docs)\n- [OpenAPI](${origin(c.env)}/openapi.json)\n- [Agent skill](${origin(c.env)}/SKILL.md)\n- [x402 discovery](${origin(c.env)}/.well-known/x402)\n- [Agent preflight](${origin(c.env)}/use-cases/agent-preflight)\n- [$10 Guarded-Action Pilot](${origin(c.env)}/v1/quote?product=guarded-action-pilot)\n- [Terms before purchase](${origin(c.env)}/use-cases/terms-before-purchase)\n- [Source change monitoring](${origin(c.env)}/use-cases/source-change-monitoring)\n- [Base app](https://delta-witness-app.pages.dev/)\n`));
app.get("/llms-full.txt", (c) => app.fetch(new Request(`${origin(c.env)}/llms.txt`, c.req.raw), c.env, c.executionCtx));
app.get("/postman.json", (c) => c.json(postmanCollection(origin(c.env))));
app.get("/distribution.json", (c) => c.json({
  name: "DELTA Witness",
  version: c.env.APP_VERSION,
  positioning: "Trust Layer for Autonomous Actions",
  core: origin(c.env),
  products: {
    capture: { endpoint: `${origin(c.env)}/v1/capture`, billing: "x402-v2-upfront" },
    guard: { endpoint: `${origin(c.env)}/v1/preflight`, billing: "x402-v2-upfront" },
    guarded_action_pilot: { endpoint: `${origin(c.env)}/v1/guarded-action-pilot`, price_usd: 10, max_urls: 3, billing: "x402-v2-upfront" },
    watch: { endpoint: `${c.env.PARTNER_GATEWAY_ORIGIN}/watch`, billing: "authenticated-partner-prepaid-quota" },
  },
  packages: {
    npm_client: { identifier: "delta-witness-ruphussten", version: c.env.APP_VERSION },
    mcp: { identifier: "delta-witness-mcp", version: c.env.APP_VERSION, command: `npx -y delta-witness-mcp@${c.env.APP_VERSION}` },
    pypi: { identifier: "delta-witness-ruphussten", version: c.env.APP_VERSION },
  },
  channels: {
    base_app: {
      url: "https://delta-witness-app.pages.dev/",
      manifest: "https://delta-witness-app.pages.dev/.well-known/farcaster.json",
      billing: "x402-v2-upfront",
    },
  },
  discovery: {
    openapi: `${origin(c.env)}/openapi.json`,
    x402: `${origin(c.env)}/.well-known/x402`,
    agent_json: `${origin(c.env)}/.well-known/agent.json`,
    skill: `${origin(c.env)}/SKILL.md`,
    postman: `${origin(c.env)}/postman.json`,
    mcp_registry: "https://registry.modelcontextprotocol.io/",
  },
}));
app.get("/.well-known/mcp/server.json", (c) => c.json({
  name: "delta-witness-mcp",
  version: c.env.APP_VERSION,
  description: "Paid DELTA Capture and Guard tools for autonomous actions",
  packages: [{ registryType: "npm", identifier: "delta-witness-mcp", version: c.env.APP_VERSION, transport: { type: "stdio" } }],
}));
app.get("/robots.txt", (c) => c.text(`User-agent: *\nAllow: /\nDisallow: /p/\nDisallow: /v1/proofs/\nDisallow: /internal/\nSitemap: ${origin(c.env)}/sitemap.xml\n`));
app.get("/sitemap.xml", (c) => c.text(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin(c.env)}/</loc></url><url><loc>${origin(c.env)}/docs</loc></url>${USE_CASE_SLUGS.map((slug) => `<url><loc>${origin(c.env)}/use-cases/${slug}</loc></url>`).join("")}<url><loc>${origin(c.env)}/distribution.json</loc></url></urlset>`, 200, { "content-type": "application/xml; charset=utf-8" }));
app.get("*", (c, next) => {
  const requestedKey = c.req.path.endsWith(".txt") ? c.req.path.slice(1, -".txt".length) : "";
  return c.env.INDEXNOW_KEY && requestedKey === c.env.INDEXNOW_KEY ? c.text(c.env.INDEXNOW_KEY) : next();
});

app.get("/internal/scheduled/status", async (c) => {
  const headers = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" };
  if (!c.env.INDEXNOW_ADMIN_SECRET) return c.json({ error: "scheduled_admin_not_configured" }, 503, headers);
  const presented = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!(await timingSafeEqualSecret(presented, c.env.INDEXNOW_ADMIN_SECRET))) return c.json({ error: "unauthorized" }, 401, headers);
  if (new URL(c.req.url).search || c.req.header("origin")) return c.json({ error: "scheduled_status_input_forbidden" }, 400, headers);
  const result = await scheduledStatus(c.env);
  return c.json(result, result.ok === true ? 200 : 503, headers);
});

// One private operations surface. No query-string credentials, browser token
// storage, payment authority, arbitrary task execution or proof export is added.
app.use('/internal/operations/*', async (c,next)=>{
  const headers={'cache-control':'private, no-store','x-robots-tag':'noindex, nofollow'};
  if(c.env.OPERATIONS_CLOUD_ENABLED!=='true'||!c.env.OPERATIONS_ADMIN_SECRET)return c.json({error:'operating_control_not_configured'},503,headers);
  if(c.req.header('origin')||c.req.header('payment-signature')||c.req.header('x-payment'))return c.json({error:'operating_input_forbidden'},400,headers);
  const presented=c.req.header('authorization')?.replace(/^Bearer\s+/i,'')??'';
  if(!(await timingSafeEqualSecret(presented,c.env.OPERATIONS_ADMIN_SECRET)))return c.json({error:'unauthorized'},401,headers);
  c.header('cache-control','private, no-store');c.header('x-robots-tag','noindex, nofollow');
  return next();
});
app.get('/internal/operations/status',async c=>{
  if(new URL(c.req.url).search)return c.json({error:'operating_input_forbidden'},400);
  try{return c.json(await operatingStatus(c.env));}catch{return c.json({error:'operating_evidence_unavailable'},503);}
});
app.get('/internal/operations/dashboard',async c=>{
  if(new URL(c.req.url).search)return c.json({error:'operating_input_forbidden'},400);
  try{const snapshot=await operatingStatus(c.env);return c.html(operatingDashboard(snapshot.report),200,{
    'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});}
  catch{return c.json({error:'operating_evidence_unavailable'},503);}
});
app.post('/internal/operations/pulse',async c=>{
  if(new URL(c.req.url).search)return c.json({error:'operating_input_forbidden'},400);
  let input:unknown;try{input=await readOperatingJson(c.req.raw);}catch{return c.json({error:'operating_input_invalid'},400);}
  try{return c.json(await recordOperatingPulse(c.env,input));}catch{return c.json({error:'operating_persistence_unconfirmed'},503);}
});
app.get('/internal/operations/pulse/:id',async c=>{
  if(new URL(c.req.url).search)return c.json({error:'operating_input_forbidden'},400);
  try{return c.json(await operatingPulseReceipt(c.env,c.req.param('id')));}catch{return c.json({error:'operating_evidence_unavailable'},503);}
});
app.all('/internal/operations/treasury/*',c=>handleTreasuryCustody(c.req.raw,c.env));

app.post("/internal/indexnow", async (c) => {
  if (!c.env.INDEXNOW_ADMIN_SECRET) return c.json({ error: "indexnow_admin_not_configured" }, 503);
  const presented = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!(await timingSafeEqualSecret(presented, c.env.INDEXNOW_ADMIN_SECRET))) return c.json({ error: "unauthorized" }, 401);
  try {
    const response = await submitIndexNow(c.env);
    const responseBody = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 1_000);
    return c.json({
      ok: response.ok,
      status: response.status,
      retryable: response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
      upstream_response: responseBody || null,
    }, response.ok ? 200 : 502);
  } catch (error) {
    return c.json({
      ok: false,
      status: null,
      retryable: true,
      error: "indexnow_transport_error",
      detail: message(error).slice(0, 1_000),
    }, 502);
  }
});

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((error, c) => {
  if (error instanceof MetadataReadError || error instanceof StorageWriteError) return noStore(c.json({ ok: false, state: "fulfillment_unknown", error: error.message, retryable: false, requires_fulfillment_reconciliation: true }, 503));
  console.error(JSON.stringify({
    event: "uncaught_request_error",
    path: c.req.path,
    reason: safeErrorCode(error),
  }));
  return c.json({ error: "internal_error" }, 500);
});

async function submitIndexNow(env: RuntimeEnv, signal?: AbortSignal): Promise<Response> {
  if (!env.INDEXNOW_KEY) return new Response("IndexNow key not configured", { status: 503 });
  const base = origin(env);
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stableJson({
      host: new URL(base).hostname,
      key: env.INDEXNOW_KEY,
      keyLocation: `${base}/${env.INDEXNOW_KEY}.txt`,
      urlList: [`${base}/`, `${base}/docs`, ...USE_CASE_SLUGS.map((slug) => `${base}/use-cases/${slug}`), `${base}/openapi.json`, `${base}/SKILL.md`],
    }),
  };
  return signal ? scheduledFetch("https://api.indexnow.org/indexnow", init, signal) : fetch("https://api.indexnow.org/indexnow", init);
}

const MESHKORE_DEFAULT_AGENT_ID = "delta-witness-ruphussten";

function meshKoreDiscoveryCard(env: RuntimeEnv): Record<string, unknown> {
  const base = origin(env);
  const amount = Math.round(Number(env.CAPTURE_BASE_PRICE_USD || "1") * 1_000_000);
  return {
    name: "DELTA Witness",
    endpoint: base,
    category: "security.web-verification",
    description: "Trust layer for autonomous actions: paid public-page capture and deterministic preflight evidence over x402 on Base.",
    tags: ["web-proof", "browser-verification", "preflight", "page-state", "x402", "base", "usdc", "autonomous-agents", "guard", "evidence"],
    accepts: ["application/json"],
    produces: ["application/json"],
    protocols: ["http", "a2a", "x402"],
    pricing: { unit: "request", amount, currency: "USDC", network: "base" },
    availability: { now: true },
    owner_class: "third-party",
    brand: "delta-witness",
  };
}

async function meshKoreHeartbeat(env: RuntimeEnv, signal: AbortSignal): Promise<ScheduledWorkResult> {
  if (!env.MESHKORE_API_KEY) return { outcome: "skipped", reason: "missing_configuration" };
  const agentId = env.MESHKORE_AGENT_ID || MESHKORE_DEFAULT_AGENT_ID;
  const tokenResponse = await scheduledFetch("https://api.meshkore.com/v1/agents/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stableJson({ agent_id: agentId, api_key: env.MESHKORE_API_KEY }),
  }, signal);
  if (!tokenResponse.ok) {
    void tokenResponse.body?.cancel().catch(() => {});
    return { outcome: "degraded", reason: "upstream_rejected", http_status: tokenResponse.status };
  }
  let tokenBody: { token?: unknown };
  try { tokenBody = await readScheduledJson(tokenResponse, signal) as { token?: unknown }; }
  catch (error) { if (signal.aborted) throw error; return { outcome: "degraded", reason: "upstream_invalid_response" }; }
  if (!tokenBody || typeof tokenBody.token !== "string" || !tokenBody.token || tokenBody.token.length > 4_096) return { outcome: "degraded", reason: "upstream_invalid_response" };
  const updateResponse = await scheduledFetch("https://api.meshkore.com/v1/agents/me", {
    method: "PATCH",
    headers: { authorization: `Bearer ${tokenBody.token}`, "content-type": "application/json" },
    body: stableJson({
      endpoint: origin(env),
      description: "Trust layer for autonomous actions: paid public-page capture and deterministic preflight evidence over x402 on Base.",
      capabilities: ["web-proof", "browser-verification", "preflight", "page-state", "x402", "base", "usdc", "autonomous-agents", "guard", "evidence"],
      agent_card: meshKoreDiscoveryCard(env),
    }),
  }, signal);
  void updateResponse.body?.cancel().catch(() => {});
  return { outcome: updateResponse.ok ? "success" : "degraded", reason: updateResponse.ok ? "none" : "upstream_rejected", http_status: updateResponse.status };
}

export { app };

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: RuntimeEnv, ctx: ExecutionContext): Promise<void> {
    if(controller.cron==='*/15 * * * *'&&env.OPERATIONS_CLOUD_ENABLED==='true'&&env.PULSE_WATCHDOG_ENABLED==='true'){
      ctx.waitUntil(pulseWatchdog(env).then(async result=>{
        await recordWatchdogObservation(env,result);
        if(['degraded','recovery_required'].includes(result.outcome))throw new Error('canonical_pulse_watchdog_degraded');
      }));
    }
    ctx.waitUntil(runScheduledOperations(env, controller, {
      meshkore: signal => meshKoreHeartbeat(env, signal),
      watch: async () => {
        const counts = await runDueWatches(env);
        const rejected = counts.checks_rejected + counts.notifications_rejected + counts.inventory_failures > 0;
        const handled = counts.checks_failed + counts.checks_deferred + counts.notifications_failed + counts.notifications_deferred > 0;
        return { outcome: rejected || handled ? "degraded" : "success", reason: rejected ? "watch_items_rejected" : handled ? "watch_items_degraded" : "none", counts };
      },
      indexnow: async signal => {
        if (!env.INDEXNOW_KEY) return { outcome: "skipped", reason: "missing_configuration" };
        const response = await submitIndexNow(env, signal);
        void response.body?.cancel().catch(() => {});
        return { outcome: response.ok ? "success" : "degraded", reason: response.ok ? "none" : "upstream_rejected", http_status: response.status };
      },
    }).then(results => {
      // Every lane completes independently before the provider invocation is
      // marked degraded. No failure disables Cron or starts replacement work.
      if (results.some(result => ["failed", "timeout", "degraded"].includes(result.outcome) ||
          ["unconfirmed", "conflict"].includes(result.observation))) throw new Error("scheduled_operations_degraded");
    }));
  },
} satisfies ExportedHandler<RuntimeEnv>;
