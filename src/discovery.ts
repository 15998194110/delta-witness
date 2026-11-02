import { conversionLandingHtml, conversionDocsHtml } from "./conversion-pages";
import type { PricingQuote } from "./pricing";

export const CAPTURE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: { type: "string", pattern: "^https?://", description: "Public HTTP(S) webpage to observe." },
  },
  required: ["url"],
} as const;

export const PREFLIGHT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: { type: "string", pattern: "^https?://", description: "Public HTTP(S) source to observe before an action." },
    prior_proof_id: { type: "string", pattern: "^[0-9a-fA-F-]{36}$", description: "Optional DELTA proof to use as the hash baseline." },
    expected: {
      type: "object",
      additionalProperties: false,
      properties: {
        html_sha256: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        markdown_sha256: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        contains: { type: "array", maxItems: 10, items: { type: "string", maxLength: 200 } },
        excludes: { type: "array", maxItems: 10, items: { type: "string", maxLength: 200 } },
      },
    },
    freshness_seconds: { type: "integer", minimum: 0, maximum: 2_592_000 },
  },
  required: ["url"],
} as const;

export const GUARDED_ACTION_PILOT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    urls: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { type: "string", pattern: "^https://", description: "Public HTTPS webpage to witness." },
    },
    preflight: {
      type: "object",
      additionalProperties: false,
      properties: {
        url_index: { type: "integer", minimum: 0, maximum: 2 },
        expected: PREFLIGHT_INPUT_SCHEMA.properties.expected,
      },
      required: ["url_index", "expected"],
    },
  },
  required: ["urls"],
} as const;

export const GUARDED_ACTION_PILOT_OUTPUT_SCHEMA = {
  type: "object",
  required: ["ok", "product", "price_usd", "proofs", "economics"],
  properties: {
    ok: { const: true },
    product: { const: "guarded_action_pilot" },
    price_usd: { const: 10 },
    proofs: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        required: ["url", "proof_id", "manifest_url", "public_proof_url", "bundle_root", "observed_at", "allocated_price_usd"],
        properties: {
          url: { type: "string" },
          proof_id: { type: "string" },
          manifest_url: { type: "string" },
          public_proof_url: { type: "string" },
          bundle_root: { type: "string" },
          observed_at: { type: "string" },
          allocated_price_usd: { type: "number" },
        },
      },
    },
    preflight: { type: "object" },
    economics: { type: "object" },
    idempotent_replay: { type: "boolean" },
  },
} as const;

export const DELIVERY_SCHEMA = {
  type: "object",
  required: ["ok", "product", "proof_id", "manifest_url", "public_proof_url", "bundle_root", "observed_at"],
  properties: {
    ok: { const: true },
    product: { enum: ["capture", "preflight"] },
    proof_id: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" },
    manifest_url: { type: "string", pattern: "^https?://" },
    public_proof_url: { type: "string", pattern: "^https?://" },
    bundle_root: { type: "string" },
    observed_at: { type: "string" },
    safe: { type: ["boolean", "null"] },
    changed: { type: ["boolean", "null"] },
    reason: { type: "string" },
    diff: { type: "object" },
    idempotent_replay: { type: "boolean" },
  },
} as const;

export function openApi(origin: string, version: string, capture: PricingQuote, preflight: PricingQuote): Record<string, unknown> {
  const orderEnrollment = [
    { name: "x-delta-order-id", in: "header", required: false, schema: { type: "string", format: "uuid" }, description: "Optional UUIDv4 business order. Send together with x-delta-recovery-token. Persist both privately before authorizing payment. Available only when the operator explicitly configures an order credential lifetime." },
    { name: "x-delta-retention-policy-hash", in: "header", required: false, schema: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" }, description: "For new scoped orders with configured retention terms: accept the policy hash disclosed in quote/402. Persist before the first authorized payment. A 409 terms change never permits re-signing an uncertain payment. Existing orders retain their original snapshot." },
    { name: "x-delta-recovery-token", in: "header", required: false, schema: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" }, description: "Optional canonical base64url encoding of 32 cryptographically random bytes; paired with x-delta-order-id. Never put this bearer capability in a URL, log, public proof or model response." },
  ];
  const orderParameter = { name: "order_id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
  const exportAuthorizationSchema = { type: "object", additionalProperties: false, required: ["ok", "order_id", "authorization"], properties: {
    ok: { const: true }, order_id: { type: "string", format: "uuid" }, authorization: { oneOf: [{ type: "null" }, {
      type: "object", additionalProperties: false, required: ["operation_id", "generation", "expires_at", "scope", "state"], properties: {
        operation_id: { type: "string", format: "uuid" }, generation: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        expires_at: { type: "string", format: "date-time" }, scope: { const: ["export"] }, state: { enum: ["active", "expired"] },
      },
    }] },
  } };
  const exportAuthorizationResponses = {
    "200": { description: "Current authorization metadata or the same completed update; no credential bytes", content: { "application/json": { schema: exportAuthorizationSchema } } },
    "400": { description: "Invalid bounded update input or forbidden payment headers" },
    "403": { description: "Original capability lacks export scope" },
    "404": { description: "Original capability unavailable; a child export credential cannot manage authorization" },
    "409": { description: "Generation or operation conflict; reconcile the saved original operation before another update" },
    "410": { description: "Original capability or raw retention expired; no extension is granted" },
    "503": { description: "Original evidence or update outcome unknown; keep the saved operation and read back without another payment" },
  };
  const orderResponses = {
    "200": { description: "Original delivery verified, or authenticated raw_artifacts_expired metadata without delivery bytes", content: { "application/json": { schema: { $ref: "#/components/schemas/OrderStatus" } } } },
    "202": { description: "Original outcome remains incomplete or uncertain; never permission to pay again", content: { "application/json": { schema: { $ref: "#/components/schemas/OrderStatus" } } } },
    "400": { description: "Payment headers, body or query credentials are not accepted" },
    "403": { description: "Capability does not include this scope" },
    "404": { description: "Order or capability unavailable. This does not establish non-payment." },
    "410": { description: "Correct capability has expired. Original evidence is retained." },
    "503": { description: "Evidence unavailable, inconsistent or deadline exceeded. Reconciliation required." },
  };
  const error = { description: "Request rejected", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } };
  const paidResponses = {
    "200": { description: "Paid observation delivered", content: { "application/json": { schema: DELIVERY_SCHEMA } } },
    "202": { description: "An identical settled fulfillment is already in progress" },
    "400": error,
    "402": { description: "x402 v2 payment challenge or explicit verification rejection; not evidence of non-payment after an uncertain attempt" },
    "409": { description: "Payment replay attempted with a different request" },
    "413": error,
    "502": { description: "Settled observation failed; identical retry remains idempotent" },
    "503": { description: "Payment or delivery outcome uncertain, or optional order capability not configured; do not authorize another payment" },
  };
  const paymentInfo = (quote: PricingQuote) => ({
    price: {
      mode: "fixed",
      currency: "USD",
      amount: quote.grossPriceUsd.toFixed(6).replace(/0+$/, "").replace(/\.$/, ""),
    },
    protocols: [{ x402: {} }],
    network: "eip155:8453",
  });
  return {
    openapi: "3.1.0",
    info: {
      title: "DELTA Witness — Trust Layer for Autonomous Actions",
      version,
      description: "Browser verification and page-state proof for public sources, plus deterministic preflight checks before an autonomous action. DELTA proves observation and change, not truth.",
      contact: { name: "DELTA Witness", email: "ruphussten@163.com", url: `${origin}/docs` },
      "x-guidance": "Call GET /v1/quote before budgeting. Capture preserves a public observation; Guard compares one with deterministic expectations; Guarded-Action Pilot bundles 1-3 public URL proofs for exactly $10. Runtime HTTP 402 payment requirements are authoritative.",
    },
    servers: [{ url: origin }],
    components: {
      securitySchemes: { OrderCapability: { type: "apiKey", in: "header", name: "x-delta-recovery-token", description: "Buyer-created scoped bearer credential persisted before payment. Public proof IDs and public payment signatures are not credentials." } },
      schemas: { OrderStatus: {
        type: "object", required: ["ok", "order_id", "product", "state", "payment", "fulfillment", "recovery"],
        properties: {
          ok: { const: true }, order_id: { type: "string", format: "uuid" }, product: { enum: ["capture", "preflight"] },
          state: { enum: ["complete", "recovery_available", "processing", "retryable_failure", "blocked_failure", "settlement_unknown", "settlement_rejected", "settlement_confirmed", "raw_artifacts_expired"] },
          retention: { type: "object", description: "Original policy evaluation; raw expiry does not delete files or extend the independent credential lifetime.", properties: {
            state: { enum: ["legacy_policy_unknown", "allowed_by_retention", "pending_start", "expired"] }, raw_expires_at: { type: ["string", "null"] }, export_allowed: { type: ["boolean", "null"] }, timeline: { type: ["object", "null"] },
          } },
          payment: { type: "object", required: ["state", "treasury_received"], properties: { state: { enum: ["settlement_unknown", "settlement_rejected", "settlement_confirmed"] }, treasury_received: { type: "null", description: "Facilitator settlement does not establish separately reconciled treasury receipt." } } },
          fulfillment: { type: "object", required: ["state"], properties: { state: { enum: ["not_started", "processing", "retryable_failure", "blocked_failure", "complete", "recovery_available"] } } },
          recovery: { type: "object", required: ["expires_at", "can_recover"], properties: { expires_at: { type: "string", format: "date-time" }, can_recover: { type: "boolean" } } },
          delivery: DELIVERY_SCHEMA, reconciliation_required: { type: "boolean" },
        },
      } },
    },
    paths: {
      "/health": { get: { operationId: "health", security: [], responses: { "200": { description: "Healthy" } } } },
      "/v1/quote": { get: { operationId: "quote", security: [], parameters: [{ name: "product", in: "query", schema: { enum: ["capture", "preflight", "guarded-action-pilot"] } }], responses: { "200": { description: "Current floor-aware quote or exact pilot package quote" } } } },
      "/v1/capture": {
        post: {
          operationId: "browserVerificationPageStateProof",
          summary: "Browser verification and page-state proof for a public URL",
          description: `Capture what a public page says now and return timestamped proof metadata and hashes. Useful for browser verification and page state proof. x402 v2 upfront settlement. Current calculated price: $${capture.grossPriceUsd}.`,
          tags: ["browser verification", "page state proof", "web capture"],
          security: [],
          parameters: orderEnrollment,
          "x-payment-info": paymentInfo(capture),
          requestBody: { required: true, content: { "application/json": { schema: CAPTURE_INPUT_SCHEMA } } },
          responses: paidResponses,
        },
      },
      "/v1/preflight": {
        post: {
          operationId: "preflightAutonomousAction",
          summary: "Preflight a public source before an autonomous action",
          description: `Verify page state before an agent executes a consequential autonomous action. Returns safe/changed/reason/diff plus a proof reference. Current calculated price: $${preflight.grossPriceUsd}.`,
          tags: ["preflight autonomous action", "browser verification", "agent guard"],
          security: [],
          parameters: orderEnrollment,
          "x-payment-info": paymentInfo(preflight),
          requestBody: { required: true, content: { "application/json": { schema: PREFLIGHT_INPUT_SCHEMA } } },
          responses: paidResponses,
        },
      },
      "/v1/guarded-action-pilot": {
        post: {
          operationId: "guardedActionPilot",
          summary: "Buy one guarded-action evidence pilot for exactly $10",
          description: "Capture 1-3 public HTTPS pages as timestamped DELTA proofs and optionally run one deterministic preflight check. One x402 v2 upfront payment of exactly $10 USDC on Base covers the package.",
          tags: ["guarded-action-pilot", "browser-agent-pilot", "page-state-evidence-bundle", "preflight-verification", "shopping", "procurement", "workflow-safety"],
          security: [],
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: "10" },
            protocols: [{ x402: {} }],
            network: "eip155:8453",
          },
          requestBody: { required: true, content: { "application/json": { schema: GUARDED_ACTION_PILOT_INPUT_SCHEMA } } },
          responses: {
            "200": { description: "Guarded-action evidence package delivered", content: { "application/json": { schema: GUARDED_ACTION_PILOT_OUTPUT_SCHEMA } } },
            "202": { description: "Identical settled fulfillment already in progress" },
            "400": error,
            "402": { description: "Exact $10 x402 v2 payment required" },
            "409": { description: "Payment replay attempted with a different request" },
            "413": error,
            "502": { description: "Settled pilot failed; identical retry remains idempotent" },
          },
        },
      },
      "/v1/orders/{order_id}": { get: {
        operationId: "getOrderStatus", summary: "Authenticate and verify the original order without payment",
        description: "Opt-in Capture/Guard capability only. Legacy orders cannot enroll retrospectively from a public payment signature. A 404 or uncertain result never permits automatic repayment.",
        security: [{ OrderCapability: [] }], parameters: [orderParameter], responses: orderResponses,
      } },
      "/v1/orders/{order_id}/recover": { post: {
        operationId: "recoverOriginalOrder", summary: "Complete delivery from verified original evidence",
        description: "No body or payment signature. Reuses only the original verified draft and artifacts; never settles, signs, captures again or re-evaluates Guard. Supports safely repeating concurrent recovery calls.",
        security: [{ OrderCapability: [] }], parameters: [orderParameter], responses: orderResponses,
      } },
      "/v1/orders/{order_id}/export-authorization": {
        get: { operationId: "getExportAuthorization", summary: "Read the original order's current export authorization metadata",
          description: "Requires the still-valid original capability. Returns no token or digest; no authorization is represented by authorization=null. Reconcile the same privately saved operation after a lost update response.",
          security: [{ OrderCapability: [] }], parameters: [orderParameter], responses: exportAuthorizationResponses },
        post: { operationId: "updateExportAuthorization", summary: "Update an export-only credential without paying again",
          description: "Persist the new random token and operation ID privately before this call. Requires the original capability and expected generation; the child credential grants only original-artifact export. Its lifetime is bounded by the requested 60–3600 seconds, original capability and original raw retention. It does not change the original payment, authority or retention. Unknown outcomes must be read back before any new update.",
          security: [{ OrderCapability: [] }], parameters: [orderParameter],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false,
            required: ["operation_id", "token", "ttl_seconds", "expected_generation"], properties: {
              operation_id: { type: "string", format: "uuid" }, token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$", writeOnly: true },
              ttl_seconds: { type: "integer", minimum: 60, maximum: 3600 }, expected_generation: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 },
            },
          } } } }, responses: { ...exportAuthorizationResponses,
            "201": { description: "One new export authorization generation committed; metadata only", content: { "application/json": { schema: exportAuthorizationSchema } } } },
        },
      },
      "/v1/orders/{order_id}/artifacts/{artifact}": { get: {
        operationId: "exportOrderArtifact", summary: "Download an original artifact with a scoped buyer capability",
        description: "Requires a complete verified order and export scope, using the original capability or its current valid export-only child credential in the same private header. Raw artifacts remain private; downloads are attachments, uncached and bounded. No payment or Browser work. Older status/recover-only capabilities do not gain export scope.",
        security: [{ OrderCapability: [] }], parameters: [orderParameter, { name: "artifact", in: "path", required: true, schema: { enum: ["html", "markdown", "screenshot", "manifest"] } }],
        responses: { ...orderResponses, "200": { description: "Verified original bytes; Content-Disposition: attachment; private, no-store", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } }, "image/png": { schema: { type: "string", format: "binary" } }, "application/json": { schema: { type: "object" } } } }, "409": { description: "Original delivery incomplete or authorization changed" } },
      } },
      "/v1/proofs/{proof_id}": {
        get: {
          operationId: "verifyProof",
          summary: "Read public proof metadata and hashes (raw artifacts remain private)",
          security: [],
          parameters: [{ name: "proof_id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Verifier metadata" }, "404": { description: "Not found" } },
        },
      },
      "/v1/demo": { get: { operationId: "getDemoProof", security: [], responses: { "200": { description: "Known free proof example" } } } },
    },
  };
}

export function skillMarkdown(origin: string): string {
  return `---
name: delta-witness
description: Paid evidence checkpoint for autonomous actions that depend on mutable public web sources.
homepage: ${origin}
---

# DELTA Witness

Use DELTA at the decision boundary: immediately before an autonomous action that depends on a public webpage which may change between planning and execution.

## Agent decision rule

Call DELTA when all three are true:
1. A consequential action is about to happen (purchase, procurement, submission, publication, approval, or similar).
2. The action depends on a public HTTP(S) source.
3. A stale or changed source would materially alter the decision or create an audit gap.

Do not call DELTA merely for browsing, discovery, or low-consequence reading. DELTA records what its capture system observed; it does not decide whether a source is truthful, legal, or trustworthy.

For recurring workflows, call DELTA again at each decision boundary when the source can change. Do not treat an older proof as current evidence.

## Products

- Capture: \`POST ${origin}/v1/capture\` with \`{"url":"https://example.com"}\`.
- Guard: \`POST ${origin}/v1/preflight\` with a URL plus a prior proof, expected hash, or textual expectations.
- $10 Guarded-Action Pilot: \`POST ${origin}/v1/guarded-action-pilot\` with 1-3 public HTTPS URLs and an optional deterministic preflight on one URL. No subscription.
- Watch: available only through authenticated prepaid partner gateways; quota is finite and every scheduled check must remain margin-positive.
- Payment: x402 v2 on Base mainnet USDC, settled before capture work.
- Semantics: \`safe\` means supplied deterministic expectations matched. DELTA proves observation/change, not source truth.

Read \`${origin}/openapi.json\` for exact schemas and \`${origin}/docs\` for client flow.
`;
}

export function landingHtml(origin: string, version: string): string {
  return conversionLandingHtml(origin, version);
}

export function docsHtml(origin: string): string {
  return conversionDocsHtml(origin);
}

export const USE_CASE_SLUGS = [
  "agent-preflight",
  "terms-before-purchase",
  "source-change-monitoring",
] as const;

type UseCaseSlug = typeof USE_CASE_SLUGS[number];

const USE_CASE_COPY: Record<UseCaseSlug, { title: string; description: string; problem: string; workflow: string; boundary: string }> = {
  "agent-preflight": {
    title: "Preflight public inputs before an autonomous action",
    description: "Guard an agent workflow by observing the source URL immediately before buying, publishing, deploying, or submitting.",
    problem: "An agent may plan from cached search results or an earlier page state. If price, eligibility, instructions, or terms change before execution, the action can be validly formed but based on stale input.",
    workflow: "Call DELTA Guard with the public URL and deterministic expectations. Continue only when safe is true; otherwise inspect changed, reason, diff, and the proof reference. Retries of the same settled request are idempotent.",
    boundary: "DELTA certifies what its capture system observed and whether supplied rules matched. It does not certify that the publisher is honest or that a statement is legally correct.",
  },
  "terms-before-purchase": {
    title: "Record public terms immediately before a purchase",
    description: "Capture price, refund, cancellation, or service terms before software authorizes a consequential purchase.",
    problem: "Checkout automation often depends on public terms that can change independently of the buyer's workflow. A later screenshot cannot establish which page state the automation actually evaluated.",
    workflow: "Use Guard with explicit required and forbidden text, or compare against a prior DELTA proof. The returned timestamp, hashes, observed status, and deterministic diff can travel with the purchasing system's audit record.",
    boundary: "A matching observation is not legal advice, merchant endorsement, or proof that off-page promises will be honored. It is a bounded record of the public source DELTA observed.",
  },
  "source-change-monitoring": {
    title: "Detect and certify changes to a public source",
    description: "Use finite prepaid Watch checks to observe a public policy, specification, price page, or machine-readable source on a controlled schedule.",
    problem: "Unbounded free polling creates open-ended cost and weak incentives. Teams still need a reliable signal when a source that controls downstream actions changes.",
    workflow: "A billing platform or reseller prepays a finite quota through the authenticated partner gateway. DELTA checks no more often than every 15 minutes, sends HMAC-signed webhooks, decrements quota, and pauses when the prepaid unit price falls below the live cost floor.",
    boundary: "Watch reports observed change, not real-world truth. Raw HTML, Markdown, and screenshots remain private; public verifier pages expose metadata and hashes only.",
  },
};

export function useCaseHtml(origin: string, slug: UseCaseSlug): string {
  const copy = USE_CASE_COPY[slug];
  return '<!doctype html><html lang="en" itemscope itemtype="https://schema.org/TechArticle"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'
    + copy.title + ' — DELTA Witness</title><meta name="description" content="' + copy.description
    + '"><link rel="canonical" href="' + origin + '/use-cases/' + slug
    + '"><style>body{max-width:820px;margin:3rem auto;padding:0 1.25rem;font:16px/1.6 system-ui;color:#14243a}code,pre{background:#eef2f6;border-radius:6px}code{padding:.12rem .3rem}pre{padding:1rem;overflow:auto}a{color:#0759c7}.eyebrow{color:#53657a}</style></head><body><p class="eyebrow">DELTA Witness · Trust Layer for Autonomous Actions</p><h1 itemprop="headline">'
    + copy.title + '</h1><p itemprop="description">' + copy.description
    + '</p><h2>The failure mode</h2><p>' + copy.problem + '</p><h2>Machine workflow</h2><p>' + copy.workflow
    + '</p><pre>POST ' + origin + '/v1/preflight&#10;content-type: application/json&#10;&#10;{"url":"https://example.com/terms","expected":{"contains":["Refund window: 30 days"]}}</pre><h2>Evidence boundary</h2><p>'
    + copy.boundary + '</p><p><a href="' + origin + '/docs">Read the API guide</a> · <a href="' + origin
    + '/openapi.json">OpenAPI 3.1</a> · <a href="' + origin + '/v1/quote?product=preflight">Live Guard quote</a></p></body></html>';
}

export function postmanCollection(origin: string): Record<string, unknown> {
  return {
    info: {
      name: "DELTA Witness",
      description: "Capture and Guard observations using x402 v2 and Base mainnet USDC.",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    variable: [{ key: "baseUrl", value: origin }],
    item: [
      { name: "Health", request: { method: "GET", url: "{{baseUrl}}/health" } },
      { name: "Quote", request: { method: "GET", url: "{{baseUrl}}/v1/quote?product=preflight" } },
      { name: "Demo", request: { method: "GET", url: "{{baseUrl}}/v1/demo" } },
      {
        name: "Capture",
        request: { method: "POST", header: [{ key: "Content-Type", value: "application/json" }], body: { mode: "raw", raw: "{\"url\":\"https://example.com\"}" }, url: "{{baseUrl}}/v1/capture" },
      },
      {
        name: "Guard / Preflight",
        request: { method: "POST", header: [{ key: "Content-Type", value: "application/json" }], body: { mode: "raw", raw: "{\"url\":\"https://example.com\",\"expected\":{\"contains\":[\"Example Domain\"]}}" }, url: "{{baseUrl}}/v1/preflight" },
      },
      {
        name: "$10 Guarded-Action Pilot",
        request: { method: "POST", header: [{ key: "Content-Type", value: "application/json" }], body: { mode: "raw", raw: "{\"urls\":[\"https://example.com\"],\"preflight\":{\"url_index\":0,\"expected\":{\"contains\":[\"Example Domain\"]}}}" }, url: "{{baseUrl}}/v1/guarded-action-pilot" },
      },
    ],
  };
}

