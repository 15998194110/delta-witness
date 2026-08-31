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
  const error = { description: "Request rejected", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } };
  const paidResponses = {
    "200": { description: "Paid observation delivered", content: { "application/json": { schema: DELIVERY_SCHEMA } } },
    "202": { description: "An identical settled fulfillment is already in progress" },
    "400": error,
    "402": { description: "x402 v2 payment required or settlement failed" },
    "409": { description: "Payment replay attempted with a different request" },
    "413": error,
    "502": { description: "Settled observation failed; identical retry remains idempotent" },
  };
  const paymentInfo = (quote: PricingQuote) => ({
    price: {
      mode: "fixed",
      currency: "USD",
      amount: quote.grossPriceUsd.toFixed(6).replace(/0+$/, "").replace(/\.$/, ""),
    },
    protocols: ["x402"],
    network: "eip155:8453",
  });
  return {
    openapi: "3.1.0",
    info: {
      title: "DELTA Witness — Trust Layer for Autonomous Actions",
      version,
      description: "Capture public source observations and run deterministic preflight checks. DELTA proves observation and change, not truth.",
    },
    servers: [{ url: origin }],
    paths: {
      "/health": { get: { operationId: "health", responses: { "200": { description: "Healthy" } } } },
      "/v1/quote": { get: { operationId: "quote", parameters: [{ name: "product", in: "query", schema: { enum: ["capture", "preflight"] } }], responses: { "200": { description: "Current floor-aware quote" } } } },
      "/v1/capture": {
        post: {
          operationId: "capturePublicSource",
          summary: "Preserve what a public page says now",
          description: `x402 v2 upfront settlement. Current calculated price: $${capture.grossPriceUsd}.`,
          "x-payment-info": paymentInfo(capture),
          requestBody: { required: true, content: { "application/json": { schema: CAPTURE_INPUT_SCHEMA } } },
          responses: paidResponses,
        },
      },
      "/v1/preflight": {
        post: {
          operationId: "guardAutonomousAction",
          summary: "Observe a public source and compare it with a deterministic baseline",
          description: `Returns safe/changed/reason/diff plus a proof reference. Current calculated price: $${preflight.grossPriceUsd}.`,
          "x-payment-info": paymentInfo(preflight),
          requestBody: { required: true, content: { "application/json": { schema: PREFLIGHT_INPUT_SCHEMA } } },
          responses: paidResponses,
        },
      },
      "/v1/proofs/{proof_id}": {
        get: {
          operationId: "verifyProof",
          summary: "Read public proof metadata and hashes (raw artifacts remain private)",
          parameters: [{ name: "proof_id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Verifier metadata" }, "404": { description: "Not found" } },
        },
      },
      "/v1/demo": { get: { operationId: "getDemoProof", responses: { "200": { description: "Known free proof example" } } } },
    },
  };
}

export function skillMarkdown(origin: string): string {
  return `---
name: delta-witness
description: Observe public web sources and guard consequential autonomous actions with timestamped hashes.
homepage: ${origin}
---

# DELTA Witness

Use DELTA when an action depends on what a public source says now.

- Capture: \`POST ${origin}/v1/capture\` with \`{"url":"https://example.com"}\`.
- Guard: \`POST ${origin}/v1/preflight\` with a URL plus a prior proof, expected hash, or textual expectations.
- Watch: available only through authenticated prepaid partner gateways; quota is finite and every scheduled check must remain margin-positive.
- Payment: x402 v2 on Base mainnet USDC, settled before capture work.
- Semantics: \`safe\` means supplied deterministic expectations matched. DELTA proves observation/change, not source truth.

Read \`${origin}/openapi.json\` for exact schemas and \`${origin}/docs\` for client flow.
`;
}

export function landingHtml(origin: string, version: string): string {
  return `<!doctype html><html lang="en" itemscope itemtype="https://schema.org/SoftwareApplication"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DELTA Witness — Trust Layer for Autonomous Actions</title><meta name="description" content="Paid, machine-verifiable capture and preflight checks for public web sources."><meta itemprop="applicationCategory" content="DeveloperApplication"><meta itemprop="operatingSystem" content="Web API"><link rel="canonical" href="${origin}/"><link rel="icon" href="/favicon.ico"><style>body{max-width:760px;margin:4rem auto;padding:0 1.25rem;font:17px/1.55 system-ui;color:#132238}code,pre{background:#eef2f6;border-radius:6px}code{padding:.12rem .3rem}pre{padding:1rem;overflow:auto}a{color:#0759c7}.tag{color:#53657a}</style></head><body><p class="tag">DELTA Witness v${version}</p><h1 itemprop="name">Trust Layer for Autonomous Actions</h1><p itemprop="description">Observe a public source immediately before software takes a consequential action. DELTA returns timestamped content hashes and a public verifier while keeping raw capture artifacts private.</p><h2>Capture</h2><p>Preserve what a public page says now through <code>POST /v1/capture</code>.</p><h2>Guard / Preflight</h2><p>Compare a fresh observation with a prior DELTA proof, expected hashes, or explicit text rules through <code>POST /v1/preflight</code>. “Safe” means the supplied deterministic checks matched; it is not a truth claim.</p><pre>curl -i ${origin}/v1/preflight \\
  -H "content-type: application/json" \\
  -d '{"url":"https://example.com","expected":{"contains":["Example Domain"]}}'</pre><p>The HTTP 402 response contains x402 v2 payment requirements for Base mainnet USDC.</p><p><a href="/docs">API guide</a> · <a href="/openapi.json">OpenAPI</a> · <a href="/.well-known/x402">Machine discovery</a> · <a href="/v1/demo">Example proof</a></p></body></html>`;
}

export function docsHtml(origin: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DELTA Witness API</title><meta name="robots" content="index,follow"><style>body{max-width:820px;margin:3rem auto;padding:0 1.25rem;font:16px/1.55 system-ui;color:#14243a}code,pre{background:#eef2f6;border-radius:6px}code{padding:.12rem .3rem}pre{padding:1rem;overflow:auto}a{color:#0759c7}</style></head><body><h1>DELTA Witness API</h1><p>One core service exposes Capture and Guard. Both accept JSON, issue an x402 v2 challenge, settle USDC on Base mainnet before Browser Run, and return proof metadata.</p><h2>Guard request</h2><pre>{
  "url": "https://example.com/terms",
  "prior_proof_id": "optional UUID",
  "expected": {
    "contains": ["Refund window: 30 days"],
    "excludes": ["Final sale"]
  }
}</pre><p>Use the returned <code>safe</code>, <code>changed</code>, <code>reason</code>, and <code>diff</code> fields as a deterministic gate. A proof reference is always returned for a completed paid observation.</p><h2>Safety and privacy</h2><p>Only public HTTP(S) targets on ports 80/443 are accepted. Local, private, link-local, metadata, credential-bearing, unsafe redirect, and private-DNS targets are rejected. Raw HTML, Markdown, and screenshots remain private; verifier routes publish metadata and hashes.</p><h2>Recurring Watch</h2><p>Watch is available through authenticated marketplace/reseller gateways as prepaid finite quota. Checks run no more often than every 15 minutes, pause when the prepaid unit price falls below DELTA's live cost floor, and can deliver HMAC-signed webhooks.</p><p><a href="${origin}/openapi.json">OpenAPI 3.1</a> · <a href="${origin}/SKILL.md">Agent skill</a> · <a href="${origin}/postman.json">Postman collection</a> · <a href="${origin}/distribution.json">Distribution manifest</a></p></body></html>`;
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
    ],
  };
}
