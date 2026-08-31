import { describe, expect, it, vi } from "vitest";
import { app, type GatewayEnv } from "../src/index";

function env(coreFetch: (request: Request) => Promise<Response> = vi.fn(async () => Response.json({ ok: true }))): GatewayEnv {
  return {
    CORE: { fetch: coreFetch, connect: vi.fn() } as unknown as Fetcher,
    PARTNER_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit,
    APP_VERSION: "0.6.0",
    PARTNER_ID: "marketplace",
    PARTNER_NET_CAPTURE_USD: "0.03",
    PARTNER_NET_PREFLIGHT_USD: "0.04",
    PARTNER_NET_WATCH_CHECK_USD: "0.05",
    PARTNER_SECRET: "partner-secret",
    CORE_SERVICE_SECRET: "core-secret",
  } as unknown as GatewayEnv;
}

describe("thin partner gateway", () => {
  it("publishes a machine-readable contract without exposing a secret", async () => {
    const response = await app.request("https://gateway.test/openapi.json", {}, env());
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, any>>();
    expect(body.info.version).toBe("0.6.0");
    expect(body.paths["/watch"]).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('"partner-secret"');
  });

  it("rejects unauthenticated requests without calling core", async () => {
    const core = vi.fn();
    const response = await app.request("https://gateway.test/capture", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "request-123" },
      body: JSON.stringify({ url: "https://example.com" }),
    }, env(core));
    expect(response.status).toBe(401);
    expect(core).not.toHaveBeenCalled();
  });

  it("forwards an authenticated request through the core service binding", async () => {
    const core = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://delta.internal/internal/partner/preflight");
      expect(request.headers.get("x-delta-core-secret")).toBe("core-secret");
      expect(request.headers.get("x-delta-gross-usd")).toBe("0.040000");
      expect(request.headers.get("idempotency-key")).toBe("request-123");
      expect(await request.json()).toEqual({ url: "https://example.com", expected: { contains: ["Example"] } });
      return Response.json({ ok: true, proof_id: "proof" });
    });
    const response = await app.request("https://gateway.test/preflight", {
      method: "POST",
      headers: { "content-type": "application/json", "x-delta-partner-secret": "partner-secret", "idempotency-key": "request-123" },
      body: JSON.stringify({ url: "https://example.com", expected: { contains: ["Example"] }, external_request_id: "ignored-because-header-wins" }),
    }, env(core));
    expect(response.status).toBe(200);
    expect(core).toHaveBeenCalledOnce();
  });

  it("requires a stable idempotency identity", async () => {
    const core = vi.fn();
    const response = await app.request("https://gateway.test/capture", {
      method: "POST",
      headers: { "content-type": "application/json", "x-rapidapi-proxy-secret": "partner-secret" },
      body: JSON.stringify({ url: "https://example.com" }),
    }, env(core));
    expect(response.status).toBe(400);
    expect(core).not.toHaveBeenCalled();
  });

  it("enforces the platform-facing rate limit", async () => {
    const runtime = env();
    runtime.PARTNER_RATE_LIMITER = { limit: vi.fn(async () => ({ success: false })) } as unknown as RateLimit;
    const response = await app.request("https://gateway.test/capture", {
      method: "POST",
      headers: { "content-type": "application/json", "x-delta-partner-secret": "partner-secret", "idempotency-key": "request-123" },
      body: JSON.stringify({ url: "https://example.com" }),
    }, runtime);
    expect(response.status).toBe(429);
  });

  it("uses the downstream partner user for the rate-limit identity", async () => {
    const runtime = env();
    const limiter = vi.fn(async (_input: { key: string }) => ({ success: true }));
    runtime.PARTNER_RATE_LIMITER = { limit: limiter } as unknown as RateLimit;
    await app.request("https://gateway.test/capture", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-delta-partner-secret": "partner-secret",
        "x-delta-partner-user": "buyer-42",
        "idempotency-key": "request-123",
      },
      body: JSON.stringify({ url: "https://example.com" }),
    }, runtime);
    expect(limiter).toHaveBeenCalledOnce();
    expect(limiter.mock.calls[0]?.[0].key).toMatch(/^[0-9a-f]{64}$/);
  });
});
