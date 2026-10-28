import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import type { RuntimeEnv } from "../src/env";
import { sha256 } from "../src/crypto";
import { fulfillmentRecordKey, initialFulfillment, paidRequestHash } from "../src/fulfillment";
import { storeCapture, type CaptureArtifacts } from "../src/capture";
import { registerWatch, runDueWatches } from "../src/watch";
import { recordEvent } from "../src/telemetry";
import { commitClaim } from "../src/claims";

class MemoryBucket {
  values = new Map<string, { text: string; etag: string; bytes?: Uint8Array }>();
  sequence = 0;
  async get(key: string) {
    const value = this.values.get(key);
    return value ? { etag: value.etag, size: value.bytes?.byteLength ?? new TextEncoder().encode(value.text).byteLength, json: async () => JSON.parse(value.text), text: async () => value.text, arrayBuffer: async () => (value.bytes ?? new TextEncoder().encode(value.text)).slice().buffer } : null;
  }
  async put(key: string, value: unknown, options?: R2PutOptions) {
    const current = this.values.get(key);
    const condition = options?.onlyIf;
    if (condition && "etagDoesNotMatch" in condition && condition.etagDoesNotMatch === "*" && current) return null;
    if (condition && "etagMatches" in condition && condition.etagMatches !== current?.etag) return null;
    const etag = String(++this.sequence);
    this.values.set(key, { text: String(value), etag, bytes: value instanceof Uint8Array ? value.slice() : undefined });
    return { etag };
  }
  async list(options?: R2ListOptions) {
    return { objects: [...this.values.keys()].filter((key) => key.startsWith(options?.prefix ?? "")).map((key) => ({ key })), truncated: false };
  }
}

const payer = "0x1111111111111111111111111111111111111111";
const payTo = "0x1990e21bc219696ff7fbc26527dbaed335ac6367";
const asset = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
function runtime(bucket: MemoryBucket): RuntimeEnv {
  return {
    PROOFS: bucket, APP_VERSION: "0.7.1", NETWORK: "eip155:8453", PAY_TO: payTo,
    CAPTURE_BASE_PRICE_USD: "1", PREFLIGHT_BASE_PRICE_USD: "5", WATCH_BASE_PRICE_USD: "1",
    FACILITATOR_URL: "https://facilitator.test", PUBLIC_ORIGIN: "https://delta.test",
    ANALYTICS_DB: { prepare: () => ({ bind: () => ({ run: async () => undefined }) }) },
    BROWSER: { quickAction: vi.fn(async () => Response.json({
      success: true, result: { content: "<h1>Example</h1>", markdown: "Example", screenshot: png },
      meta: { status: 200, finalUrl: "https://example.com/" },
    }, { headers: { "x-browser-ms-used": "1" } })) },
  } as unknown as RuntimeEnv;
}
function payment(product: string) {
  const amount = product === "capture" ? "1000000" : product === "preflight" ? "5000000" : "10000000";
  return {
    x402Version: 2,
    resource: { url: `https://delta.test/v1/${product}` },
    accepted: { scheme: "exact", network: "eip155:8453", asset, amount, payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2", paymentFlow: "upfront" } },
    payload: { signature: "0x" + "ab".repeat(65), authorization: { from: payer, to: payTo, value: amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + "cd".repeat(32) } },
  };
}
function request(product: string, header = Buffer.from(JSON.stringify(payment(product))).toString("base64"), body?: Record<string, unknown>) {
  return new Request(`https://delta.test/v1/${product}`, {
    method: "POST", headers: { "content-type": "application/json", "payment-signature": header },
    body: JSON.stringify(body ?? (product === "guarded-action-pilot" ? { urls: ["https://example.com/"] } : { url: "https://example.com/" })),
  });
}
function mockNetwork(settle: () => Promise<Response>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://cloudflare-dns.com/")) return Response.json(new URL(url).searchParams.get("type") === "A" ? { Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] } : { Status: 0, Answer: [] });
    if (url === "https://example.com/") return new Response("", { status: 200 });
    if (url.endsWith("/supported")) return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (url.endsWith("/verify")) return Response.json({ isValid: true, payer });
    if (url.endsWith("/settle")) return settle();
    throw new Error("unexpected_mocked_request");
  });
}

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => undefined));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("payment reliability regressions (all external operations mocked)", () => {
  it.each(["capture", "preflight", "guarded-action-pilot"])("%s keeps an indeterminate settlement pending instead of submitting again", async (product) => {
    const bucket = new MemoryBucket();
    const env = runtime(bucket);
    const settle = vi.fn(async () => { throw new Error("connection reset after accepted write"); });
    vi.stubGlobal("fetch", mockNetwork(settle));
    const first = await app.fetch(request(product), env);
    if (settle.mock.calls.length === 0) throw new Error(`did_not_reach_settlement: ${first.status} ${await first.text()}`);
    const retry = await app.fetch(request(product), env);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(retry.status).toBe(503);
    expect(await retry.json()).toMatchObject({ state: "settlement_unknown", retryable: false });
    expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });

  it("serves a completed paid response while the original target is offline", async () => {
    const bucket = new MemoryBucket();
    const env = runtime(bucket);
    const req = request("capture");
    const fingerprint = await sha256(req.headers.get("payment-signature")!);
    const body = { url: "https://example.com/" };
    const record = initialFulfillment({ route: "/v1/capture", requestHash: await paidRequestHash("/v1/capture", body), requestedUrl: body.url, fulfillmentFingerprint: fingerprint, paymentFingerprint: fingerprint });
    const response = { ok: true, proof_id: "already-delivered-proof" };
    await bucket.put(fulfillmentRecordKey(fingerprint), JSON.stringify({ ...record, state: "complete", response }));
    const fetchMock = vi.fn(async () => { throw new Error("DNS unavailable"); });
    vi.stubGlobal("fetch", fetchMock);
    const replay = await app.fetch(req, env);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...response, idempotent_replay: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not publish a manifest when one required artifact failed to persist", async () => {
    const bucket = new MemoryBucket();
    const originalPut = bucket.put.bind(bucket);
    bucket.put = async (key, value, options) => {
      if (key.endsWith("page.html")) throw new Error("simulated R2 partial failure");
      return originalPut(key, value, options);
    };
    const artifacts = { manifest: { proof_id: "partial-proof" }, html: "html", markdown: "md", screenshot: new Uint8Array([0]) } as CaptureArtifacts;
    await expect(storeCapture(runtime(bucket), artifacts)).rejects.toThrow();
    expect(bucket.values.has("partial-proof/manifest.json")).toBe(false);
  });

  it("replays a historical Watch purchase without applying today's price floor", async () => {
    const bucket = new MemoryBucket();
    const env = runtime(bucket);
    Object.assign(env, { WATCH_BASE_PRICE_USD: "0.03" });
    const input = { env, request: { url: "https://example.com/", checks: 1, interval_seconds: 900 }, requestHash: "hash", fingerprint: "old-watch", partner: "partner", channel: "partner", grossPaidUsd: 0.03 };
    expect((await registerWatch(input)).status).toBe(201);
    env.WATCH_BASE_PRICE_USD = "1";
    const replay = await registerWatch(input);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ idempotent_replay: true, prepaid_check_price_usd: 0.03 });
  });

  it("redacts a Browser error and never retries an explicit permission refusal", async () => {
    const bucket = new MemoryBucket();
    const env = runtime(bucket);
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    vi.mocked(env.BROWSER.quickAction).mockResolvedValue(new Response("denied", { status: 403 }));
    const first = await app.fetch(request("capture"), env);
    expect(await first.json()).toMatchObject({ retryable: false });
    await app.fetch(request("capture"), env);
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("does not leak raw dependency error content in responses or fulfillment records", async () => {
    const bucket = new MemoryBucket();
    const env = runtime(bucket);
    vi.stubGlobal("fetch", mockNetwork(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer })));
    vi.mocked(env.BROWSER.quickAction).mockRejectedValue(new Error("provider failed Authorization: Bearer private-secret-123 https://example.com/?token=private-secret-123"));
    const response = await app.fetch(request("capture"), env);
    expect(await response.text()).not.toContain("private-secret-123");
    expect(JSON.stringify([...bucket.values.values()])).not.toContain("private-secret-123");
  });

  it.each([401, 403, 429, 500, 503])("keeps an HTTP %s settle outcome pending and does not repeat the POST", async (status) => {
    const env = runtime(new MemoryBucket());
    const settle = vi.fn(async () => new Response("upstream-private-response", { status }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    const first = await app.fetch(request("capture"), env);
    const retry = await app.fetch(request("capture"), env);
    expect(first.status).toBe(503);
    expect(await first.text()).not.toContain("upstream-private-response");
    expect(retry.status).toBe(503);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });

  it.each(["not-json", JSON.stringify({ success: true }), JSON.stringify({ success: "true", transaction: "0x" + "12".repeat(32), network: "eip155:8453" })])("does not treat malformed settlement evidence as paid (%s)", async (body) => {
    const env = runtime(new MemoryBucket());
    const settle = vi.fn(async () => new Response(body));
    vi.stubGlobal("fetch", mockNetwork(settle));
    await app.fetch(request("capture"), env);
    const retry = await app.fetch(request("capture"), env);
    expect(retry.status).toBe(503);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });

  it("allows only one concurrent settlement submission", async () => {
    const env = runtime(new MemoryBucket());
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let enteredAgain!: () => void;
    const secondEntered = new Promise<void>((resolve) => { enteredAgain = resolve; });
    const settle = vi.fn(async () => { if (settle.mock.calls.length > 1) enteredAgain(); entered(); await waiting; throw new Error("connection reset"); });
    vi.stubGlobal("fetch", mockNetwork(settle));
    const first = app.fetch(request("capture"), env);
    await started;
    const secondPromise = app.fetch(request("capture"), env);
    await Promise.race([secondPromise, secondEntered]);
    release();
    await first;
    const second = await secondPromise;
    expect(settle).toHaveBeenCalledTimes(1);
    expect(second.status).toBe(503);
  });

  it("does not let alternate JSON serialization evade the authorization lock", async () => {
    const env = runtime(new MemoryBucket());
    const settle = vi.fn(async () => { throw new Error("connection reset"); });
    vi.stubGlobal("fetch", mockNetwork(settle));
    await app.fetch(request("capture"), env);
    const encoded = Buffer.from(JSON.stringify(payment("capture"), null, 2)).toString("base64");
    const retry = await app.fetch(request("capture", encoded), env);
    expect(retry.status).toBe(409);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("recovers confirmed payment after initial fulfillment persistence failed without resettling", async () => {
    const bucket = new MemoryBucket();
    const put = bucket.put.bind(bucket);
    let failOnce = true;
    bucket.put = async (key, value, options) => {
      if (failOnce && key.startsWith("fulfillments/")) { failOnce = false; throw new Error("R2 unavailable"); }
      return put(key, value, options);
    };
    const env = runtime(bucket);
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer }));
    const fetchMock = mockNetwork(settle);
    vi.stubGlobal("fetch", fetchMock);
    const first = await app.fetch(request("capture"), env);
    expect(first.status).toBeGreaterThanOrEqual(400);
    const replay = await app.fetch(request("capture"), env);
    expect(replay.status).toBe(200);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });

  it("limits transient capture retries to three paid attempts", async () => {
    const env = runtime(new MemoryBucket());
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    vi.mocked(env.BROWSER.quickAction).mockImplementation(async () => new Response("overloaded", { status: 503 }));
    for (let attempt = 0; attempt < 4; attempt++) await app.fetch(request("capture"), env);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(3);
  });

  it("does not take over an expired processing lease whose write outcome is unknown", async () => {
    const bucket = new MemoryBucket();
    const env = runtime(bucket);
    const req = request("capture");
    const fingerprint = await sha256(req.headers.get("payment-signature")!);
    const body = { url: "https://example.com/" };
    const record = initialFulfillment({ route: "/v1/capture", requestHash: await paidRequestHash("/v1/capture", body), requestedUrl: body.url, fulfillmentFingerprint: fingerprint, paymentFingerprint: fingerprint, paidPriceUsd: 1 });
    await bucket.put(fulfillmentRecordKey(fingerprint), JSON.stringify({ ...record, updated_at: "2020-01-01T00:00:00Z" }));
    vi.stubGlobal("fetch", mockNetwork(async () => { throw new Error("should not settle"); }));
    const response = await app.fetch(req, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ state: "fulfillment_unknown", retryable: false });
    expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });

  it("returns a historical Partner capture before current pricing and live target validation", async () => {
    const nativeCrypto = crypto;
    vi.stubGlobal("crypto", { subtle: {
      digest: nativeCrypto.subtle.digest.bind(nativeCrypto.subtle),
      timingSafeEqual: (left: ArrayBuffer, right: ArrayBuffer) => Buffer.from(left).equals(Buffer.from(right)),
    } });
    const bucket = new MemoryBucket();
    const env = runtime(bucket);
    env.PARTNER_GATEWAY_SECRET = "partner-secret";
    const body = { url: "https://example.com/" };
    const fingerprint = await sha256("partner\nexisting\nhistorical-order");
    const record = initialFulfillment({ route: "/partner/capture", requestHash: await paidRequestHash("/partner/capture", body), requestedUrl: body.url, fulfillmentFingerprint: fingerprint, paidPriceUsd: 0.03 });
    const response = { ok: true, proof_id: "old-partner-proof" };
    await bucket.put(fulfillmentRecordKey(fingerprint), JSON.stringify({ ...record, state: "complete", response }));
    const fetchMock = vi.fn(async () => { throw new Error("offline source"); });
    vi.stubGlobal("fetch", fetchMock);
    const replay = await app.request("https://delta.test/internal/partner/capture", {
      method: "POST", headers: { "content-type": "application/json", "x-delta-core-secret": "partner-secret", "x-delta-partner": "existing", "idempotency-key": "historical-order", "x-delta-gross-usd": "0.03" },
      body: JSON.stringify(body),
    }, env);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...response, idempotent_replay: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pauses a Watch with expired unknown execution instead of reusing its paid sequence", async () => {
    const bucket = new MemoryBucket();
    const env = runtime(bucket);
    const registration = await registerWatch({ env, request: { url: "https://example.com/", checks: 1, interval_seconds: 900 }, requestHash: "hash", fingerprint: "watch-key", partner: "partner", channel: "partner", grossPaidUsd: 1 });
    const key = `watches/${registration.body.watch_id}.json`;
    const record = await (await bucket.get(key))!.json();
    await bucket.put(key, JSON.stringify({ ...record, next_check_at: "2020-01-01T00:00:00Z", lease_until: "2020-01-01T00:01:00Z" }));
    vi.stubGlobal("fetch", mockNetwork(async () => { throw new Error("must not settle"); }));
    await runDueWatches(env);
    const pending = await (await bucket.get(key))!.json();
    expect(pending).toMatchObject({ state: "recovery_required", checks_attempted: 0, checks_remaining: 1 });
    expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });

  it("retains pending settlement evidence instead of calling a broadcast transaction rejected", async () => {
    const bucket = new MemoryBucket();
    const env = runtime(bucket);
    const transaction = "0x" + "34".repeat(32);
    const settle = vi.fn(async () => Response.json({ success: false, errorReason: "settlement_pending", transaction, network: env.NETWORK }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    const first = await app.fetch(request("capture"), env);
    expect(await first.json()).toMatchObject({ state: "settlement_unknown", retryable: false });
    await app.fetch(request("capture"), env);
    expect(settle).toHaveBeenCalledTimes(1);
    const journal = [...bucket.values].find(([key]) => key.startsWith("settlements/"))![1];
    expect(JSON.parse(journal.text)).toMatchObject({ state: "settlement_unknown", transaction_hint: transaction });
  });

  it.each(["capture", "guarded-action-pilot"])("%s redacts journal read failure instead of exposing storage errors", async (product) => {
    const bucket = new MemoryBucket();
    bucket.get = async () => { throw new Error("Authorization: Bearer private-storage-secret"); };
    const env = runtime(bucket);
    vi.stubGlobal("fetch", mockNetwork(async () => { throw new Error("must not settle"); }));
    const response = await app.fetch(request(product), env);
    expect(await response.text()).not.toContain("private-storage-secret");
    expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });

  it.each(["capture", "guarded-action-pilot"])("%s preserves complete delivery when its storage response times out after committing", async (product) => {
    const bucket = new MemoryBucket();
    const put = bucket.put.bind(bucket);
    let committed = false;
    bucket.put = async (key, value, options) => {
      const result = await put(key, value, options);
      if (!committed && (key.startsWith("fulfillments/") || key.startsWith("guarded-pilot/")) && JSON.parse(String(value)).state === "complete") {
        committed = true;
        throw new DOMException("simulated reply timeout after committing complete", "TimeoutError");
      }
      return result;
    };
    const env = runtime(bucket);
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    const first = await app.fetch(request(product), env);
    const firstBody = await first.json();
    const replay = await app.fetch(request(product), env);
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
    expect(firstBody).toMatchObject({ state: "fulfillment_unknown", retryable: false });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: true, idempotent_replay: true });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });

  it("keeps a transaction hint from a structured facilitator HTTP failure", async () => {
    const bucket = new MemoryBucket();
    const env = runtime(bucket);
    const transaction = "0x" + "56".repeat(32);
    const settle = vi.fn(async () => Response.json({ success: false, errorReason: "settlement_pending", transaction, network: env.NETWORK }, { status: 503 }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    await app.fetch(request("capture"), env);
    await app.fetch(request("capture"), env);
    const journal = [...bucket.values].find(([key]) => key.startsWith("settlements/"))![1];
    expect(JSON.parse(journal.text)).toMatchObject({ state: "settlement_unknown", failure_class: "upstream_http_503", transaction_hint: transaction });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("does not copy raw analytics failures into application logs", async () => {
    const env = runtime(new MemoryBucket());
    env.ANALYTICS_DB.prepare = () => { throw new Error("Authorization: Bearer private-analytics-secret"); };
    await recordEvent(env, { event: "capture_failed", route: "/v1/capture", success: false });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private-analytics-secret");
    expect(console.error).toHaveBeenCalledWith(JSON.stringify({ event: "analytics_write_failed", reason: "dependency_failure" }));
  });

  it("does not invent a historical partner retry amount from a new header", async () => {
    const nativeCrypto = crypto;
    vi.stubGlobal("crypto", { subtle: {
      digest: nativeCrypto.subtle.digest.bind(nativeCrypto.subtle),
      timingSafeEqual: (left: ArrayBuffer, right: ArrayBuffer) => Buffer.from(left).equals(Buffer.from(right)),
    } });
    const bucket = new MemoryBucket();
    const env = runtime(bucket);
    env.PARTNER_GATEWAY_SECRET = "partner-secret";
    const body = { url: "https://example.com/" };
    const fingerprint = await sha256("partner\nexisting\nhistorical-order");
    const record = initialFulfillment({ route: "/partner/capture", requestHash: await paidRequestHash("/partner/capture", body), requestedUrl: body.url, fulfillmentFingerprint: fingerprint });
    await bucket.put(fulfillmentRecordKey(fingerprint), JSON.stringify({ ...record, state: "retryable_failure" }));
    vi.stubGlobal("fetch", mockNetwork(async () => { throw new Error("must not settle"); }));
    const response = await app.request("https://delta.test/internal/partner/capture", {
      method: "POST", headers: { "content-type": "application/json", "x-delta-core-secret": "partner-secret", "x-delta-partner": "existing", "idempotency-key": "historical-order", "x-delta-gross-usd": "1" },
      body: JSON.stringify(body),
    }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ state: "fulfillment_unknown", retryable: false });
    expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });

  it("does not let an expired Watch owner overwrite a newer recovery decision", async () => {
    const bucket = new MemoryBucket();
    const env = runtime(bucket);
    const registration = await registerWatch({ env, request: { url: "https://example.com/", checks: 1, interval_seconds: 900 }, requestHash: "hash", fingerprint: "watch-key", partner: "partner", channel: "partner", grossPaidUsd: 1 });
    const key = `watches/${registration.body.watch_id}.json`;
    const record = await (await bucket.get(key))!.json();
    await bucket.put(key, JSON.stringify({ ...record, next_check_at: "2020-01-01T00:00:00Z" }));
    const browser = vi.mocked(env.BROWSER.quickAction);
    const original = browser.getMockImplementation()!;
    browser.mockImplementation(async (...args) => {
      const current = await (await bucket.get(key))!.json();
      await bucket.put(key, JSON.stringify({ ...current, state: "recovery_required" }));
      return original(...args);
    });
    vi.stubGlobal("fetch", mockNetwork(async () => { throw new Error("must not settle"); }));
    await runDueWatches(env);
    expect(await (await bucket.get(key))!.json()).toMatchObject({ state: "recovery_required", checks_remaining: 1, checks_attempted: 0 });
  });
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("durable fulfillment claim fencing across workers", () => {
  it.each(["capture", "preflight", "guarded-action-pilot"])("%s carries the new retry claim through delivery while a competing retry waits", async (product) => {
    const bucket = new MemoryBucket();
    const env = runtime(bucket);
    const entered = deferred();
    const release = deferred();
    vi.mocked(env.BROWSER.quickAction).mockResolvedValueOnce(new Response("temporary failure", { status: 503 })).mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return runtime(new MemoryBucket()).BROWSER.quickAction(...args);
    });
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    expect((await app.fetch(request(product), env)).status).toBe(502);
    const retry = app.fetch(request(product), env);
    await entered.promise;
    expect((await app.fetch(request(product), env)).status).toBe(202);
    release.resolve();
    expect((await retry).status).toBe(200);
    const key = [...bucket.values.keys()].find((candidate) => candidate.startsWith(product === "guarded-action-pilot" ? "guarded-pilot/" : "fulfillments/"))!;
    expect(await (await bucket.get(key))!.json()).toMatchObject({ state: "complete", attempts: 2 });
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it.each(["capture", "preflight", "guarded-action-pilot"])("%s allows one live worker and an ordinary same-order retry", async (product) => {
    const bucket = new MemoryBucket();
    const env = runtime(bucket);
    const entered = deferred();
    const release = deferred();
    const capture = env.BROWSER.quickAction;
    vi.mocked(env.BROWSER.quickAction).mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return runtime(new MemoryBucket()).BROWSER.quickAction(...args);
    });
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    const first = app.fetch(request(product), env);
    await entered.promise;
    const second = await app.fetch(request(product), env);
    expect(second.status).toBe(202);
    release.resolve();
    expect((await first).status).toBe(200);
    expect((await app.fetch(request(product), env)).status).toBe(200);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it.each(["capture", "preflight", "guarded-action-pilot"].flatMap((product) => ["draft", "failure"].map((phase) => ({ product, phase }))))("$product rejects a stale worker's $phase after another worker persists a decision", async ({ product, phase }) => {
    const bucket = new MemoryBucket();
    const env = runtime(bucket);
    const entered = deferred();
    const release = deferred();
    vi.mocked(env.BROWSER.quickAction).mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return phase === "failure" ? new Response("temporary failure", { status: 503 }) : runtime(new MemoryBucket()).BROWSER.quickAction(...args);
    });
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    const originalWorker = app.fetch(request(product), env);
    await entered.promise;
    const prefix = product === "guarded-action-pilot" ? "guarded-pilot/" : "fulfillments/";
    const key = [...bucket.values.keys()].find((candidate) => candidate.startsWith(prefix))!;
    const original = await bucket.get(key);
    const record = await original!.json();
    // Simulate an independently running reconciliation worker's legitimate CAS.
    const decision = { ...record, state: "blocked_failure", error: "reconciliation_decision", updated_at: "2026-10-28T00:00:00.000Z" };
    const newer = await commitClaim(env, key, { record, etag: original!.etag }, decision);
    expect(newer).not.toBeNull();
    release.resolve();
    const response = await originalWorker;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ state: "fulfillment_unknown", retryable: false });
    expect(await (await bucket.get(key))!.json()).toEqual(decision);
    expect((await bucket.get(key))!.etag).toBe(newer!.etag);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });

  it.each(["capture", "preflight", "guarded-action-pilot"])("%s prevents a late final commit from replacing recovery by a second worker", async (product) => {
    const bucket = new MemoryBucket();
    const put = bucket.put.bind(bucket);
    const entered = deferred();
    const release = deferred();
    let held = false;
    bucket.put = async (key, value, options) => {
      if (!held && (key.startsWith("fulfillments/") || key.startsWith("guarded-pilot/")) && JSON.parse(String(value)).state === "complete") {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return put(key, value, options);
    };
    const env = runtime(bucket);
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    const originalWorker = app.fetch(request(product), env);
    await entered.promise;
    const recovery = await app.fetch(request(product), env);
    expect(recovery.status).toBe(200);
    expect(await recovery.json()).toMatchObject({ ok: true, idempotent_replay: true });
    const key = [...bucket.values.keys()].find((candidate) => candidate.startsWith(product === "guarded-action-pilot" ? "guarded-pilot/" : "fulfillments/"))!;
    const completed = { ...bucket.values.get(key)! };
    release.resolve();
    expect((await originalWorker).status).toBe(503);
    expect(bucket.values.get(key)).toEqual(completed);
    expect((await app.fetch(request(product), env)).status).toBe(200);
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
  });
});

describe("buyer assurance adversarial core", () => {
  it.each(["amount", "payer", "success_string"])("does not trust an old confirmed journal with an invalid %s", async (field) => {
    const bucket = new MemoryBucket();
    const put = bucket.put.bind(bucket);
    bucket.put = async (key, value, options) => {
      if (key.startsWith("fulfillments/")) throw new Error("initial fulfillment unavailable");
      return put(key, value, options);
    };
    const env = runtime(bucket);
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer, amount: "1000000" }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    await app.fetch(request("capture"), env);
    const [key, stored] = [...bucket.values].find(([key]) => key.startsWith("settlements/"))!;
    const record = JSON.parse(stored.text);
    if (field === "amount") record.result.amount = "1";
    else if (field === "payer") record.result.payer = payTo;
    else record.result.success = "true";
    await put(key, JSON.stringify(record));
    bucket.put = put;
    const retry = await app.fetch(request("capture"), env);
    expect(retry.status).toBeGreaterThanOrEqual(400);
    expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledTimes(1);
  });
  it.each(["capture", "preflight", "guarded-action-pilot"])("%s accepts an actual challenge round-trip via an alias host and query string", async (product) => {
    const env = runtime(new MemoryBucket());
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    const incoming = `https://alias.test/v1/${product}?channel=buyer`;
    const challengeResponse = await app.fetch(new Request(incoming, { method: "POST" }), env);
    expect(challengeResponse.status).toBe(402);
    const challenge = JSON.parse(Buffer.from(challengeResponse.headers.get("payment-required")!, "base64").toString());
    expect(challenge.resource.url).toBe(`https://delta.test/v1/${product}`);
    const payload = { ...payment(product), resource: challenge.resource, accepted: challenge.accepts[0] };
    const signedFixture = request(product, Buffer.from(JSON.stringify(payload)).toString("base64"));
    const response = await app.fetch(new Request(incoming, signedFixture), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("payment-response")).toBeTruthy();
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("accepts valid PNG and a genuinely empty markdown string", async () => {
    const env = runtime(new MemoryBucket());
    vi.mocked(env.BROWSER.quickAction).mockResolvedValue(Response.json({ success: true, result: { content: "<html></html>", markdown: "", screenshot: png }, meta: { status: 200 } }));
    vi.stubGlobal("fetch", mockNetwork(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer })));
    expect((await app.fetch(request("capture"), env)).status).toBe(200);
  });

  it.each(["throw_before", "commit_then_throw", "conditional_conflict"])("never submits settlement without an acknowledged durable reservation (%s)", async (mode) => {
    const bucket = new MemoryBucket();
    const put = bucket.put.bind(bucket);
    bucket.put = async (key, value, options) => {
      if (key.startsWith("settlements/") && options?.onlyIf && "etagDoesNotMatch" in options.onlyIf) {
        if (mode !== "throw_before") await put(key, value, options);
        if (mode === "conditional_conflict") return null;
        throw new DOMException("storage response unknown", "TimeoutError");
      }
      return put(key, value, options);
    };
    const env = runtime(bucket);
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    await app.fetch(request("capture"), env);
    await app.fetch(request("capture"), env);
    expect(settle).not.toHaveBeenCalled();
    expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });

  it.each(["commit_then_throw", "conditional_conflict"])("reads a committed settlement confirmation after an uncertain write acknowledgement (%s)", async (mode) => {
    const bucket = new MemoryBucket();
    const put = bucket.put.bind(bucket);
    let once = true;
    bucket.put = async (key, value, options) => {
      const result = await put(key, value, options);
      if (once && key.startsWith("settlements/") && JSON.parse(String(value)).state === "settlement_confirmed") {
        once = false;
        if (mode === "conditional_conflict") return null;
        throw new DOMException("confirmation write acknowledged too late", "TimeoutError");
      }
      return result;
    };
    const env = runtime(bucket);
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    expect((await app.fetch(request("capture"), env)).status).toBe(503);
    expect((await app.fetch(request("capture"), env)).status).toBe(200);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });

  it("binds a used nonce to its original body and product", async () => {
    const env = runtime(new MemoryBucket());
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    expect((await app.fetch(request("capture"), env)).status).toBe(200);
    expect((await app.fetch(request("capture", undefined, { url: "https://example.com/other" }), env)).status).toBe(409);
    expect((await app.fetch(request("preflight"), env)).status).toBeGreaterThanOrEqual(400);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });
  it.each(["missing_markdown", "non_png_screenshot", "invalid_status_type", "accepted_not_complete"])("does not sell a malformed Browser result as a complete proof (%s)", async (variant) => {
    const env = runtime(new MemoryBucket());
    const result: Record<string, unknown> = { content: "<h1>Example</h1>", markdown: "Example", screenshot: png };
    const meta: Record<string, unknown> = { status: 200, finalUrl: "https://example.com/" };
    if (variant === "missing_markdown") delete result.markdown;
    if (variant === "non_png_screenshot") result.screenshot = "AA==";
    if (variant === "invalid_status_type") meta.status = "200";
    vi.mocked(env.BROWSER.quickAction).mockResolvedValue(Response.json({ success: true, result, meta }, { status: variant === "accepted_not_complete" ? 202 : 200 }));
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    const response = await app.fetch(request("capture"), env);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.json()).not.toMatchObject({ ok: true });
    expect(settle).toHaveBeenCalledTimes(1);
  });
  it.each(["capture", "preflight", "guarded-action-pilot"])("%s completes a first paid request and replay without another settlement", async (product) => {
    const bucket = new MemoryBucket();
    const env = runtime(bucket);
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    const first = await app.fetch(request(product), env);
    expect(first.status).toBe(200);
    expect(first.headers.get("payment-response")).toBeTruthy();
    const delivered = await first.json();
    expect(delivered).toMatchObject({ ok: true });
    expect((await app.fetch(request(product), env)).status).toBe(200);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });

  it.each(["resource", "authorization_recipient", "authorization_value", "accepted_amount", "accepted_pay_to", "accepted_asset", "accepted_network"])("rejects a mismatched %s before attempting settlement", async (field) => {
    const env = runtime(new MemoryBucket());
    const candidate = payment("capture");
    if (field === "resource") candidate.resource.url = "https://other.test/v1/capture";
    if (field === "authorization_recipient") candidate.payload.authorization.to = payer;
    if (field === "authorization_value") candidate.payload.authorization.value = "1";
    if (field === "accepted_amount") candidate.accepted.amount = "1";
    if (field === "accepted_pay_to") candidate.accepted.payTo = payer;
    if (field === "accepted_asset") candidate.accepted.asset = payer;
    if (field === "accepted_network") candidate.accepted.network = "eip155:1";
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    const response = await app.fetch(request("capture", Buffer.from(JSON.stringify(candidate)).toString("base64")), env);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(settle).not.toHaveBeenCalled();
    expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });

  it.each(["amount", "payer"])("does not accept a settlement receipt with a mismatched %s", async (field) => {
    const env = runtime(new MemoryBucket());
    const receipt = { success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer, amount: "1000000" };
    if (field === "amount") receipt.amount = "1";
    else receipt.payer = payTo;
    const settle = vi.fn(async () => Response.json(receipt));
    vi.stubGlobal("fetch", mockNetwork(settle));
    const response = await app.fetch(request("capture"), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ state: "settlement_unknown", retryable: false });
    await app.fetch(request("capture"), env);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });

  it.each(["capture", "preflight", "guarded-action-pilot"])("%s recovers existing verified artifacts when final delivery persistence never committed", async (product) => {
    const bucket = new MemoryBucket();
    const put = bucket.put.bind(bucket);
    let fail = true;
    bucket.put = async (key, value, options) => {
      if (fail && (key.startsWith("fulfillments/") || key.startsWith("guarded-pilot/")) && JSON.parse(String(value)).state === "complete") {
        fail = false;
        throw new Error("simulated storage outage before final delivery commit");
      }
      return put(key, value, options);
    };
    const env = runtime(bucket);
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    const first = await app.fetch(request(product), env);
    expect(first.status).toBe(503);
    const retry = await app.fetch(request(product), env);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ ok: true, idempotent_replay: true });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });

  it.each(["html_tampered", "missing_screenshot", "manifest_wrong_id", "wrong_fulfillment_identity"])("does not recover an unverified evidence set (%s)", async (damage) => {
    const bucket = new MemoryBucket();
    const put = bucket.put.bind(bucket);
    bucket.put = async (key, value, options) => {
      if (key.startsWith("fulfillments/") && JSON.parse(String(value)).state === "complete") throw new Error("complete write unavailable");
      return put(key, value, options);
    };
    const env = runtime(bucket);
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    await app.fetch(request("capture"), env);
    const manifestKey = [...bucket.values.keys()].find((key) => key.endsWith("/manifest.json"))!;
    const proofId = manifestKey.split("/")[0];
    if (damage === "html_tampered") await put(`${proofId}/page.html`, "tampered HTML");
    if (damage === "missing_screenshot") bucket.values.delete(`${proofId}/screenshot.png`);
    if (damage === "manifest_wrong_id") {
      const manifest = await (await bucket.get(manifestKey))!.json();
      await put(manifestKey, JSON.stringify({ ...manifest, proof_id: "different-proof" }));
    }
    if (damage === "wrong_fulfillment_identity") {
      const key = [...bucket.values.keys()].find((key) => key.startsWith("fulfillments/"))!;
      const record = await (await bucket.get(key))!.json();
      await put(key, JSON.stringify({ ...record, payment_fingerprint: "sha256:another-payment" }));
    }
    bucket.put = put;
    const retry = await app.fetch(request("capture"), env);
    expect(retry.status).not.toBe(200);
    expect(await retry.json()).not.toMatchObject({ ok: true });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });

  it("preserves the original unsafe Preflight result when its prior proof later disappears", async () => {
    const bucket = new MemoryBucket();
    const env = runtime(bucket);
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    const prior = await (await app.fetch(request("capture"), env)).json<{ proof_id: string }>();
    const header = payment("preflight");
    header.payload.authorization.nonce = "0x" + "ef".repeat(32);
    const encoded = Buffer.from(JSON.stringify(header)).toString("base64");
    const body = { url: "https://example.com/", prior_proof_id: prior.proof_id, expected: { contains: ["must be present but missing"] } };
    const put = bucket.put.bind(bucket);
    let once = true;
    bucket.put = async (key, value, options) => {
      if (once && key.startsWith("fulfillments/") && JSON.parse(String(value)).state === "complete") { once = false; throw new Error("complete write unavailable"); }
      return put(key, value, options);
    };
    expect((await app.fetch(request("preflight", encoded, body), env)).status).toBe(503);
    bucket.values.delete(`${prior.proof_id}/manifest.json`);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("target no longer online"); }));
    const recovered = await app.fetch(request("preflight", encoded, body), env);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ ok: true, safe: false, reason: "expectation_failed", idempotent_replay: true });
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it("recovers a delivery with CAS and tolerates a parallel lost claim without recapturing", async () => {
    const bucket = new MemoryBucket();
    const put = bucket.put.bind(bucket);
    bucket.put = async (key, value, options) => {
      if (key.startsWith("fulfillments/") && JSON.parse(String(value)).state === "complete") throw new Error("complete write unavailable");
      return put(key, value, options);
    };
    const env = runtime(bucket);
    const settle = vi.fn(async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: env.NETWORK, payer }));
    vi.stubGlobal("fetch", mockNetwork(settle));
    await app.fetch(request("capture"), env);
    let lost = false;
    bucket.put = async (key, value, options) => {
      if (key.startsWith("fulfillments/") && JSON.parse(String(value)).state === "complete") {
        expect(options?.onlyIf).toHaveProperty("etagMatches");
        if (!lost) { lost = true; return null; }
      }
      return put(key, value, options);
    };
    const results = await Promise.all([app.fetch(request("capture"), env), app.fetch(request("capture"), env)]);
    expect(results.map((response) => response.status)).toContain(200);
    expect((await app.fetch(request("capture"), env)).status).toBe(200);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });
});

