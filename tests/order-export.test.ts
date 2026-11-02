import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import type { RuntimeEnv } from "../src/env";
import { sha256, stableJson, uuidFromDigest } from "../src/crypto";
import { bundleRootMaterial, type ProofManifest } from "../src/capture";
import { fulfillmentRecordKey, initialFulfillment, paidRequestHash, deliveryDigest, type DeliveryResponse } from "../src/fulfillment";
import { orderAuthorityDigest, orderRecordKey, type OrderBinding } from "../src/orders";
import { exportOrderArtifact, ORDER_EXPORT_TIMEOUT_MS, MAX_EXPORT_MANIFEST_BYTES } from "../src/order-export";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
// Synthetic test capabilities only; no wallet or provider credentials.
const token = Buffer.alloc(32, 1).toString("base64url");
const otherToken = Buffer.alloc(32, 2).toString("base64url");
const encoder = new TextEncoder();
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64"));
const now = Date.parse("2026-10-29T08:00:00.000Z");
class Bucket {
  values = new Map<string, Uint8Array>();
  set(key: string, value: unknown) { this.values.set(key, value instanceof Uint8Array ? value : encoder.encode(typeof value === "string" ? value : JSON.stringify(value))); }
  get = vi.fn(async (key: string) => {
    const bytes = this.values.get(key)?.slice();
    if (!bytes) return null;
    return { size: bytes.byteLength, etag: `etag-${key}`, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)), arrayBuffer: async () => bytes.slice().buffer };
  });
  put = vi.fn(async () => { throw new Error("export_must_never_write"); });
}
function request(options: { token?: string | null; id?: string; origin?: string; method?: string; query?: string; payment?: boolean } = {}) {
  const headers = new Headers();
  if (options.token !== null) headers.set("x-delta-recovery-token", options.token ?? token);
  if (options.origin) headers.set("origin", options.origin);
  if (options.payment) headers.set("payment-signature", "synthetic-obsolete-payment");
  return new Request(`https://delta.test/v1/orders/${options.id ?? id}/artifacts/html${options.query ?? ""}`, { method: options.method ?? "GET", headers });
}
async function fixture(product: "capture" | "preflight" = "capture", originalAmount?: string, historicalEmptyMarkdown = false) {
  vi.setSystemTime(now);
  const bucket = new Bucket();
  const env = { PROOFS: bucket, PAY_TO: "0x1990e21bc219696ff7fbc26527dbaed335ac6367", NETWORK: "eip155:8453", PUBLIC_ORIGIN: "https://delta.test",
    BROWSER: { quickAction: vi.fn(async () => { throw new Error("export_must_not_capture"); }) } } as unknown as RuntimeEnv;
  const fingerprint = await sha256("synthetic-completed-order");
  const proofId = uuidFromDigest(await sha256(`${fingerprint}\n${product}`));
  const body = { url: "https://example.com/" };
  const order: OrderBinding = { schema: "delta-order-binding/v1", order_id: id, token_digest: await sha256(`delta-order-token/v1\n${id}\n${token}`),
    scope: ["status", "recover", "export"], created_at: new Date(now - 60000).toISOString(), expires_at: new Date(now + 60000).toISOString(),
    product, resource: `https://delta.test/v1/${product}`, request_hash: await paidRequestHash(`/v1/${product}`, body), request_body: body,
    payment_fingerprint: fingerprint, settlement_key: `settlements/${"a".repeat(64)}.json`, network: env.NETWORK,
    asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", pay_to: env.PAY_TO, payer: "0x1111111111111111111111111111111111111111", amount: originalAmount ?? (product === "capture" ? "1000000" : "5000000") };
  const price = Number(order.amount) / 1e6;
  const html = encoder.encode('<html><script>fetch("/internal")</script><h1>Original evidence</h1></html>');
  const md = encoder.encode(historicalEmptyMarkdown ? '' : "# Original evidence\n");
  const base = {
    schema: "delta-proof-bundle/v0.6.0" as const, proof_id: proofId, product, requested_url: body.url, requested_url_sha256: await sha256(body.url),
    capture_started_at: new Date(now - 5000).toISOString(), capture_completed_at: new Date(now - 4000).toISOString(), observed_http_status: 200,
    observed_title: "Synthetic original", observed_final_url: body.url, redirects: { preflight_count: 0, browser_count: 0 },
    hashes: { html: await sha256(html), markdown: await sha256(md), screenshot_png: await sha256(png) },
    artifact_sizes: { html_bytes: html.length, markdown_bytes: md.length, screenshot_png_bytes: png.length, total_bytes: html.length + md.length + png.length },
    execution: { browser_ms_used: 1000, estimated_variable_cost_usd: 0.01, gross_price_usd: price, estimated_contribution_margin_usd: price - 0.01 },
    storage: { html: `${proofId}/page.html`, markdown: `${proofId}/page.md`, screenshot: `${proofId}/screenshot.png`, manifest: `${proofId}/manifest.json` },
    payment: { protocol: "x402-v2-upfront" as const, network: env.NETWORK, asset: "USDC" as const, listed_price_usd: price, pay_to: env.PAY_TO, channel: "synthetic", partner: null },
    attestation: { status: "hash_only" as const, canonicalization: "delta-bundle-root/v1" as const }, disclaimer: "Synthetic test observation, not truth",
  };
  const manifest: ProofManifest = { ...base, hashes: { ...base.hashes, bundle_root: await sha256(stableJson(bundleRootMaterial(base))) } };
  const rawManifest = encoder.encode(JSON.stringify(manifest, null, 2) + "\n");
  const delivery: DeliveryResponse = { ok: true, product, proof_id: proofId, manifest_url: `https://delta.test/v1/proofs/${proofId}`, public_proof_url: `https://delta.test/p/${proofId}`,
    bundle_root: manifest.hashes.bundle_root, observed_at: manifest.capture_completed_at,
    ...(product === "preflight" ? { safe: null, changed: null, reason: "observation_only_no_baseline" } : {}) };
  const initial = initialFulfillment({ route: `/v1/${product}`, requestHash: order.request_hash, requestedUrl: body.url,
    fulfillmentFingerprint: fingerprint, paymentFingerprint: fingerprint, paidPriceUsd: price });
  const fulfillment = { ...initial, state: "complete" as const, response: delivery, response_hash: await deliveryDigest(initial, delivery) };
  const settlement = { schema: "delta-settlement/v1", state: "settlement_confirmed", request_hash: order.request_hash, payment_fingerprint: fingerprint,
    amount: order.amount, order_id: id, order_binding_hash: await orderAuthorityDigest(order), updated_at: new Date(now).toISOString(),
    result: { success: true, transaction: "0x" + "a".repeat(64), network: order.network, payer: order.payer, amount: order.amount } };
  bucket.set(orderRecordKey(id), order); bucket.set(order.settlement_key, settlement); bucket.set(fulfillmentRecordKey(fingerprint), fulfillment);
  bucket.set(manifest.storage.html, html); bucket.set(manifest.storage.markdown, md); bucket.set(manifest.storage.screenshot, png); bucket.set(manifest.storage.manifest, rawManifest);
  return { bucket, env, order, settlement, fulfillment, manifest, rawManifest, html, md, proofId, files: [html, md, png, rawManifest] };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("authenticated original order export, isolated R2 fixtures", () => {
  it('preserves a historical empty markdown artifact under its original hashed manifest without recapture', async () => {
    const f = await fixture('capture', undefined, true);
    const before = [...f.bucket.values].map(([key,bytes]) => [key,Array.from(bytes)]);
    const response = await app.fetch(new Request(`https://delta.test/v1/orders/${id}/artifacts/markdown`, {headers:{'x-delta-recovery-token':token}}),f.env);
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    expect(f.env.BROWSER.quickAction).not.toHaveBeenCalled(); expect(f.bucket.put).not.toHaveBeenCalled();
    expect([...f.bucket.values].map(([key,bytes]) => [key,Array.from(bytes)])).toEqual(before);
  });
  it("full API route preserves private attachment sandbox and trusted CORS", async () => {
    const f = await fixture();
    const response = await app.fetch(request({ origin: "https://delta.test" }), f.env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("content-security-policy")).toContain("sandbox;");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://delta.test");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.html);
    const wrong = await app.fetch(request({ origin: "https://untrusted.test" }), f.env);
    expect(wrong.status).toBe(404); expect(wrong.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await app.fetch(request({ origin: "https://delta.test", method: "OPTIONS", token: null }), f.env);
    expect(preflight.status).toBe(204); expect(preflight.headers.get("access-control-allow-origin")).toBe("https://delta.test");
    expect(f.bucket.put).not.toHaveBeenCalled(); expect(f.env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it.each(["capture", "preflight"] as const)("exports each exact original %s file without capture, settlement or writes", async product => {
    const f = await fixture(product);
    const network = vi.fn(() => { throw new Error("no_network"); }); vi.stubGlobal("fetch", network);
    for (const [i, artifact] of ["html", "markdown", "screenshot", "manifest"].entries()) {
      const response = await exportOrderArtifact(f.env, id, request({ origin: "https://delta.test" }), artifact);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.files[i]);
      expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="delta-/);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; frame-ancestors 'none'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-delta-content-sha256")).toBe(await sha256(f.files[i]));
      expect(response.headers.get("access-control-allow-origin")).toBe("https://delta.test");
      if (i < 2) expect(response.headers.get("content-type")).toBe("application/octet-stream");
    }
    expect(network).not.toHaveBeenCalled(); expect(f.bucket.put).not.toHaveBeenCalled(); expect(f.env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it("preserves an entitled historical paid price rather than applying current quotes", async () => {
    const f = await fixture("capture", "10000");
    const response = await exportOrderArtifact(f.env, id, request(), "manifest");
    expect(response.status).toBe(200);
    const manifest = await response.json() as ProofManifest;
    expect(manifest.payment.listed_price_usd).toBe(0.01);
    expect(f.bucket.put).not.toHaveBeenCalled();
  });
  it("serves concurrent downloads of one order without storage mutation or duplicate work", async () => {
    const f = await fixture();
    const responses = await Promise.all(Array.from({ length: 10 }, () => exportOrderArtifact(f.env, id, request(), "html")));
    for (const response of responses) {
      expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.html);
    }
    expect(f.bucket.put).not.toHaveBeenCalled(); expect(f.env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it("does not disclose provider error bodies or capabilities", async () => {
    const f = await fixture(); f.bucket.get.mockRejectedValue(new Error("provider-error synthetic-private-context"));
    const response = await exportOrderArtifact(f.env, id, request(), "manifest");
    expect(response.status).toBe(503); const body = await response.text();
    expect(body).not.toContain("synthetic-private-context"); expect(body).not.toContain(token);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it.each([null, otherToken, "invalid"])("rejects absent/wrong capability %s before reading artifacts", async supplied => {
    const f = await fixture(); const response = await exportOrderArtifact(f.env, id, request({ token: supplied }), "html");
    expect(response.status).toBe(404); expect(f.bucket.get.mock.calls.some(([key]) => key.startsWith(f.proofId))).toBe(false);
    expect(await response.text()).not.toContain(token);
  });
  it("rejects wrong order and public proof IDs", async () => {
    const f = await fixture();
    for (const target of [otherId, f.proofId]) expect((await exportOrderArtifact(f.env, target, request({ id: target }), "html")).status).toBe(404);
  });
  it("does not widen old status/recover scopes", async () => {
    const f = await fixture(); f.order.scope = ["status", "recover"]; f.bucket.set(orderRecordKey(id), f.order);
    expect((await exportOrderArtifact(f.env, id, request(), "html")).status).toBe(403);
  });
  it.each(["expired", "revoked", "rotated"])("rejects a %s capability", async mode => {
    const f = await fixture();
    if (mode === "expired") f.order.expires_at = new Date(now - 1).toISOString();
    if (mode === "revoked") f.order.revoked_at = new Date(now).toISOString();
    if (mode === "rotated") f.order.token_digest = await sha256(`delta-order-token/v1\n${id}\n${otherToken}`);
    f.bucket.set(orderRecordKey(id), f.order);
    expect((await exportOrderArtifact(f.env, id, request(), "html")).status).toBe(mode === "expired" ? 410 : 404);
  });
  it("never accepts capability in URL or payment header as download authority", async () => {
    const f = await fixture();
    expect((await exportOrderArtifact(f.env, id, request({ query: `?token=${token}` }), "html")).status).toBe(404);
    expect((await exportOrderArtifact(f.env, id, request({ token: null, payment: true }), "html")).status).toBe(404);
    expect((await exportOrderArtifact(f.env, id, request({ payment: true }), "html")).status).toBe(400);
  });
  it.each(["order_id", "order_binding_hash", "amount"])("rejects journal %s disagreement", async field => {
    const f = await fixture(); f.bucket.set(f.order.settlement_key, { ...f.settlement, [field]: "conflicting-synthetic-evidence" });
    expect((await exportOrderArtifact(f.env, id, request(), "html")).status).toBe(503);
  });
  it.each(["processing", "blocked_failure", "retryable_failure"])("does not export %s fulfillment", async state => {
    const f = await fixture(); f.bucket.set(fulfillmentRecordKey(f.order.payment_fingerprint), { ...f.fulfillment, state, response: state === "processing" ? f.fulfillment.response : undefined });
    expect((await exportOrderArtifact(f.env, id, request(), "html")).status).toBe(409);
    expect(f.bucket.put).not.toHaveBeenCalled();
  });
  it("does not export an unsettled or missing entitlement", async () => {
    const f = await fixture(); f.bucket.set(f.order.settlement_key, { ...f.settlement, state: "settlement_unknown", result: undefined });
    expect((await exportOrderArtifact(f.env, id, request(), "html")).status).toBe(503);
    f.bucket.values.delete(f.order.settlement_key);
    expect((await exportOrderArtifact(f.env, id, request(), "html")).status).toBe(503);
  });
  it.each(["html", "markdown", "screenshot", "manifest"] as const)("rejects a tampered %s even when requesting a different file", async artifact => {
    const f = await fixture(); f.bucket.set(f.manifest.storage[artifact], "tampered-content");
    expect((await exportOrderArtifact(f.env, id, request(), artifact === "manifest" ? "html" : "manifest")).status).toBe(503);
  });
  it.each(["html", "markdown", "screenshot", "manifest"] as const)("rejects missing %s rather than generate a replacement", async artifact => {
    const f = await fixture(); f.bucket.values.delete(f.manifest.storage[artifact]);
    expect((await exportOrderArtifact(f.env, id, request(), "manifest")).status).toBe(503);
    expect(f.bucket.put).not.toHaveBeenCalled(); expect(f.env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it("binds each artifact snapshot once despite shared verifier reuse", async () => {
    const f = await fixture(); expect((await exportOrderArtifact(f.env, id, request(), "manifest")).status).toBe(200);
    for (const key of Object.values(f.manifest.storage)) expect(f.bucket.get.mock.calls.filter(([called]) => called === key)).toHaveLength(1);
  });
  it("fails closed when bytes exceed declared metadata size", async () => {
    const f = await fixture(); const original = f.bucket.get.getMockImplementation()!;
    f.bucket.get.mockImplementation(async key => { const object = await original(key); if (key === f.manifest.storage.html && object) object.size = 1; return object; });
    expect((await exportOrderArtifact(f.env, id, request(), "html")).status).toBe(503);
  });
  it.each([32001, NaN, -1])("rejects invalid/oversized order metadata size %s before parsing", async size => {
    const f = await fixture(); const original = f.bucket.get.getMockImplementation()!; const cancel = vi.fn();
    f.bucket.get.mockImplementation(async key => { const object = await original(key); if (key === orderRecordKey(id) && object) return { ...object, size, body: new ReadableStream({ cancel }) }; return object; });
    expect((await exportOrderArtifact(f.env, id, request(), "manifest")).status).toBe(503);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(f.bucket.get.mock.calls.some(([key]) => key.startsWith(f.proofId))).toBe(false);
  });
  it("rejects oversized manifest before reading its body", async () => {
    const f = await fixture(); const original = f.bucket.get.getMockImplementation()!; const cancel = vi.fn();
    f.bucket.get.mockImplementation(async key => { const object = await original(key); if (key === f.manifest.storage.manifest && object) return { ...object, size: MAX_EXPORT_MANIFEST_BYTES + 1, body: new ReadableStream({ cancel }) }; return object; });
    expect((await exportOrderArtifact(f.env, id, request(), "html")).status).toBe(503); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each(["expired", "revoked", "rotated"])("rechecks %s authority after reading artifact bytes", async mode => {
    const f = await fixture(); const original = f.bucket.get.getMockImplementation()!;
    f.bucket.get.mockImplementation(async key => { const object = await original(key); if (key === f.manifest.storage.html) {
      if (mode === "expired") vi.setSystemTime(now + 60001);
      if (mode === "revoked") f.order.revoked_at = new Date(now).toISOString();
      if (mode === "rotated") f.order.token_digest = await sha256(`delta-order-token/v1\n${id}\n${otherToken}`);
      if (mode !== "expired") f.bucket.set(orderRecordKey(id), f.order);
    } return object; });
    expect((await exportOrderArtifact(f.env, id, request(), "html")).status).toBe(mode === "expired" ? 410 : 404);
  });
  it("isolates unknown-origin, unsupported method and path traversal selectors", async () => {
    const f = await fixture();
    expect((await exportOrderArtifact(f.env, id, request({ origin: "https://untrusted.test" }), "html")).status).toBe(404);
    expect((await exportOrderArtifact(f.env, id, request({ method: "POST" }), "html")).status).toBe(405);
    expect((await exportOrderArtifact(f.env, id, request(), "../../other/manifest.json")).status).toBe(400);
    const preflight = await exportOrderArtifact(f.env, id, request({ method: "OPTIONS", token: null, origin: "https://delta.test" }), "html");
    expect(preflight.status).toBe(204); expect(preflight.headers.get("access-control-allow-origin")).toBe("https://delta.test");
  });
  it("cancels a stalled valid manifest prefix without treating cancellation as EOF success", async () => {
    const f = await fixture(); vi.useFakeTimers(); const original = f.bucket.get.getMockImplementation()!; const cancel = vi.fn();
    f.bucket.get.mockImplementation(async key => { const object = await original(key); if (key === f.manifest.storage.manifest && object) return { ...object,
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(f.rawManifest); }, cancel }) }; return object; });
    const responsePromise = exportOrderArtifact(f.env, id, request(), "manifest");
    await vi.waitUntil(() => f.bucket.get.mock.calls.some(([key]) => key === f.manifest.storage.manifest));
    await vi.advanceTimersByTimeAsync(ORDER_EXPORT_TIMEOUT_MS + 1);
    const response = await responsePromise;
    expect(response.status).toBe(503); expect(cancel).toHaveBeenCalledTimes(1); expect(await response.text()).not.toContain("capture_started_at");
  });
  it("cancels R2 body arriving after timeout and does not keep reading", async () => {
    const f = await fixture(); vi.useFakeTimers(); const original = f.bucket.get.getMockImplementation()!; const cancel = vi.fn();
    let release: (() => void) | undefined;
    f.bucket.get.mockImplementation(async key => { const object = await original(key); if (key === f.manifest.storage.manifest && object) {
      await new Promise<void>(resolve => { release = resolve; });
      return { ...object, body: new ReadableStream<Uint8Array>({ cancel }) };
    } return object; });
    const pending = exportOrderArtifact(f.env, id, request(), "manifest");
    await vi.waitUntil(() => Boolean(release));
    await vi.advanceTimersByTimeAsync(ORDER_EXPORT_TIMEOUT_MS + 1); expect((await pending).status).toBe(503);
    expect(release).toBeTypeOf("function"); release!(); await vi.advanceTimersByTimeAsync(0); expect(cancel).toHaveBeenCalledTimes(1);
  });
});
