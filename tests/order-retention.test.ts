import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { sha256, stableJson } from "../src/crypto";
import { orderRecordKey } from "../src/orders";
import { MemoryBucket, orderRuntime, orderRequest, statusRequest, mockOrderNetwork, orderPayment, TEST_ORDER_ID, TEST_RECOVERY_TOKEN } from "./helpers/order-runtime";
// @ts-expect-error local JS SDK integration
import { DeltaWitness } from "../packages/js-client/src/index.js";

const policy = { schema: "delta-retention-policy/v1", policy_id: "isolated-test-only", classes: {
  raw_artifacts: { start_event: "settlement_confirmed", retain_seconds: 60, deletion_window_seconds: 60 },
  minimal_metadata: { start_event: "settlement_confirmed", retain_seconds: 120, deletion_window_seconds: 60 },
  transaction_audit: { start_event: "settlement_confirmed", retain_seconds: 240, deletion_window_seconds: 60 },
}, export_rights: { raw_artifacts: "authenticated_until_raw_expiry", minimal_metadata: "authenticated_until_metadata_expiry" } };
function setup() {
  const bucket = new MemoryBucket(), env = orderRuntime(bucket), network = mockOrderNetwork();
  env.RETENTION_POLICY_JSON = JSON.stringify(policy);
  vi.stubGlobal("fetch", network);
  return { bucket, env, network };
}
function exportRequest() { return new Request(`https://delta.test/v1/orders/${TEST_ORDER_ID}/artifacts/html`, { headers: { "x-delta-recovery-token": TEST_RECOVERY_TOKEN } }); }
async function acceptedRequest() { const req = orderRequest(); req.headers.set("x-delta-retention-policy-hash", await sha256(stableJson(policy))); return req; }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("order retention integration (isolated)", () => {
  it("does not manufacture a completion date when original final persistence was interrupted", async () => {
    const { env, bucket } = setup();
    const completionPolicy = structuredClone(policy);
    for (const rule of Object.values(completionPolicy.classes)) rule.start_event = "fulfillment_completed";
    env.RETENTION_POLICY_JSON = JSON.stringify(completionPolicy);
    const req = orderRequest(); req.headers.set("x-delta-retention-policy-hash", await sha256(stableJson(completionPolicy)));
    const put = bucket.put.bind(bucket); let interrupted = false;
    bucket.put = async (key, value, options) => {
      if (key.startsWith("fulfillments/") && JSON.parse(String(value)).state === "complete" && !interrupted) { interrupted = true; throw new Error("synthetic_interrupt"); }
      return put(key, value, options);
    };
    expect((await app.fetch(req, env)).status).toBe(503);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 120_000);
    const recovered = await app.fetch(statusRequest({ recover: true }), env);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ state: "complete", retention: { state: "pending_start", raw_expires_at: null, export_allowed: null } });
    const record = JSON.parse([...bucket.values.entries()].find(([key]) => key.startsWith("fulfillments/"))![1].text);
    expect(record.completed_at).toBeUndefined();
    expect((await app.fetch(exportRequest(), env)).status).toBe(503);
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });
  it("denies an export that crosses raw expiry during artifact reads", async () => {
    const { env, bucket } = setup(); expect((await app.fetch(await acceptedRequest(), env)).status).toBe(200);
    const status = await (await app.fetch(statusRequest(), env)).json() as any;
    const get = bucket.get.bind(bucket); vi.useFakeTimers({ toFake: ["Date"] });
    bucket.get = async key => { if (key.endsWith("/page.html")) vi.setSystemTime(Date.parse(status.retention.raw_expires_at)); return get(key); };
    expect((await app.fetch(exportRequest(), env)).status).toBe(410);
  });
  it("automatically buys one order with persisted disclosed terms then recovers through an independent client", async () => {
    const { env } = setup(), records = new Map();
    const store = { load: async (id: string) => structuredClone(records.get(id) ?? null),
      compareAndSet: async (id: string, revision: number | null, value: unknown) => {
        if ((records.get(id)?.revision ?? null) !== revision) return false;
        records.set(id, structuredClone(value)); return true;
      } };
    const fetchImpl = (url: string, init?: RequestInit) => app.fetch(new Request(url, init), env);
    const client = new DeltaWitness({ baseUrl: "https://delta.test", orderStore: store, fetchImpl });
    const quote = await client.quote();
    await client.prepareOrder("capture", { url: "https://example.com/" }, { orderId: TEST_ORDER_ID, retentionPolicyHash: quote.retention.policy_hash });
    let signatures = 0;
    const original = await client.executeOrder(TEST_ORDER_ID, async (url: string, init: RequestInit) => {
      signatures++;
      const headers = new Headers(init.headers); headers.set("payment-signature", Buffer.from(JSON.stringify(orderPayment())).toString("base64"));
      return fetchImpl(url, { ...init, headers });
    });
    const restarted = new DeltaWitness({ baseUrl: "https://delta.test", orderStore: store, fetchImpl });
    expect(await restarted.executeOrder(TEST_ORDER_ID, () => { signatures++; throw new Error(); })).toEqual(original);
    expect(signatures).toBe(1); expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });
  it("discloses policy and acceptance hash in quote and 402 without fulfillment", async () => {
    const { env, bucket } = setup();
    const quote = await app.fetch(new Request("https://delta.test/v1/quote"), env);
    expect(await quote.json()).toMatchObject({ retention: { policy, policy_hash: await sha256(stableJson(policy)) } });
    const challenge = await app.fetch(orderRequest({ unpaid: true }), env);
    expect(challenge.status).toBe(402);
    expect(await challenge.json()).toMatchObject({ retention: { policy } });
    expect(bucket.values.size).toBe(0); expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it.each([undefined, "sha256:" + "0".repeat(64)])("refuses unaccepted/changed terms before payment %s", async (hash) => {
    const { env, bucket, network } = setup(), req = orderRequest();
    if (hash) req.headers.set("x-delta-retention-policy-hash", hash);
    expect((await app.fetch(req, env)).status).toBe(409);
    expect(bucket.values.size).toBe(0); expect(network).not.toHaveBeenCalled();
  });
  it("snapshots purchased terms; expired raw bytes are denied while status remains queryable without deletion", async () => {
    const { env, bucket, network } = setup();
    const delivered = await app.fetch(await acceptedRequest(), env); expect(delivered.status).toBe(200);
    const originalObjects = [...bucket.values.entries()].map(([key, value]) => [key, value.text]);
    const before = await (await app.fetch(statusRequest(), env)).json() as any;
    expect(before.retention.state).toBe("allowed_by_retention");
    expect((await app.fetch(exportRequest(), env)).status).toBe(200);
    env.RETENTION_POLICY_JSON = JSON.stringify({ ...policy, policy_id: "changed-current-policy" });
    expect((await app.fetch(orderRequest(), env)).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(before.retention.raw_expires_at));
    network.mockClear(); vi.mocked(env.BROWSER.quickAction).mockClear();
    const expired = await app.fetch(statusRequest({ recover: true }), env);
    expect(expired.status).toBe(200); expect(await expired.json()).toMatchObject({ state: "raw_artifacts_expired", retention: { export_allowed: false } });
    expect((await app.fetch(exportRequest(), env)).status).toBe(410);
    expect([...bucket.values.entries()].map(([key, value]) => [key, value.text])).toEqual(originalObjects);
    expect(network).not.toHaveBeenCalled(); expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it("does not apply a newly configured policy to pre-existing unsnapshotted orders", async () => {
    const { env, bucket } = setup(); delete env.RETENTION_POLICY_JSON;
    expect((await app.fetch(orderRequest(), env)).status).toBe(200);
    env.RETENTION_POLICY_JSON = JSON.stringify(policy);
    expect(await (await app.fetch(statusRequest(), env)).json()).toMatchObject({ retention: { state: "legacy_policy_unknown", export_allowed: null } });
    expect((await app.fetch(exportRequest(), env)).status).toBe(200);
    expect(JSON.parse(bucket.values.get(orderRecordKey(TEST_ORDER_ID))!.text).retention_snapshot).toBeUndefined();
  });
  it("fails closed for altered stored terms even when their internal hash is recomputed", async () => {
    const { env, bucket } = setup(); expect((await app.fetch(await acceptedRequest(), env)).status).toBe(200);
    const key = orderRecordKey(TEST_ORDER_ID), value = bucket.values.get(key)!, order = JSON.parse(value.text);
    order.retention_snapshot.policy.classes.raw_artifacts.retain_seconds = 100;
    order.retention_snapshot.policy_hash = await sha256(stableJson(order.retention_snapshot.policy));
    const { snapshot_hash: _, ...rest } = order.retention_snapshot;
    order.retention_snapshot.snapshot_hash = await sha256(stableJson(rest));
    bucket.values.set(key, { ...value, text: JSON.stringify(order) });
    expect((await app.fetch(statusRequest(), env)).status).toBe(503);
    expect((await app.fetch(exportRequest(), env)).status).toBe(503);
  });
});
