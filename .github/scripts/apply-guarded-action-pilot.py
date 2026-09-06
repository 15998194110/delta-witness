from pathlib import Path
import json

VERSION = "0.7.0"


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, got {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# Discovery schemas and machine-readable pilot path.
replace_once(
    "src/discovery.ts",
    "export const DELIVERY_SCHEMA = {",
    '''export const GUARDED_ACTION_PILOT_INPUT_SCHEMA = {
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

export const DELIVERY_SCHEMA = {'''
)
replace_once(
    "src/discovery.ts",
    '      "x-guidance": "Call GET /v1/quote before budgeting. Capture preserves a public observation; Guard compares one with deterministic expectations. Runtime HTTP 402 payment requirements are authoritative.",',
    '      "x-guidance": "Call GET /v1/quote before budgeting. Capture preserves a public observation; Guard compares one with deterministic expectations; Guarded-Action Pilot bundles 1-3 public URL proofs for exactly $10. Runtime HTTP 402 payment requirements are authoritative.",'
)
replace_once(
    "src/discovery.ts",
    '      "/v1/quote": { get: { operationId: "quote", security: [], parameters: [{ name: "product", in: "query", schema: { enum: ["capture", "preflight"] } }], responses: { "200": { description: "Current floor-aware quote" } } } },',
    '      "/v1/quote": { get: { operationId: "quote", security: [], parameters: [{ name: "product", in: "query", schema: { enum: ["capture", "preflight", "guarded-action-pilot"] } }], responses: { "200": { description: "Current floor-aware quote or exact pilot package quote" } } } },'
)
replace_once(
    "src/discovery.ts",
    '      "/v1/proofs/{proof_id}": {',
    '''      "/v1/guarded-action-pilot": {
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
      "/v1/proofs/{proof_id}": {'''
)
replace_once(
    "src/discovery.ts",
    '- Guard: `POST ${origin}/v1/preflight` with a URL plus a prior proof, expected hash, or textual expectations.\n',
    '- Guard: `POST ${origin}/v1/preflight` with a URL plus a prior proof, expected hash, or textual expectations.\n- $10 Guarded-Action Pilot: `POST ${origin}/v1/guarded-action-pilot` with 1-3 public HTTPS URLs and an optional deterministic preflight on one URL. No subscription.\n'
)
replace_once(
    "src/discovery.ts",
    '<p>One core service exposes Capture and Guard. Both accept JSON, issue an x402 v2 challenge, settle USDC on Base mainnet before Browser Run, and return proof metadata.</p>',
    '<p>One core service exposes Capture, Guard, and a $10 Guarded-Action Pilot. All accept JSON, issue an x402 v2 challenge, settle USDC on Base mainnet before Browser Run, and return proof metadata.</p><h2>$10 Guarded-Action Pilot</h2><p>Submit 1-3 public HTTPS URLs and optionally one deterministic preflight rule. A single exact $10 USDC payment returns a bounded evidence bundle with independent proof references for every URL. No subscription.</p>'
)
replace_once(
    "src/discovery.ts",
    '''      {
        name: "Guard / Preflight",
        request: { method: "POST", header: [{ key: "Content-Type", value: "application/json" }], body: { mode: "raw", raw: "{\\"url\\":\\"https://example.com\\",\\"expected\\":{\\"contains\\":[\\"Example Domain\\"]}}" }, url: "{{baseUrl}}/v1/preflight" },
      },''',
    '''      {
        name: "Guard / Preflight",
        request: { method: "POST", header: [{ key: "Content-Type", value: "application/json" }], body: { mode: "raw", raw: "{\\"url\\":\\"https://example.com\\",\\"expected\\":{\\"contains\\":[\\"Example Domain\\"]}}" }, url: "{{baseUrl}}/v1/preflight" },
      },
      {
        name: "$10 Guarded-Action Pilot",
        request: { method: "POST", header: [{ key: "Content-Type", value: "application/json" }], body: { mode: "raw", raw: "{\\"urls\\":[\\"https://example.com\\"],\\"preflight\\":{\\"url_index\\":0,\\"expected\\":{\\"contains\\":[\\"Example Domain\\"]}}}" }, url: "{{baseUrl}}/v1/guarded-action-pilot" },
      },'''
)

# Core route wiring, quote, and discovery surfaces.
replace_once(
    "src/index.ts",
    '  PREFLIGHT_INPUT_SCHEMA,\n',
    '  PREFLIGHT_INPUT_SCHEMA,\n  GUARDED_ACTION_PILOT_INPUT_SCHEMA,\n'
)
replace_once(
    "src/index.ts",
    'import { getWatch, parseWatchRegistration, registerWatch, runDueWatches } from "./watch";',
    'import { getWatch, parseWatchRegistration, registerWatch, runDueWatches } from "./watch";\nimport { guardedPilotEconomics, guardedPilotHandler, guardedPilotPrevalidate, guardedPilotProtect } from "./guarded-pilot";'
)
replace_once(
    "src/index.ts",
    '''app.get("/v1/quote", async (c) => {
  const product = c.req.query("product") === "preflight" ? "preflight" : "capture";''',
    '''app.get("/v1/quote", async (c) => {
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
  const product = requestedProduct === "preflight" ? "preflight" : "capture";'''
)
replace_once(
    "src/index.ts",
    '''app.post("/v1/preflight", (c) => paidHandler("preflight", c));

async function partnerAuthorized''',
    '''app.post("/v1/preflight", (c) => paidHandler("preflight", c));

app.use("/v1/guarded-action-pilot", (c, next) => guardedPilotPrevalidate(c, next));
app.use("/v1/guarded-action-pilot", (c, next) => guardedPilotProtect(c, next));
app.post("/v1/guarded-action-pilot", (c) => guardedPilotHandler(c));

async function partnerAuthorized'''
)
replace_once(
    "src/index.ts",
    '    { method: "POST", path: "/v1/preflight", product: "guard", inputSchema: PREFLIGHT_INPUT_SCHEMA },\n',
    '    { method: "POST", path: "/v1/preflight", product: "guard", inputSchema: PREFLIGHT_INPUT_SCHEMA },\n    { method: "POST", path: "/v1/guarded-action-pilot", product: "guarded_action_pilot", price_usd: 10, inputSchema: GUARDED_ACTION_PILOT_INPUT_SCHEMA },\n'
)
replace_once(
    "src/index.ts",
    '- [Agent preflight](${origin(c.env)}/use-cases/agent-preflight)\\n',
    '- [Agent preflight](${origin(c.env)}/use-cases/agent-preflight)\\n- [$10 Guarded-Action Pilot](${origin(c.env)}/v1/quote?product=guarded-action-pilot)\\n'
)
replace_once(
    "src/index.ts",
    '    guard: { endpoint: `${origin(c.env)}/v1/preflight`, billing: "x402-v2-upfront" },\n',
    '    guard: { endpoint: `${origin(c.env)}/v1/preflight`, billing: "x402-v2-upfront" },\n    guarded_action_pilot: { endpoint: `${origin(c.env)}/v1/guarded-action-pilot`, price_usd: 10, max_urls: 3, billing: "x402-v2-upfront" },\n'
)

# Production release acceptance: exact pilot 402 and unchanged micro-SKUs.
replace_once(
    ".github/workflows/release-train.yml",
    '          curl --fail https://delta-witness-api.ruphussten.workers.dev/v1/proofs/56347db8-1aa5-447f-a0e4-3bb052d7aa89\n',
    '''          curl --fail https://delta-witness-api.ruphussten.workers.dev/v1/proofs/56347db8-1aa5-447f-a0e4-3bb052d7aa89
          for route in capture preflight; do
            status="$(curl --silent --show-error --output "/tmp/delta-${route}-quote.json" --dump-header "/tmp/delta-${route}-quote.headers" --write-out '%{http_code}' --request POST "https://delta-witness-api.ruphussten.workers.dev/v1/${route}" --header 'content-type: application/json' --data '{"url":"https://example.com"}')"
            test "$status" = "402"
            grep --quiet -i '^payment-required:' "/tmp/delta-${route}-quote.headers"
            node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1])); if(x.price_usd!==0.03) throw new Error(JSON.stringify(x))' "/tmp/delta-${route}-quote.json"
          done
          pilot_status="$(curl --silent --show-error --output /tmp/delta-pilot-quote.json --dump-header /tmp/delta-pilot-quote.headers --write-out '%{http_code}' --request POST https://delta-witness-api.ruphussten.workers.dev/v1/guarded-action-pilot --header 'content-type: application/json' --data '{"urls":["https://example.com"],"preflight":{"url_index":0,"expected":{"contains":["Example Domain"]}}}')"
          test "$pilot_status" = "402"
          grep --quiet -i '^payment-required:' /tmp/delta-pilot-quote.headers
          node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1])); if(x.price_usd!==10 || x.product!=="guarded_action_pilot") throw new Error(JSON.stringify(x))' /tmp/delta-pilot-quote.json
'''
)
replace_once(
    ".github/workflows/release-train.yml",
    "          for (const path of ['/v1/capture', '/v1/preflight']) {",
    "          for (const path of ['/v1/capture', '/v1/preflight', '/v1/guarded-action-pilot']) {"
)

# Version all release surfaces together for the new revenue SKU.
for file in [
    "package.json",
    "channels/partner-gateway/package.json",
    "channels/apify/package.json",
    "channels/base-app/package.json",
    "packages/js-client/package.json",
    "packages/mcp-server/package.json",
]:
    p = Path(file)
    data = json.loads(p.read_text())
    data["version"] = VERSION
    p.write_text(json.dumps(data, indent=2) + "\n")
replace_once("wrangler.jsonc", '"APP_VERSION": "0.6.1"', '"APP_VERSION": "0.7.0"')
replace_once("packages/python-client/pyproject.toml", 'version = "0.6.1"', 'version = "0.7.0"')
replace_once("distribution/mcp/server.template.json", '"version": "0.6.1"', '"version": "0.7.0"')
