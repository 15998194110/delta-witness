import { Hono, type Context, type Next } from "hono";

const MAX_BODY_BYTES = 12_288;
const CORE_TIMEOUT_MS = 120_000;
const MAX_CORE_RESPONSE_BYTES = 1_048_576;

// Explicit service contract: importing this thin adapter in Core integration
// tests must not inherit whichever Worker owns the ambient generated Env.
export type GatewayEnv = {
  CORE: Fetcher;
  PARTNER_RATE_LIMITER: RateLimit;
  APP_VERSION: string;
  PARTNER_ID: string;
  PARTNER_NET_CAPTURE_USD: string;
  PARTNER_NET_PREFLIGHT_USD: string;
  PARTNER_NET_WATCH_CHECK_USD: string;
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
    "402": { description: "Partner net price or prepaid amount is below the authorized product price" },
    "503": { description: "Economics or original evidence unavailable; do not authorize a replacement charge" },
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
      "/business/capabilities": { get: { operationId: "partnerBusinessCapabilities", responses: { "200": { description: "Explicit coordinator availability; no capture or charge" }, "401": authenticatedResponses["401"] } } },
      "/business/{business_order_id}/{product}": { post: { operationId: "partnerBusinessObservation", description: "Stable business order scoped by the authenticated proxy's trusted user identity. Core reuses the original fulfillment.",
        parameters: [
          { name: "business_order_id", in: "path", required: true, schema: { type: "string", minLength: 8, maxLength: 128 } },
          { name: "product", in: "path", required: true, schema: { type: "string", enum: ["capture", "preflight"] } },
          { name: "x-delta-partner-user", in: "header", required: true, schema: { type: "string" } },
        ], responses: { "200": { description: "Original completed delivery" }, ...authenticatedResponses } } },
      "/business/{business_order_id}/{product}/billing": { post: { operationId: "partnerBusinessBilling", description: "Read, reserve one charge attempt, or record an adapter-reported charge against the original fulfillment. Unknown reservations never expire into a new charge. This does not verify platform settlement or revenue.",
        parameters: [
          { name: "business_order_id", in: "path", required: true, schema: { type: "string", minLength: 8, maxLength: 128 } },
          { name: "product", in: "path", required: true, schema: { type: "string", enum: ["capture", "preflight"] } },
          { name: "x-delta-partner-user", in: "header", required: true, schema: { type: "string" } },
        ], requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["request", "operation"], properties: {
          request: { type: "object" }, operation: { enum: ["status", "reserve_charge", "confirm_charge"] }, attempt_id: { type: "string", format: "uuid", description: "Required for reserve and confirm; retain the original attempt" },
        } } } } }, responses: { "200": { description: "Original order and asserted billing state" }, "202": { description: "Original delivery pending" }, "409": { description: "Identity or conditional-write conflict; no fresh charge permission" }, ...authenticatedResponses } } },
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

// A timeout may occur after Core accepted the operation. Never resubmit here;
// the caller must keep the original idempotency key for any later recovery.
async function fetchCore(env: GatewayEnv, request: Request): Promise<Response> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error("core_response_timeout"));
        controller.abort();
        void reader?.cancel().catch(() => {});
      }, CORE_TIMEOUT_MS);
    });
    return await Promise.race([
      (async () => {
        const response = await env.CORE.fetch(new Request(request, { signal: controller.signal }));
        if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error("core_response_timeout"); }
        // Keep the deadline active through the body; receiving headers alone
        // does not establish delivery. Core returns metadata, not raw artifacts.
        reader = response.body?.getReader();
        if (!reader) return response;
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (controller.signal.aborted) throw new Error("core_response_timeout");
            if (done) break;
            size += value.byteLength;
            if (size > MAX_CORE_RESPONSE_BYTES) { void reader.cancel().catch(() => {}); throw new Error("core_response_too_large"); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        return new Response(body, { status: response.status, headers: response.headers });
      })(), timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function coreFailure(c: GatewayContext, error: unknown): Response {
  const timeout = error instanceof Error && error.message === "core_response_timeout";
  return c.json({
    error: timeout ? "core_response_timeout" : "core_response_unavailable",
    state: "uncertain",
    recovery: "reuse_original_idempotency_key",
  }, timeout ? 504 : 502);
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
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (expired) throw new Error("request_timeout");
          if (done) break;
          total += value.byteLength;
          if (total > MAX_BODY_BYTES) throw new Error("request_too_large");
          chunks.push(value);
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error("request_timeout"));
          void reader.cancel("request_timeout").catch(() => {});
        }, 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
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
app.use("/business/*", authorized);

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
    let response: Response;
    try {
      response = await fetchCore(c.env, new Request(`https://delta.internal/internal/partner/${product}`, {
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
    } catch (error) {
      return coreFailure(c, error);
    }
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
    if (reason === "request_too_large") return c.json({ error: reason }, 413);
    if (reason === "request_timeout") return c.json({ error: reason }, 408);
    if (reason === "content_type_must_be_application_json") return c.json({ error: reason }, 400);
    return c.json({ error: "internal_error" }, 500);
  }
}

app.post("/capture", (c) => forward("capture", c));
app.post("/preflight", (c) => forward("preflight", c));
app.post("/watch", (c) => forward("watch", c));

// Thin transport for Core's original-order billing coordinator. Only Core
// derives business identities and coordinates charge permission.
async function forwardBusiness(c: GatewayContext, billing: boolean): Promise<Response> {
  const product = c.req.param("product"), businessId = c.req.param("businessOrderId") ?? "";
  if (product !== "capture" && product !== "preflight") return c.json({ error: "unknown_product" }, 404);
  const user = c.req.header("x-delta-partner-user");
  if (!user || user.length > 128 || !/^[A-Za-z0-9._:-]{8,128}$/.test(businessId)) return c.json({ error: "valid_business_identity_required" }, 400);
  try {
    const bytes = await boundedBody(c.req.raw);
    const netPrice = Number(product === "capture" ? c.env.PARTNER_NET_CAPTURE_USD : c.env.PARTNER_NET_PREFLIGHT_USD);
    if (!Number.isFinite(netPrice) || netPrice <= 0) return c.json({ error: "invalid_partner_net_price" }, 503);
    const response = await fetchCore(c.env, new Request(`https://delta.internal/internal/partner/business/${encodeURIComponent(businessId)}/${product}${billing ? "/billing" : ""}`, {
      method: "POST", headers: { "content-type": "application/json", "x-delta-core-secret": c.env.CORE_SERVICE_SECRET!,
        "x-delta-partner": c.env.PARTNER_ID, "x-delta-channel": c.env.PARTNER_ID,
        "x-delta-partner-user": user, "x-delta-gross-usd": netPrice.toFixed(6) }, body: exactBuffer(bytes),
    }));
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "request_too_large") return c.json({ error: code }, 413);
    if (code === "request_timeout") return c.json({ error: code }, 408);
    if (code === "content_type_must_be_application_json") return c.json({ error: code }, 400);
    return coreFailure(c, error);
  }
}
app.get("/business/capabilities", async (c) => {
  try {
    const response = await fetchCore(c.env, new Request("https://delta.internal/internal/partner/business/capabilities", { headers: {
      "x-delta-core-secret": c.env.CORE_SERVICE_SECRET!, "x-delta-partner": c.env.PARTNER_ID,
    } }));
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" } });
  } catch (error) { return coreFailure(c, error); }
});
app.post("/business/:businessOrderId/:product", (c) => forwardBusiness(c, false));
app.post("/business/:businessOrderId/:product/billing", (c) => forwardBusiness(c, true));
app.get("/watch/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) return c.json({ error: "invalid_watch_id" }, 400);
  let response: Response;
  try {
    response = await fetchCore(c.env, new Request(`https://delta.internal/internal/partner/watch/${id}`, {
    headers: {
      "x-delta-core-secret": c.env.CORE_SERVICE_SECRET!,
      "x-delta-partner": c.env.PARTNER_ID,
    },
    }));
  } catch (error) {
    return coreFailure(c, error);
  }
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8", "cache-control": "private, no-store" },
  });
});

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((_error, c) => {
  console.error(JSON.stringify({ event: "partner_gateway_error", code: "internal_error" }));
  return c.json({ error: "internal_error" }, 500);
});

export { app };
export default { fetch: app.fetch } satisfies ExportedHandler<GatewayEnv>;
