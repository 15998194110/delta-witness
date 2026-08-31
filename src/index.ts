import { Hono, type Context, type Next } from "hono";
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
  reserveInitialFulfillment,
  writeFulfillment,
  type DeliveryResponse,
  type FulfillmentRecord,
  type PaidRequest,
  type PreflightRequest,
} from "./fulfillment";
import { capturePage, storeCapture, verifyManifestIntegrity, type ProofManifest } from "./capture";
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
  docsHtml,
  landingHtml,
  openApi,
  postmanCollection,
  skillMarkdown,
} from "./discovery";
import { getWatch, parseWatchRegistration, registerWatch, runDueWatches } from "./watch";

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
  claimedRecord?: FulfillmentRecord;
  replayAuthorized: boolean;
  priorManifest?: PriorManifest;
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
  return error instanceof Error ? error.message : "internal_error";
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
  const object = await env.PROOFS.get(`${request.prior_proof_id}/manifest.json`);
  if (!object) throw new Error("prior_proof_not_found");
  const manifest = await object.json<PriorManifest>();
  if (!manifest.hashes?.html || !manifest.hashes?.markdown) throw new Error("prior_proof_invalid");
  if (validateTarget(manifest.requested_url).toString() !== request.url) throw new Error("prior_proof_target_mismatch");
  return manifest;
}

async function prevalidate(product: PaidProduct, c: AppContext, next: Next): Promise<Response | void> {
  if (c.req.method !== "POST") return next();
  try {
    const value = await readJsonRequestBounded(
      c.req.raw,
      product === "capture" ? MAX_CAPTURE_BODY_BYTES : MAX_PREFLIGHT_BODY_BYTES,
    );
    const body = product === "capture" ? parseCaptureRequest(value) : parsePreflightRequest(value);
    const [redirectResolution, quote, requestHash, priorManifest] = await Promise.all([
      resolvePublicRedirects(body.url),
      quoteProductWithOverride(c.env, product),
      paidRequestHash(`/v1/${product}`, body),
      product === "preflight" ? loadPriorManifest(c.env, body as PreflightRequest) : Promise.resolve(undefined),
    ]);
    c.set("paidBody", body);
    c.set("redirectResolution", redirectResolution);
    c.set("quote", quote);
    c.set("requestHash", requestHash);
    c.set("channel", referrerChannel(c.req.raw));
    c.set("priorManifest", priorManifest);
    c.set("replayAuthorized", false);
    recordEvent(c.env, {
      event: "qualified_request",
      route: `/v1/${product}`,
      channel: c.var.channel,
      grossUsd: quote.grossPriceUsd,
      success: true,
    });

    const payment = getPaymentHeader(c.req.raw);
    if (!payment) return next();
    const paymentFingerprint = await sha256(payment);
    const key = fulfillmentRecordKey(paymentFingerprint);
    c.set("paymentFingerprint", paymentFingerprint);
    c.set("fulfillmentKey", key);
    const stored = await readFulfillment(c.env, key);
    if (!stored) return next();
    if (!fulfillmentMatches(stored.record, `/v1/${product}`, requestHash)) {
      return c.json({ error: "payment_already_used_for_different_request" }, 409);
    }
    if (stored.record.state === "complete" && stored.record.response) {
      recordEvent(c.env, { event: "repeat_call", route: `/v1/${product}`, channel: c.var.channel, success: true });
      return noStore(c.json({ ...stored.record.response, idempotent_replay: true }));
    }
    if (isProcessingFresh(stored.record)) {
      c.header("retry-after", "5");
      return c.json({ ok: false, state: "processing", retryable: true }, 202);
    }
    const claimed = await claimRetry(c.env, key, stored);
    if (!claimed) {
      c.header("retry-after", "5");
      return c.json({ ok: false, state: "processing", retryable: true }, 202);
    }
    c.set("claimedRecord", claimed);
    c.set("replayAuthorized", true);
    recordEvent(c.env, { event: "repeat_call", route: `/v1/${product}`, channel: c.var.channel, success: true });
    return next();
  } catch (error) {
    const reason = message(error);
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
  if (c.var.replayAuthorized) return next();
  const facilitator = new HTTPFacilitatorClient({ url: c.env.FACILITATOR_URL });
  const server = new x402ResourceServer(facilitator);
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
          ? "Preserve what a public webpage says now with timestamped artifact hashes"
          : "Guard an autonomous action by comparing a fresh public-source observation with deterministic expectations",
        mimeType: "application/json",
        serviceName: "delta-witness",
        tags: ["web", "proof", product, "autonomous-agents"],
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
  if (middlewareResponse instanceof Response) c.res = middlewareResponse;
  if (c.res.status === 402) {
    recordEvent(c.env, {
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
  existingClaim?: FulfillmentRecord;
  partner?: string;
  priorManifest?: PriorManifest;
}): Promise<{ status: number; body: DeliveryResponse | Record<string, unknown> }> {
  const { env, product, route, requestHash, fingerprint, key } = input;
  let record = input.existingClaim;
  if (!record) {
    record = initialFulfillment({
      route,
      requestHash,
      requestedUrl: input.body.url,
      fulfillmentFingerprint: fingerprint,
      paymentFingerprint: input.paymentProtocol === "x402-v2-upfront" ? fingerprint : undefined,
      partner: input.partner,
    });
    if (!(await reserveInitialFulfillment(env, key, record))) {
      const existing = await readFulfillment(env, key);
      if (!existing || !fulfillmentMatches(existing.record, route, requestHash)) {
        return { status: 409, body: { error: "fulfillment_key_conflict" } };
      }
      if (existing.record.state === "complete" && existing.record.response) {
        return { status: 200, body: { ...existing.record.response, idempotent_replay: true } };
      }
      return { status: 202, body: { ok: false, state: "processing", retryable: true } };
    }
  }

  recordEvent(env, {
    event: input.paymentProtocol === "x402-v2-upfront" ? "payment_verified" : "partner_request",
    route,
    channel: input.channel,
    partner: input.partner,
    grossUsd: input.quote.grossPriceUsd,
    success: true,
  });
  recordEvent(env, { event: "capture_started", route, channel: input.channel, partner: input.partner, success: true });

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
    });
    await storeCapture(env, artifacts);
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
    const complete: FulfillmentRecord = {
      ...record,
      state: "complete",
      response,
      updated_at: new Date().toISOString(),
      error: undefined,
    };
    await writeFulfillment(env, key, complete);
    const economics = artifacts.manifest.execution;
    recordEvent(env, {
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
    const reason = message(error).slice(0, 160);
    await writeFulfillment(env, key, {
      ...record,
      state: "retryable_failure",
      error: reason,
      updated_at: new Date().toISOString(),
    });
    recordEvent(env, {
      event: "capture_failed",
      route,
      channel: input.channel,
      partner: input.partner,
      grossUsd: input.quote.grossPriceUsd,
      success: false,
      reason,
    });
    return { status: 502, body: { error: "capture_failed", reason, retryable: true, payment_will_not_be_charged_again: true } };
  }
}

async function paidHandler(product: PaidProduct, c: AppContext): Promise<Response> {
  const paymentFingerprint = c.var.paymentFingerprint;
  const key = c.var.fulfillmentKey;
  if (!paymentFingerprint || !key) return c.json({ error: "settled_payment_identity_missing" }, 500);
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
  });
  c.status(result.status as 200 | 202 | 409 | 500 | 502);
  return noStore(c.json(result.body));
}

app.use("*", async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  c.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  c.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  if (c.req.path.startsWith("/v1/") || c.req.path.endsWith(".json")) {
    c.header("access-control-allow-origin", "*");
  }
});

app.options("/v1/*", (c) => {
  c.header("access-control-allow-origin", "*");
  c.header("access-control-allow-methods", "GET, POST, OPTIONS");
  c.header("access-control-allow-headers", "content-type, payment-signature, x-payment, x-delta-channel");
  c.header("access-control-max-age", "86400");
  return c.body(null, 204);
});

app.get("/health", (c) => c.json({ ok: true, version: c.env.APP_VERSION, network: c.env.NETWORK, ts: new Date().toISOString() }));

app.get("/v1/quote", async (c) => {
  const product = c.req.query("product") === "preflight" ? "preflight" : "capture";
  const quote = await quoteProductWithOverride(c.env, product);
  const channel = referrerChannel(c.req.raw);
  recordEvent(c.env, { event: "quote_issued", route: `/v1/${product}`, channel, grossUsd: quote.grossPriceUsd, success: true });
  return c.json({
    ok: true,
    version: c.env.APP_VERSION,
    price: x402Price(quote),
    network: c.env.NETWORK,
    asset: "USDC",
    pay_to: c.env.PAY_TO,
    payment_flow: "upfront",
    economics: quote,
  });
});

app.use("/v1/capture", (c, next) => prevalidate("capture", c, next));
app.use("/v1/capture", (c, next) => protectWithX402("capture", c, next));
app.post("/v1/capture", (c) => paidHandler("capture", c));

app.use("/v1/preflight", (c, next) => prevalidate("preflight", c, next));
app.use("/v1/preflight", (c, next) => protectWithX402("preflight", c, next));
app.post("/v1/preflight", (c) => paidHandler("preflight", c));

async function partnerAuthorized(c: AppContext, next: Next): Promise<Response | void> {
  if (!c.env.PARTNER_GATEWAY_SECRET) return c.json({ error: "partner_gateway_not_configured" }, 503);
  const presented = c.req.header("x-delta-core-secret") ?? "";
  if (!(await timingSafeEqualSecret(presented, c.env.PARTNER_GATEWAY_SECRET))) return c.json({ error: "unauthorized" }, 401);
  return next();
}

app.use("/internal/partner/*", partnerAuthorized);

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
    c.status(result.status as 200 | 201 | 402 | 409);
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
    const [target, quote, requestHash, priorManifest] = await Promise.all([
      resolvePublicRedirects(body.url),
      quoteProductWithOverride(c.env, product),
      paidRequestHash(`/partner/${product}`, body),
      product === "preflight" ? loadPriorManifest(c.env, body as PreflightRequest) : Promise.resolve(undefined),
    ]);
    const gross = Number(c.req.header("x-delta-gross-usd"));
    if (!Number.isFinite(gross) || gross < quote.grossPriceUsd) {
      return c.json({ error: "partner_price_below_floor", minimum_price_usd: quote.grossPriceUsd }, 402);
    }
    const fingerprint = await sha256(`partner\n${partner}\n${idempotencyKey}`);
    const key = fulfillmentRecordKey(fingerprint);
    const stored = await readFulfillment(c.env, key);
    let claim: FulfillmentRecord | undefined;
    if (stored) {
      if (!fulfillmentMatches(stored.record, `/partner/${product}`, requestHash)) {
        return c.json({ error: "idempotency_key_reused_for_different_request" }, 409);
      }
      if (stored.record.state === "complete" && stored.record.response) {
        return noStore(c.json({ ...stored.record.response, idempotent_replay: true }));
      }
      if (isProcessingFresh(stored.record)) return c.json({ ok: false, state: "processing", retryable: true }, 202);
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
    c.status(result.status as 200 | 202 | 409 | 502);
    return noStore(c.json(result.body));
  } catch (error) {
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
  recordEvent(c.env, { event: "proof_opened", route: "/v1/proofs/:id", channel: referrerChannel(c.req.raw), success: integrity !== false });
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
  recordEvent(c.env, { event: "proof_opened", route: "/p/:id", channel: referrerChannel(c.req.raw), success: integrity !== false });
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>DELTA proof ${escapeHtml(id)}</title><style>body{max-width:820px;margin:3rem auto;padding:0 1rem;font:16px/1.5 system-ui;color:#14243a}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef2f6;padding:1rem;border-radius:8px}</style></head><body><h1>DELTA observation proof</h1><p>Verifier status: <strong>${escapeHtml(view.integrity)}</strong>. Raw artifacts are private.</p><pre>${escapeHtml(JSON.stringify(view, null, 2))}</pre><p>DELTA proves what its capture system observed, not that the source statement is true.</p></body></html>`);
});

app.get("/v1/demo", async (c) => {
  const id = c.env.DEMO_PROOF_ID;
  if (!id) return c.json({ error: "demo_not_configured" }, 404);
  return app.fetch(new Request(`${origin(c.env)}/v1/proofs/${id}`, c.req.raw), c.env, c.executionCtx);
});

app.get("/", (c) => {
  recordEvent(c.env, { event: "page_view", route: "/", channel: referrerChannel(c.req.raw), success: true });
  return c.html(landingHtml(origin(c.env), c.env.APP_VERSION));
});
app.get("/docs", (c) => {
  recordEvent(c.env, { event: "page_view", route: "/docs", channel: referrerChannel(c.req.raw), success: true });
  return c.html(docsHtml(origin(c.env)));
});
app.get("/use-cases/agent-preflight", (c) => {
  recordEvent(c.env, { event: "page_view", route: "/use-cases/agent-preflight", channel: referrerChannel(c.req.raw), success: true });
  return c.html(docsHtml(origin(c.env)));
});

app.get("/openapi.json", async (c) => c.json(openApi(
  origin(c.env),
  c.env.APP_VERSION,
  await quoteProductWithOverride(c.env, "capture"),
  await quoteProductWithOverride(c.env, "preflight"),
)));
app.get("/.well-known/openapi.json", (c) => app.fetch(new Request(`${origin(c.env)}/openapi.json`, c.req.raw), c.env, c.executionCtx));

app.get("/.well-known/x402", async (c) => c.json({
  x402Version: 2,
  service: "delta-witness",
  version: c.env.APP_VERSION,
  network: c.env.NETWORK,
  payment_flow: "upfront",
  resources: [
    { method: "POST", path: "/v1/capture", product: "capture", inputSchema: CAPTURE_INPUT_SCHEMA },
    { method: "POST", path: "/v1/preflight", product: "guard", inputSchema: PREFLIGHT_INPUT_SCHEMA },
  ],
  openapi: `${origin(c.env)}/openapi.json`,
}));
for (const alias of ["/.well-known/x402.json", "/x402.json", "/.well-known/x402/resource-server.json"]) {
  app.get(alias, (c) => app.fetch(new Request(`${origin(c.env)}/.well-known/x402`, c.req.raw), c.env, c.executionCtx));
}
app.get("/.well-known/api-catalog", (c) => c.json({ name: "DELTA Witness", version: c.env.APP_VERSION, openapi: `${origin(c.env)}/openapi.json`, skill: `${origin(c.env)}/SKILL.md` }));
app.get("/SKILL.md", (c) => c.text(skillMarkdown(origin(c.env)), 200, { "content-type": "text/markdown; charset=utf-8" }));
app.get("/AGENTS.md", (c) => c.text("# DELTA Witness\n\nUse /v1/preflight before consequential actions that depend on public web content. DELTA proves observation/change, not truth.\n", 200, { "content-type": "text/markdown; charset=utf-8" }));
app.get("/llms.txt", (c) => c.text(`# DELTA Witness\n\n> Trust Layer for Autonomous Actions\n\n- [API guide](${origin(c.env)}/docs)\n- [OpenAPI](${origin(c.env)}/openapi.json)\n- [Agent skill](${origin(c.env)}/SKILL.md)\n- [x402 discovery](${origin(c.env)}/.well-known/x402)\n`));
app.get("/postman.json", (c) => c.json(postmanCollection(origin(c.env))));
app.get("/distribution.json", (c) => c.json({
  name: "DELTA Witness",
  version: c.env.APP_VERSION,
  positioning: "Trust Layer for Autonomous Actions",
  core: origin(c.env),
  products: {
    capture: { endpoint: `${origin(c.env)}/v1/capture`, billing: "x402-v2-upfront" },
    guard: { endpoint: `${origin(c.env)}/v1/preflight`, billing: "x402-v2-upfront" },
    watch: { endpoint: `${c.env.PARTNER_GATEWAY_ORIGIN}/watch`, billing: "authenticated-partner-prepaid-quota" },
  },
  packages: {
    npm_client: { identifier: "delta-witness-ruphussten", version: c.env.APP_VERSION },
    mcp: { identifier: "delta-witness-mcp", version: c.env.APP_VERSION, command: `npx -y delta-witness-mcp@${c.env.APP_VERSION}` },
    pypi: { identifier: "delta-witness-ruphussten", version: c.env.APP_VERSION },
  },
  discovery: {
    openapi: `${origin(c.env)}/openapi.json`,
    x402: `${origin(c.env)}/.well-known/x402`,
    skill: `${origin(c.env)}/SKILL.md`,
    postman: `${origin(c.env)}/postman.json`,
  },
}));
app.get("/.well-known/mcp/server.json", (c) => c.json({
  name: "delta-witness-mcp",
  version: c.env.APP_VERSION,
  description: "Paid DELTA Capture and Guard tools for autonomous actions",
  packages: [{ registryType: "npm", identifier: "delta-witness-mcp", version: c.env.APP_VERSION, transport: { type: "stdio" } }],
}));
app.get("/robots.txt", (c) => c.text(`User-agent: *\nAllow: /\nDisallow: /p/\nDisallow: /v1/proofs/\nDisallow: /internal/\nSitemap: ${origin(c.env)}/sitemap.xml\n`));
app.get("/sitemap.xml", (c) => c.text(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin(c.env)}/</loc></url><url><loc>${origin(c.env)}/docs</loc></url><url><loc>${origin(c.env)}/use-cases/agent-preflight</loc></url><url><loc>${origin(c.env)}/distribution.json</loc></url></urlset>`, 200, { "content-type": "application/xml; charset=utf-8" }));
app.get("/:key.txt", (c, next) => c.env.INDEXNOW_KEY && c.req.param("key") === c.env.INDEXNOW_KEY ? c.text(c.env.INDEXNOW_KEY) : next());

app.post("/internal/indexnow", async (c) => {
  if (!c.env.INDEXNOW_ADMIN_SECRET) return c.json({ error: "indexnow_admin_not_configured" }, 503);
  const presented = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!(await timingSafeEqualSecret(presented, c.env.INDEXNOW_ADMIN_SECRET))) return c.json({ error: "unauthorized" }, 401);
  const response = await submitIndexNow(c.env);
  return c.json({ ok: response.ok, status: response.status }, response.ok ? 200 : 502);
});

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((error, c) => {
  console.error(JSON.stringify({
    event: "uncaught_request_error",
    path: c.req.path,
    message: message(error),
    stack: error instanceof Error ? error.stack : undefined,
  }));
  return c.json({ error: "internal_error" }, 500);
});

async function submitIndexNow(env: RuntimeEnv): Promise<Response> {
  if (!env.INDEXNOW_KEY) return new Response("IndexNow key not configured", { status: 503 });
  const base = origin(env);
  return fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stableJson({
      host: new URL(base).hostname,
      key: env.INDEXNOW_KEY,
      keyLocation: `${base}/${env.INDEXNOW_KEY}.txt`,
      urlList: [`${base}/`, `${base}/docs`, `${base}/use-cases/agent-preflight`, `${base}/openapi.json`, `${base}/SKILL.md`],
    }),
  });
}

export { app };

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: RuntimeEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDueWatches(env));
    const scheduled = new Date(controller.scheduledTime);
    if (scheduled.getUTCHours() === 3 && scheduled.getUTCMinutes() < 15) {
      ctx.waitUntil(submitIndexNow(env).then(async (response) => {
        if (!response.ok) console.error(JSON.stringify({ event: "indexnow_failed", status: response.status }));
        await response.body?.cancel();
      }));
    }
  },
} satisfies ExportedHandler<RuntimeEnv>;
