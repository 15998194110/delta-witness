import { afterEach, describe, expect, it, vi } from "vitest";
import { app, type GatewayEnv } from "../src/index";

function runtime(fetchImpl: (request: Request) => Promise<Response>): GatewayEnv {
  return {
    CORE: { fetch: fetchImpl },
    PARTNER_RATE_LIMITER: { limit: async () => ({ success: true }) },
    APP_VERSION: "0.7.1", PARTNER_ID: "test-partner",
    PARTNER_NET_CAPTURE_USD: "1", PARTNER_NET_PREFLIGHT_USD: "1", PARTNER_NET_WATCH_CHECK_USD: "1",
    PARTNER_SECRET: "fixture-partner-secret", CORE_SERVICE_SECRET: "fixture-core-secret",
  } as unknown as GatewayEnv;
}

const init = {
  method: "POST", headers: { "content-type": "application/json", "x-delta-partner-secret": "fixture-partner-secret", "idempotency-key": "stable-request-001" },
  body: JSON.stringify({ url: "https://example.com" }),
};

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("gateway uncertain outcomes and redacted failures", () => {
  it('accepts a legitimate 35-second Core response without retrying', async () => {
    vi.useFakeTimers();
    const core = vi.fn(() => new Promise<Response>(resolve => setTimeout(() => resolve(Response.json({ok: true, proof_id: 'fixture'})), 35000)));
    const pending = app.request('https://gateway.test/capture', init, runtime(core));
    await vi.waitFor(() => expect(core).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(35000);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ok: true});
    expect(core).toHaveBeenCalledTimes(1);
  });
  it("bounds the response body as well as headers without resubmitting", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const core = vi.fn(async () => new Response(new ReadableStream({ start() {}, cancel: cancelled }), { headers: { 'content-type': 'application/json' } }));
    const pending = app.request("https://gateway.test/capture", init, runtime(core));
    await vi.waitFor(() => expect(core).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(120_001);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ state: 'uncertain', recovery: 'reuse_original_idempotency_key' });
    expect(core).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it('cancels an oversized Core body and keeps the operation uncertain', async () => {
    const cancelled = vi.fn();
    const core = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1_048_577)); }, cancel: cancelled,
    })));
    const response = await app.request('https://gateway.test/capture', init, runtime(core));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({state: 'uncertain', recovery: 'reuse_original_idempotency_key'});
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(core).toHaveBeenCalledTimes(1);
  });
  it('cancels a Core response arriving after the timeout', async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const core = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    const pending = app.request('https://gateway.test/capture', init, runtime(core));
    await vi.waitFor(() => expect(core).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(120_001);
    expect((await pending).status).toBe(504);
    const cancelled = vi.fn();
    resolve(new Response(new ReadableStream({ start() {}, cancel: cancelled })));
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
    expect(core).toHaveBeenCalledTimes(1);
  });
  it("does not return an upstream exception or retry an ambiguous write", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("Bearer fixture-core-secret https://private.test/?token=fixture-token"); });
    const response = await app.request("https://gateway.test/capture", init, runtime(fetchImpl));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "core_response_unavailable", state: "uncertain", recovery: "reuse_original_idempotency_key" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled core write, retains uncertainty, and never resubmits", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Promise<Response>(() => {}));
    const pending = app.request("https://gateway.test/capture", init, runtime(fetchImpl));
    // Crypto-backed authentication resolves outside fake timers.
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(120_001);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "core_response_timeout", state: "uncertain", recovery: "reuse_original_idempotency_key" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }, 1000);

  it("logs only a fixed diagnostic code when auth infrastructure throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = runtime(vi.fn());
    env.PARTNER_RATE_LIMITER = { limit: async () => { throw new Error("Bearer fixture-core-secret user=private@example.test"); } } as unknown as RateLimit;
    const response = await app.request("https://gateway.test/capture", init, env);
    expect(response.status).toBe(500);
    expect(JSON.stringify(log.mock.calls)).not.toContain("fixture-core-secret");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private@example.test");
    expect(await response.json()).toEqual({ error: "internal_error" });
  });

  it("maps unsupported content type to a client error without forwarding", async () => {
    const core = vi.fn();
    const response = await app.request("https://gateway.test/capture", { ...init, headers: { ...init.headers, "content-type": "text/plain" } }, runtime(core));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "content_type_must_be_application_json" });
    expect(core).not.toHaveBeenCalled();
  });
});
