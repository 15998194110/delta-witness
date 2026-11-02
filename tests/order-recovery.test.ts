import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { orderRecordKey, readOrderBinding } from "../src/orders";
import { MemoryBucket, orderRuntime, orderRequest, statusRequest, mockOrderNetwork, TEST_ORDER_ID, TEST_RECOVERY_TOKEN } from "./helpers/order-runtime";

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => undefined));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const otherId = "22222222-2222-4222-8222-222222222222";
const otherToken = Buffer.alloc(32, 34).toString("base64url");
function setup() {
  const bucket = new MemoryBucket(), env = orderRuntime(bucket), network = mockOrderNetwork();
  vi.stubGlobal("fetch", network);
  return { bucket, env, network };
}
async function complete(options: Parameters<typeof orderRequest>[0] = {}) {
  const state = setup();
  const response = await app.fetch(orderRequest(options), state.env);
  expect(response.status).toBe(200);
  return { ...state, delivery: await response.json() as Record<string, unknown> };
}
function writeRecord(bucket: MemoryBucket, key: string, edits: Record<string, unknown>) {
  const current = bucket.values.get(key)!;
  bucket.values.set(key, { ...current, text: JSON.stringify({ ...JSON.parse(current.text), ...edits }) });
}

describe("scoped order identity and recovery (offline)", () => {
  it('stops new enrollment without invalidating original credentials, expiry, paid replay or proof bytes', async () => {
    const { bucket, env, network, delivery } = await complete();
    const before = new Map([...bucket.values].map(([key, value]) => [key, { text: value.text, bytes: value.bytes?.slice() }]));
    env.ORDER_RECOVERY_TTL_SECONDS = ''; network.mockClear(); vi.mocked(env.BROWSER.quickAction).mockClear();
    const quote = await (await app.fetch(new Request('https://delta.test/v1/quote'), env)).json() as any;
    expect(quote.order_recovery).toMatchObject({ enabled: false, credential_ttl_seconds: null });
    expect((await app.fetch(orderRequest({ orderId: otherId, token: otherToken, unpaid: true }), env)).status).toBe(503);
    expect((await app.fetch(orderRequest(), env)).status).toBe(200);
    const status = await (await app.fetch(statusRequest(), env)).json() as any;
    expect(status.delivery).toMatchObject(delivery); expect(status.state).toBe('complete');
    expect(network).not.toHaveBeenCalled(); expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
    expect(new Map([...bucket.values].map(([key, value]) => [key, { text: value.text, bytes: value.bytes?.slice() }]))).toEqual(before);
  });
  it("persists only token digest and authenticates a reloaded client without payment or browser work", async () => {
    const { bucket, env, network, delivery } = await complete();
    const record = await readOrderBinding(env, TEST_ORDER_ID);
    expect(record).toMatchObject({ scope: ["status", "recover", "export"], amount: "1000000" });
    expect(JSON.stringify([...bucket.values.values()])).not.toContain(TEST_RECOVERY_TOKEN);
    expect(JSON.stringify([...bucket.values.values()])).not.toContain('"signature"');
    network.mockClear(); vi.mocked(env.BROWSER.quickAction).mockClear();
    const result = await app.fetch(statusRequest(), env);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ order_id: TEST_ORDER_ID, state: "complete", payment: { state: "settlement_confirmed", treasury_received: null }, delivery });
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(result.headers.get("access-control-allow-origin")).toBeNull();
    expect(network).not.toHaveBeenCalled(); expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });

  it.each(["pair", "id", "token", "ttl", "ttl-low", "ttl-high", "pilot"])("rejects unsupported unsigned credentials (%s) before402 and side effects", async (kind) => {
    const { bucket, env, network } = setup();
    const request = orderRequest({ unpaid: true, product: kind === "pilot" ? "guarded-action-pilot" : "capture" });
    if (kind === "pair") request.headers.delete("x-delta-order-id");
    if (kind === "id") request.headers.set("x-delta-order-id", "invalid");
    if (kind === "token") request.headers.set("x-delta-recovery-token", "short");
    if (kind === "ttl") env.ORDER_RECOVERY_TTL_SECONDS = "";
    if (kind === "ttl-low") env.ORDER_RECOVERY_TTL_SECONDS = "59";
    if (kind === "ttl-high") env.ORDER_RECOVERY_TTL_SECONDS = "604801";
    const result = await app.fetch(request, env);
    expect([400, 503]).toContain(result.status);
    expect(network).not.toHaveBeenCalled(); expect(bucket.values.size).toBe(0); expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });

  it("valid unsigned probes challenge without minting order records", async () => {
    const { bucket, env } = setup();
    expect((await app.fetch(orderRequest({ unpaid: true }), env)).status).toBe(402);
    expect(bucket.values.size).toBe(0); expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });

  it("failed verification does not create an order or settlement", async () => {
    const { bucket, env } = setup();
    const settle = vi.fn(); vi.stubGlobal("fetch", mockOrderNetwork(settle, false));
    expect((await app.fetch(orderRequest(), env)).status).toBe(402);
    expect(bucket.values.size).toBe(0); expect(settle).not.toHaveBeenCalled();
  });

  it.each(["nonce", "body", "token"])("same order cannot change original %s or charge again", async (kind) => {
    const { bucket, env, network } = await complete();
    const before = bucket.values.get(orderRecordKey(TEST_ORDER_ID))!.text;
    network.mockClear();
    const result = await app.fetch(orderRequest(kind === "nonce" ? { nonce: "0x" + "ef".repeat(32) } : kind === "body" ? { body: { url: "https://example.com/changed" } } : { token: otherToken }), env);
    expect(result.status).toBe(kind === "token" ? 404 : 409);
    expect(bucket.values.get(orderRecordKey(TEST_ORDER_ID))!.text).toBe(before);
    expect(network).not.toHaveBeenCalled();
  });

  it("a public completed signature cannot enroll a second capability", async () => {
    const { bucket, env, network } = await complete(); network.mockClear();
    expect((await app.fetch(orderRequest({ orderId: otherId, token: otherToken }), env)).status).toBe(409);
    expect((await app.fetch(statusRequest({ id: otherId, token: otherToken }), env)).status).toBe(404);
    expect(bucket.values.has(orderRecordKey(otherId))).toBe(false); expect(network).not.toHaveBeenCalled();
  });

  it.each(["complete", "settlement"])("legacy %s cannot mint a capability", async (stage) => {
    const { bucket, env, network } = await complete({ legacy: true });
    if (stage === "settlement") for (const key of bucket.values.keys()) if (key.startsWith("fulfillments/")) bucket.values.delete(key);
    network.mockClear();
    expect((await app.fetch(orderRequest(), env)).status).toBe(409);
    expect(bucket.values.has(orderRecordKey(TEST_ORDER_ID))).toBe(false); expect(network).not.toHaveBeenCalled();
  });

  it("concurrent aliases for the same authorization never inherit another order's entitlement", async () => {
    const { bucket, env, network } = setup();
    const responses = await Promise.all([app.fetch(orderRequest(), env), app.fetch(orderRequest({ orderId: otherId, token: otherToken }), env)]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    const journal = JSON.parse([...bucket.values.entries()].find(([key]) => key.startsWith("settlements/"))![1].text);
    const winner = journal.order_id, loser = winner === TEST_ORDER_ID ? otherId : TEST_ORDER_ID;
    expect((await app.fetch(statusRequest({ id: winner, token: winner === TEST_ORDER_ID ? TEST_RECOVERY_TOKEN : otherToken }), env)).status).toBe(200);
    expect((await app.fetch(statusRequest({ id: loser, token: loser === TEST_ORDER_ID ? TEST_RECOVERY_TOKEN : otherToken }), env)).status).toBe(404);
    expect(network.mock.calls.filter(([url]) => String(url).endsWith("/settle"))).toHaveLength(1);
  });

  it("same order with concurrent distinct authorization can settle only once", async () => {
    const { bucket, env, network } = setup();
    const responses = await Promise.all([app.fetch(orderRequest(), env), app.fetch(orderRequest({ nonce: "0x" + "ef".repeat(32) }), env)]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(network.mock.calls.filter(([url]) => String(url).endsWith("/settle"))).toHaveLength(1);
    expect((await app.fetch(statusRequest(), env)).status).toBe(200);
    expect([...bucket.values.keys()].filter((key) => key.startsWith("orders/"))).toHaveLength(1);
  });

  it.each(["capture", "preflight"])("recovers the original %s draft after interruption without another observation", async (product) => {
    const { bucket, env, network, delivery } = await complete({ product, body: product === "preflight" ? { url: "https://example.com/", expected: { contains: ["missing promise"] } } : undefined });
    const key = [...bucket.values.keys()].find((key) => key.startsWith("fulfillments/"))!;
    writeRecord(bucket, key, { state: "processing" });
    network.mockClear(); vi.mocked(env.BROWSER.quickAction).mockClear();
    const status = await app.fetch(statusRequest(), env);
    expect(status.status).toBe(202); expect(await status.json()).toMatchObject({ state: "recovery_available", recovery: { can_recover: true } });
    const recovered = await app.fetch(statusRequest({ recover: true }), env);
    expect(recovered.status).toBe(200); expect(await recovered.json()).toMatchObject({ delivery });
    if (product === "preflight") expect(delivery).toMatchObject({ safe: false, reason: "expectation_failed" });
    expect(network).not.toHaveBeenCalled(); expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });

  it("recovers after an actual final-write rejection and response loss without another settlement", async () => {
    const { bucket, env, network } = setup();
    const put = bucket.put.bind(bucket); let interrupted = false;
    bucket.put = async (key, value, options) => {
      if (!interrupted && key.startsWith("fulfillments/") && JSON.parse(String(value)).state === "complete") {
        interrupted = true; throw new Error("synthetic final-write connection loss");
      }
      return put(key, value, options);
    };
    expect((await app.fetch(orderRequest(), env)).status).toBe(503);
    const record = JSON.parse([...bucket.values.entries()].find(([key]) => key.startsWith("fulfillments/"))![1].text);
    expect(record.state).toBe("processing"); expect(record.response.ok).toBe(true);
    const rawArtifacts = [...bucket.values.entries()].filter(([key]) => /\/(page\.html|page\.md|screenshot\.png|manifest\.json)$/.test(key));
    network.mockClear(); vi.mocked(env.BROWSER.quickAction).mockClear();
    const result = await app.fetch(statusRequest({ recover: true }), env);
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ delivery: record.response });
    expect([...bucket.values.entries()].filter(([key]) => /\/(page\.html|page\.md|screenshot\.png|manifest\.json)$/.test(key))).toEqual(rawArtifacts);
    expect(network).not.toHaveBeenCalled(); expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });

  it("keeps fixed capability expiry and old paid price across ordinary signed replay", async () => {
    const { bucket, env, network, delivery } = await complete();
    const before = bucket.values.get(orderRecordKey(TEST_ORDER_ID))!.text;
    Object.assign(env, { CAPTURE_BASE_PRICE_USD: "9", ORDER_RECOVERY_TTL_SECONDS: "604800" }); network.mockClear();
    const result = await app.fetch(orderRequest(), env);
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ ...delivery, idempotent_replay: true });
    expect(bucket.values.get(orderRecordKey(TEST_ORDER_ID))!.text).toBe(before); expect(network).not.toHaveBeenCalled();
  });

  it.each(["created_at", "expires_at"] as const)("journal authority rejects modification of the original capability %s", async (field) => {
    const { bucket, env, network } = await complete();
    const orderKey = orderRecordKey(TEST_ORDER_ID), binding = await readOrderBinding(env, TEST_ORDER_ID);
    const journalKey = [...bucket.values.keys()].find((key) => key.startsWith("settlements/"))!;
    const journalBefore = bucket.values.get(journalKey)!.text;
    const replacement = new Date(Date.parse(binding![field]) + 1000).toISOString();
    writeRecord(bucket, orderKey, { [field]: replacement }); network.mockClear();
    expect((await app.fetch(statusRequest(), env)).status).toBe(503);
    expect((await app.fetch(statusRequest({ recover: true }), env)).status).toBe(503);
    expect((await app.fetch(orderRequest(), env)).status).toBe(503);
    expect(bucket.values.get(journalKey)!.text).toBe(journalBefore);
    expect(network).not.toHaveBeenCalled();
  });

  it("extending a previously expired index cannot resurrect access against original journal authority", async () => {
    const { bucket, env, network } = await complete();
    const binding = await readOrderBinding(env, TEST_ORDER_ID);
    vi.useFakeTimers(); vi.setSystemTime(Date.parse(binding!.expires_at) + 1);
    writeRecord(bucket, orderRecordKey(TEST_ORDER_ID), { expires_at: new Date(Date.now() + 86_400_000).toISOString() }); network.mockClear();
    expect((await app.fetch(statusRequest(), env)).status).toBe(503);
    expect((await app.fetch(statusRequest({ token: otherToken }), env)).status).toBe(404);
    expect(network).not.toHaveBeenCalled();
  });

  it.each(["missing", "corrupt", "journal-owner", "binding"])("fails closed on %s evidence without recapture", async (kind) => {
    const { bucket, env, network } = await complete();
    const artifact = [...bucket.values.keys()].find((key) => key.endsWith("page.html"))!;
    if (kind === "missing") bucket.values.delete(artifact);
    if (kind === "corrupt") bucket.values.set(artifact, { text: "changed", etag: "changed" });
    if (kind === "journal-owner") writeRecord(bucket, [...bucket.values.keys()].find((key) => key.startsWith("settlements/"))!, { order_id: otherId });
    if (kind === "binding") writeRecord(bucket, orderRecordKey(TEST_ORDER_ID), { payer: "0x" + "22".repeat(20) });
    network.mockClear();
    expect((await app.fetch(statusRequest({ recover: true }), env)).status).toBe(503);
    expect(network).not.toHaveBeenCalled();
  });

  it("wrong, revoked and unknown credentials are uniform404; only correct expired capability gets410", async () => {
    const { bucket, env } = await complete();
    const binding = await readOrderBinding(env, TEST_ORDER_ID);
    vi.useFakeTimers(); vi.setSystemTime(Date.parse(binding!.expires_at) + 1);
    expect((await app.fetch(statusRequest({ token: otherToken }), env)).status).toBe(404);
    expect((await app.fetch(statusRequest(), env)).status).toBe(410);
    writeRecord(bucket, orderRecordKey(TEST_ORDER_ID), { revoked_at: new Date().toISOString() });
    expect((await app.fetch(statusRequest(), env)).status).toBe(404);
    const missing = await app.fetch(statusRequest({ id: otherId }), env);
    expect(missing.status).toBe(404); expect(await missing.json()).toEqual({ ok: false, state: "order_unknown", error: "order_unavailable" });
  });

  it("unknown settlement status never says unpaid or authorizes a second charge", async () => {
    const { env } = setup(); const settle = vi.fn(async () => { throw new Error("lost connection"); });
    vi.stubGlobal("fetch", mockOrderNetwork(settle));
    expect((await app.fetch(orderRequest(), env)).status).toBe(503);
    const status = await app.fetch(statusRequest({ recover: true }), env);
    expect(status.status).toBe(202); expect(await status.json()).toMatchObject({ state: "settlement_unknown", payment: { state: "settlement_unknown", treasury_received: null }, fulfillment: { state: "not_started" }, reconciliation_required: true });
    expect(settle).toHaveBeenCalledTimes(1); expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });

  it("binding write failure after journal reservation never proceeds to settlement or silently retries", async () => {
    const { bucket, env, network } = setup(); const put = bucket.put.bind(bucket);
    bucket.put = async (key, value, options) => { if (key.startsWith("orders/")) throw new Error("order store unavailable"); return put(key, value, options); };
    expect((await app.fetch(orderRequest(), env)).status).toBe(503);
    expect((await app.fetch(orderRequest(), env)).status).toBe(409);
    expect((await app.fetch(statusRequest(), env)).status).toBe(404);
    expect(network.mock.calls.filter(([url]) => String(url).endsWith("/settle"))).toHaveLength(0);
  });

  it("query credentials and foreign origins cannot read orders; trusted origin gets exact CORS", async () => {
    const { env, network } = await complete(); network.mockClear();
    const foreign = await app.fetch(statusRequest({ origin: "https://other.test" }), env);
    expect(foreign.status).toBe(404); expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    expect((await app.fetch(statusRequest({ query: `?token=${TEST_RECOVERY_TOKEN}` }), env)).status).toBe(404);
    const trusted = await app.fetch(statusRequest({ origin: "https://delta-witness-app.pages.dev" }), env);
    expect(trusted.status).toBe(200); expect(trusted.headers.get("access-control-allow-origin")).toBe("https://delta-witness-app.pages.dev");
    expect(network).not.toHaveBeenCalled();
  });

  it("trusted browser preflight permits the ordinary SDK channel header without permitting payment", async () => {
    const { env, network } = setup();
    const response = await app.fetch(new Request(`https://delta.test/v1/orders/${TEST_ORDER_ID}/recover`, {
      method: "OPTIONS", headers: { origin: "https://delta-witness-app.pages.dev", "access-control-request-method": "POST", "access-control-request-headers": "x-delta-recovery-token,x-delta-channel" },
    }), env);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://delta-witness-app.pages.dev");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-delta-channel");
    expect(response.headers.get("access-control-allow-headers")).not.toContain("payment-signature");
    expect(network).not.toHaveBeenCalled();
  });

  it("revocation during artifact reading prevents delivery disclosure and recovery writes", async () => {
    const { bucket, env } = await complete();
    const fulfillment = [...bucket.values.keys()].find((key) => key.startsWith("fulfillments/"))!;
    writeRecord(bucket, fulfillment, { state: "processing" });
    const get = bucket.get.bind(bucket); let revoked = false;
    bucket.get = async (key) => {
      if (!revoked && key.endsWith("manifest.json")) { revoked = true; writeRecord(bucket, orderRecordKey(TEST_ORDER_ID), { revoked_at: new Date().toISOString() }); }
      return get(key);
    };
    const response = await app.fetch(statusRequest({ recover: true }), env);
    expect(response.status).toBe(404); expect(await response.text()).not.toContain("proof_id");
    expect(JSON.parse(bucket.values.get(fulfillment)!.text).state).toBe("processing");
  });

  it("recover refuses payment credentials and body inputs", async () => {
    const { env, network } = await complete(); network.mockClear();
    const paid = statusRequest({ recover: true }); paid.headers.set("payment-signature", "not-accepted");
    expect((await app.fetch(paid, env)).status).toBe(400);
    const body = new Request(statusRequest({ recover: true }), { body: "{}" });
    expect((await app.fetch(body, env)).status).toBe(400); expect(network).not.toHaveBeenCalled();
  });

  it("bounds hanging status storage reads to a controlled503", async () => {
    const { env, bucket } = setup(); vi.useFakeTimers();
    bucket.get = async () => new Promise(() => undefined);
    const pending = app.fetch(statusRequest(), env);
    await vi.advanceTimersByTimeAsync(15_001);
    const result = await pending;
    expect(result.status).toBe(503); expect(await result.json()).toMatchObject({ error: "order_evidence_unavailable" });
  });
});
