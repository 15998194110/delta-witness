import { Hono, type Context, type Next } from "hono";

const MAX_BODY_BYTES = 12_288;

export type GatewayEnv = Env & {
  PARTNER_SECRET?: string;
  CORE_SERVICE_SECRET?: string;
};

type Gateway = { Bindings: GatewayEnv };
type GatewayContext = Context<Gateway>;
const app = new Hono<Gateway>();

function gatewayOpenApi(origin: string, version: string): Record<string, unknown> {
  const authenticatedResponses = {
    "400": { description: "Invalid request or idempotency identity" },
    "401": { description: "Marketplace proxy was not authenticated" },
    "402": { description: "Partner net price or prepaid amount is below DELTA's live margin floor" },
    "429": { description: "Partner or end-user rate limit exceeded" },
    "502": { description: "Observation failed; retry with the same idempotency identity" },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "DELTA Witness Partner Gateway",
      version,
      description: "Authenticated reseller rail for DELTA Capture, Guard, and finite prepaid Watch. Marketplace billing must complete before calling this gateway.",
    },
    servers: [{ url: origin }],
    security: [{ PartnerProxySecret: [] }],
    components: {
      securitySchemes: {
        PartnerProxySecret: {
          type: "apiKey",
          in: "header",
          name: "x-delta-partner-secret",
          description: "Provider-managed secret. Never expose it to marketplace end users.",
        },
      },
    },
    paths: {
      "/health": { get: { security: [], responses: { "200": { description: "Healthy" } } } },
      "/capture": { post: { operationId: "partnerCapture", responses: { "200": { description: "Proof delivered" }, ...authenticatedResponses } } },
      "/preflight": { post: { operationId: "partnerGuard", responses: { "200": { description: "Guard decision and proof delivered" }, ...authenticatedResponses } } },
      "/watch": { post: { operationId: "partnerRegisterWatch", responses: { "201": { description: "Finite prepaid watch registered" }, ...authenticatedResponses } } },
      "/watch/{watch_id}": {
        get: {
          operationId: "partnerGetWatch",
          parameters: [{ name: "watch_id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Watch quota and latest state" }, "401": authenticatedResponses["401"], "404": { description: "Watch not found" } },
        },
      },
    },
  };
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", exactBuffer(new TextEncoder().encode(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function equalSecret(presented: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(presented), sha256(expected)]);
  return left === right;
}

async function boundedBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("request_too_large");
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new Error("content_type_must_be_application_json");
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        void reader.cancel("body_too_large");
        throw new Error("request_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function requestId(request: Request, body: Record<string, unknown>): string | null {
  const value = request.headers.get("idempotency-key")
    ?? request.headers.get("x-rapidapi-request-id")
    ?? (typeof body.external_request_id === "string" ? body.external_request_id : null);
  return value && /^[A-Za-z0-9._:-]{8,128}$/.test(value) ? value : null;
}

async function authorized(c: GatewayContext, next: Next): Promise<Response | void> {
  if (!c.env.PARTNER_SECRET || !c.env.CORE_SERVICE_SECRET) return c.json({ error: "gateway_not_configured" }, 503);
  const presented = c.req.header("x-delta-partner-secret") ?? c.req.header("x-rapidapi-proxy-secret") ?? "";
  if (!(await equalSecret(presented, c.env.PARTNER_SECRET))) return c.json({ error: "unauthorized_partner" }, 401);
  const rateIdentity = c.req.header("x-rapidapi-user")
    ?? c.req.header("x-delta-partner-user")
    ?? c.req.header("cf-connecting-ip")
    ?? "anonymous";
  const outcome = await c.env.PARTNER_RATE_LIMITER.limit({ key: await sha256(`${c.env.PARTNER_ID}\n${rateIdentity}`) });
  if (!outcome.success) {
    c.header("retry-after", "60");
    return c.json({ error: "rate_limit_exceeded" }, 429);
  }
  return next();
}

app.use("/capture", authorized);
app.use("/preflight", authorized);
app.use("/watch", authorized);
app.use("/watch/*", authorized);

app.get("/health", (c) => c.json({ ok: true, version: c.env.APP_VERSION, channel: "partner-gateway", core: "service-binding" }));
app.get("/openapi.json", (c) => c.json(gatewayOpenApi(new URL(c.req.url).origin, c.env.APP_VERSION)));
app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));

async function forward(product: "capture" | "preflight" | "watch", c: GatewayContext): Promise<Response> {
  try {
    const bytes = await boundedBody(c.req.raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return c.json({ error: "invalid_request_body" }, 400);
    const body = parsed as Record<string, unknown>;
    const idempotencyKey = requestId(c.req.raw, body);
    if (!idempotencyKey) return c.json({ error: "valid_idempotency_key_required" }, 400);
    const { external_request_id: _externalRequestId, ...coreBody } = body;
    let netPrice = product === "capture" ? Number(c.env.PARTNER_NET_CAPTURE_USD) : Number(c.env.PARTNER_NET_PREFLIGHT_USD);
    if (product === "watch") {
      const checks = Number(coreBody.checks);
      if (!Number.isInteger(checks) || checks < 1 || checks > 1_000) return c.json({ error: "invalid_checks" }, 400);
      netPrice = Number(c.env.PARTNER_NET_WATCH_CHECK_USD) * checks;
    }
    if (!Number.isFinite(netPrice) || netPrice <= 0) return c.json({ error: "invalid_partner_net_price" }, 503);
    const response = await c.env.CORE.fetch(new Request(`https://delta.internal/internal/partner/${product}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-delta-core-secret": c.env.CORE_SERVICE_SECRET!,
        "x-delta-partner": c.env.PARTNER_ID,
        "x-delta-channel": c.env.PARTNER_ID,
        "x-delta-gross-usd": netPrice.toFixed(6),
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(coreBody),
    }));
    const headers = new Headers({
      "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) headers.set("retry-after", retryAfter);
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "internal_error";
    return c.json({ error: reason }, reason === "request_too_large" ? 413 : 500);
  }
}

app.post("/capture", (c) => forward("capture", c));
app.post("/preflight", (c) => forward("preflight", c));
app.post("/watch", (c) => forward("watch", c));
app.get("/watch/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) return c.json({ error: "invalid_watch_id" }, 400);
  const response = await c.env.CORE.fetch(new Request(`https://delta.internal/internal/partner/watch/${id}`, {
    headers: {
      "x-delta-core-secret": c.env.CORE_SERVICE_SECRET!,
      "x-delta-partner": c.env.PARTNER_ID,
    },
  }));
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8", "cache-control": "private, no-store" },
  });
});

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((error, c) => {
  console.error(JSON.stringify({ event: "partner_gateway_error", path: c.req.path, message: error.message }));
  return c.json({ error: "internal_error" }, 500);
});

export { app };
export default { fetch: app.fetch } satisfies ExportedHandler<GatewayEnv>;
