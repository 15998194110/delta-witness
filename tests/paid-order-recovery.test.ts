import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { sha256, stableJson } from "../src/crypto";
import { runPaidOrderRecovery, validatePaidOrderRecoveryResult } from "../src/paid-order-recovery";
import { orderRecordKey } from "../src/orders";
import { MemoryBucket, mockOrderNetwork, orderRequest, orderRuntime, statusRequest, TEST_ORDER_ID, TEST_RECOVERY_TOKEN } from "./helpers/order-runtime";

class RecoveryBucket extends MemoryBucket {
  finalInterrupt = false;
  listRequests: R2ListOptions[] = [];
  successfulWrites: string[] = [];
  override async put(key: string, value: unknown, options?: R2PutOptions) {
    if (this.finalInterrupt && key.startsWith("fulfillments/") && JSON.parse(String(value)).state === "complete") {
      this.finalInterrupt = false; throw new Error("synthetic_final_write_interruption");
    }
    const saved = await super.put(key, value, options);
    if (saved) this.successfulWrites.push(key);
    return saved;
  }
  async list(options?: R2ListOptions): Promise<any> {
    this.listRequests.push(options ?? {});
    const all = [...this.values.keys()].filter(key => key.startsWith(options?.prefix ?? "")).sort();
    const offset = options?.cursor ? Number(options.cursor.replace("fixture:", "")) : 0;
    const selected = all.slice(offset, offset + (options?.limit ?? 1_000));
    const truncated = offset + selected.length < all.length;
    return { objects: selected.map(key => ({ key })), truncated, ...(truncated ? { cursor: `fixture:${offset + selected.length}` } : {}) };
  }
}

function setup() {
  const bucket = new RecoveryBucket(), env = orderRuntime(bucket), network = mockOrderNetwork();
  vi.stubGlobal("fetch", network);
  return { bucket, env, network };
}
async function purchase(state: ReturnType<typeof setup>, options: Parameters<typeof orderRequest>[0] = {}, interrupt = true) {
  state.bucket.finalInterrupt = interrupt;
  expect((await app.fetch(orderRequest(options), state.env)).status).toBe(interrupt ? 503 : 200);
  state.network.mockClear(); vi.mocked(state.env.BROWSER.quickAction).mockClear(); state.bucket.successfulWrites = [];
  return state;
}
async function draft(options: Parameters<typeof orderRequest>[0] = {}) { return purchase(setup(), options); }
function keyOf(bucket: RecoveryBucket, prefix: string) { return [...bucket.values.keys()].find(key => key.startsWith(prefix))!; }
function edit(bucket: RecoveryBucket, key: string, edits: Record<string, unknown>) {
  const stored = bucket.values.get(key)!;
  bucket.values.set(key, { ...stored, text: JSON.stringify({ ...JSON.parse(stored.text), ...edits }), etag: `edit:${++bucket.sequence}` });
}
function bytes(bucket: RecoveryBucket) {
  return [...bucket.values.entries()].map(([key, value]) => [key, value.text, value.bytes && [...value.bytes]]);
}
function noPurchaseWork(state: ReturnType<typeof setup>) {
  expect(state.network).not.toHaveBeenCalled(); expect(state.env.BROWSER.quickAction).not.toHaveBeenCalled();
}
const retention = { schema: "delta-retention-policy/v1", policy_id: "recovery-isolated-fixture", classes: {
  raw_artifacts: { start_event: "settlement_confirmed", retain_seconds: 60, deletion_window_seconds: 60 },
  minimal_metadata: { start_event: "settlement_confirmed", retain_seconds: 120, deletion_window_seconds: 60 },
  transaction_audit: { start_event: "settlement_confirmed", retain_seconds: 240, deletion_window_seconds: 60 },
}, export_rights: { raw_artifacts: "authenticated_until_raw_expiry", minimal_metadata: "authenticated_until_metadata_expiry" } };

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => undefined); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("bounded original paid-order background recovery (isolated)", () => {
  it.each(["capture", "preflight"])("completes only the original %s draft and preserves evidence and purchased facts", async product => {
    const state = await draft({ product, ...(product === "preflight" ? { body: { url: "https://example.com/", expected: { contains: ["missing promise"] } } } : {}) });
    const fulfillment = keyOf(state.bucket, "fulfillments/"), original = JSON.parse(state.bucket.values.get(fulfillment)!.text);
    const retained = bytes(state.bucket).filter(([key]) => key !== fulfillment);
    // Deliberate runtime drift fixture: generated Env literals describe today's
    // config, while this test proves the original paid terms remain authority.
    Object.assign(state.env, { CAPTURE_BASE_PRICE_USD: "9", PREFLIGHT_BASE_PRICE_USD: "19", ORDER_RECOVERY_TTL_SECONDS: "" });
    const result = await runPaidOrderRecovery(state.env);
    expect(validatePaidOrderRecoveryResult(result)).toBe(true);
    expect(result).toMatchObject({ outcome: "success", reason: "none", inventory: { complete: false, page_complete: true, truncated: false, next_cursor: null },
      counts: { selected: 1, inspected: 1, recovered: 1, requires_reconciliation: 0 }, items: [{ order_id: TEST_ORDER_ID, state: "recovered" }] });
    const recovered = JSON.parse(state.bucket.values.get(fulfillment)!.text);
    expect(recovered).toEqual({ ...original, state: "complete", updated_at: recovered.updated_at });
    expect(recovered.completed_at).toBeUndefined(); expect(recovered.attempts).toBe(original.attempts);
    expect(bytes(state.bucket).filter(([key]) => key !== fulfillment)).toEqual(retained);
    expect(state.bucket.successfulWrites).toEqual([fulfillment]);
    const status = await (await app.fetch(statusRequest(), state.env)).json() as any;
    expect(status).toMatchObject({ state: "complete", delivery: original.response, payment: { state: "settlement_confirmed", treasury_received: null } });
    if (product === "preflight") expect(status.delivery).toMatchObject({ safe: false, reason: "expectation_failed" });
    expect(JSON.stringify(result)).not.toContain(TEST_RECOVERY_TOKEN);
    noPurchaseWork(state);
  });

  it("a subsequent run observes completion without another write", async () => {
    const state = await draft(); await runPaidOrderRecovery(state.env);
    const before = bytes(state.bucket); state.bucket.successfulWrites = [];
    const result = await runPaidOrderRecovery(state.env);
    expect(result.counts).toMatchObject({ already_complete: 1, recovered: 0 });
    expect(bytes(state.bucket)).toEqual(before); expect(state.bucket.successfulWrites).toEqual([]); noPurchaseWork(state);
  });

  it("concurrent workers share the original CAS and produce one completion", async () => {
    const state = await draft(), key = keyOf(state.bucket, "fulfillments/");
    const results = await Promise.all([runPaidOrderRecovery(state.env), runPaidOrderRecovery(state.env)]);
    expect(results.reduce((sum, result) => sum + result.counts.recovered, 0)).toBe(1);
    expect(state.bucket.successfulWrites.filter(value => value === key)).toHaveLength(1);
    expect(results.every(result => ["recovered", "complete", "concurrent"].includes(result.items[0].state))).toBe(true);
    noPurchaseWork(state);
  });

  it.each(["settlement_unknown", "settlement_rejected"] as const)("never retries %s or reads proof bytes", async settlementState => {
    const state = await draft(); edit(state.bucket, keyOf(state.bucket, "settlements/"), { state: settlementState });
    const get = vi.spyOn(state.bucket, "get"), before = bytes(state.bucket);
    const result = await runPaidOrderRecovery(state.env);
    expect(result.items).toEqual([{ order_id: TEST_ORDER_ID, state: "reconciliation_required", reason: settlementState }]);
    expect(get.mock.calls.some(([key]) => /\/(page\.html|page\.md|screenshot\.png|manifest\.json)$/.test(key))).toBe(false);
    expect(bytes(state.bucket)).toEqual(before); noPurchaseWork(state);
  });

  it.each(["fulfillment_missing", "delivery_draft_missing", "retryable_failure", "blocked_failure", "corrupt_artifact", "binding_conflict", "draft_digest"])("retains %s for reconciliation without repair by replacement", async kind => {
    const state = await draft(), fulfillment = keyOf(state.bucket, "fulfillments/");
    if (kind === "fulfillment_missing") state.bucket.values.delete(fulfillment);
    if (kind === "delivery_draft_missing") edit(state.bucket, fulfillment, { response: undefined, response_hash: undefined });
    if (kind === "retryable_failure" || kind === "blocked_failure") edit(state.bucket, fulfillment, { state: kind, response: undefined, response_hash: undefined });
    if (kind === "corrupt_artifact") state.bucket.values.set([...state.bucket.values.keys()].find(key => key.endsWith("/page.html"))!, { text: "changed", etag: "corrupt" });
    if (kind === "binding_conflict") edit(state.bucket, orderRecordKey(TEST_ORDER_ID), { amount: "2" });
    if (kind === "draft_digest") edit(state.bucket, fulfillment, { response_hash: undefined });
    const before = bytes(state.bucket), result = await runPaidOrderRecovery(state.env);
    expect(result.outcome).toBe("degraded"); expect(result.counts.requires_reconciliation).toBe(1);
    expect(result.items[0].state).toBe("reconciliation_required");
    expect(bytes(state.bucket)).toEqual(before); expect(state.bucket.successfulWrites).toEqual([]); noPurchaseWork(state);
  });

  it("skips revoked indexes without recovering or reading proof bytes", async () => {
    const state = await draft(); edit(state.bucket, orderRecordKey(TEST_ORDER_ID), { revoked_at: new Date().toISOString() });
    const get = vi.spyOn(state.bucket, "get"), before = bytes(state.bucket), result = await runPaidOrderRecovery(state.env);
    expect(result.items[0]).toMatchObject({ state: "skipped", reason: "order_revoked" });
    expect(get.mock.calls.some(([key]) => key.endsWith("/manifest.json"))).toBe(false);
    expect(bytes(state.bucket)).toEqual(before); noPurchaseWork(state);
  });

  it("never reads or changes raw artifacts after the original purchased expiry", async () => {
    const state = setup(); state.env.RETENTION_POLICY_JSON = JSON.stringify(retention); state.bucket.finalInterrupt = true;
    const request = orderRequest(); request.headers.set("x-delta-retention-policy-hash", await sha256(stableJson(retention)));
    expect((await app.fetch(request, state.env)).status).toBe(503);
    const settlement = JSON.parse(state.bucket.values.get(keyOf(state.bucket, "settlements/"))!.text);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(settlement.confirmed_at) + 60_000);
    state.network.mockClear(); vi.mocked(state.env.BROWSER.quickAction).mockClear(); state.bucket.successfulWrites = [];
    const get = vi.spyOn(state.bucket, "get"), before = bytes(state.bucket), result = await runPaidOrderRecovery(state.env);
    expect(result.items[0]).toMatchObject({ state: "skipped", reason: "raw_artifacts_expired" });
    expect(get.mock.calls.some(([key]) => /\/(page\.html|page\.md|screenshot\.png|manifest\.json)$/.test(key))).toBe(false);
    expect(bytes(state.bucket)).toEqual(before); expect(state.bucket.successfulWrites).toEqual([]); noPurchaseWork(state);
  });

  it("does not turn credential expiry into a new credential or a new paid request", async () => {
    const state = await draft(), original = JSON.parse(state.bucket.values.get(orderRecordKey(TEST_ORDER_ID))!.text);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(original.expires_at) + 1);
    expect((await runPaidOrderRecovery(state.env)).counts.recovered).toBe(1);
    expect(JSON.parse(state.bucket.values.get(orderRecordKey(TEST_ORDER_ID))!.text)).toEqual(original);
    expect((await app.fetch(statusRequest(), state.env)).status).toBe(410); noPurchaseWork(state);
  });

  it("reads back an unknown completion on the next pass without repeating its write", async () => {
    const state = await draft(), put = state.bucket.put.bind(state.bucket), key = keyOf(state.bucket, "fulfillments/");
    let once = true;
    state.bucket.put = async (target, value, options) => {
      const saved = await put(target, value, options);
      if (once && target === key && JSON.parse(String(value)).state === "complete") { once = false; throw new Error("synthetic_lost_ack"); }
      return saved;
    };
    const first = await runPaidOrderRecovery(state.env);
    expect(first.items[0]).toMatchObject({ state: "write_unconfirmed", reason: "original_write_unconfirmed" });
    const after = bytes(state.bucket), count = state.bucket.successfulWrites.length;
    expect((await runPaidOrderRecovery(state.env)).counts.already_complete).toBe(1);
    expect(bytes(state.bucket)).toEqual(after); expect(state.bucket.successfulWrites).toHaveLength(count); noPurchaseWork(state);
  });

  it("retains the original claim on a CAS conflict and never retries the write", async () => {
    const state = await draft(), key = keyOf(state.bucket, "fulfillments/"), put = state.bucket.put.bind(state.bucket);
    const calls = vi.fn(async (target: string, value: unknown, options?: R2PutOptions) => target === key ? null : put(target, value, options));
    state.bucket.put = calls; const before = bytes(state.bucket);
    expect((await runPaidOrderRecovery(state.env)).items[0]).toMatchObject({ state: "concurrent", reason: "original_cas_conflict" });
    expect(calls).toHaveBeenCalledTimes(1); expect(bytes(state.bucket)).toEqual(before); noPurchaseWork(state);
  });

  it("detects a changed original binding immediately before completion and keeps the old claim", async () => {
    const state = await draft(), orderKey = orderRecordKey(TEST_ORDER_ID), fulfillment = keyOf(state.bucket, "fulfillments/");
    const get = state.bucket.get.bind(state.bucket); let changed = false;
    state.bucket.get = async key => {
      if (!changed && key.endsWith("/page.html")) { changed = true; edit(state.bucket, orderKey, { revoked_at: new Date().toISOString() }); }
      return get(key);
    };
    const original = state.bucket.values.get(fulfillment)!.text, result = await runPaidOrderRecovery(state.env);
    expect(result.items[0]).toMatchObject({ state: "reconciliation_required", reason: "order_changed" });
    expect(state.bucket.values.get(fulfillment)!.text).toBe(original); expect(state.bucket.successfulWrites).toEqual([]); noPurchaseWork(state);
  });

  it("uses the returned opaque continuation for one bounded page and never claims historical completeness", async () => {
    const state = setup();
    for (let index = 0; index < 3; index++) await purchase(state, { orderId: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`, nonce: `0x${String(index + 1).padStart(64, "0")}` });
    const first = await runPaidOrderRecovery(state.env, { maxOrders: 2 });
    expect(first).toMatchObject({ counts: { selected: 2, recovered: 2 }, inventory: { complete: false, page_complete: true, truncated: true, next_cursor: "fixture:2" } });
    const next = await runPaidOrderRecovery(state.env, { maxOrders: 2, cursor: first.inventory.next_cursor! });
    expect(next).toMatchObject({ counts: { selected: 1, recovered: 1 }, inventory: { complete: false, page_complete: true, truncated: false, next_cursor: null } });
    expect(state.bucket.listRequests).toEqual([{ prefix: "orders/", limit: 2 }, { prefix: "orders/", limit: 2, cursor: "fixture:2" }]); noPurchaseWork(state);
  });

  it.each([
    { objects: [{ key: "watches/not-an-order.json" }], truncated: false },
    { objects: [{ key: orderRecordKey(TEST_ORDER_ID) }, { key: orderRecordKey(TEST_ORDER_ID) }], truncated: false },
    { objects: [], truncated: true }, { objects: [], truncated: true, cursor: "same" },
    { objects: [], truncated: false, cursor: "unexpected" }, { objects: [], truncated: false, delimitedPrefixes: ["orders/hidden/"] },
  ])("rejects malformed inventory without reads or cursor advancement (%j)", async page => {
    const state = setup(); state.bucket.list = vi.fn(async () => page);
    const get = vi.spyOn(state.bucket, "get"), result = await runPaidOrderRecovery(state.env, { cursor: "same" });
    expect(result).toMatchObject({ outcome: "degraded", reason: "inventory_invalid", inventory: { page_complete: false, input_cursor: "same", next_cursor: "same" } });
    expect(get).not.toHaveBeenCalled(); expect(state.bucket.successfulWrites).toEqual([]); noPurchaseWork(state);
  });

  it("a single corrupted order is isolated while another verified draft completes", async () => {
    const state = setup(); await purchase(state); const second = "22222222-2222-4222-8222-222222222222";
    await purchase(state, { orderId: second, nonce: "0x" + "ef".repeat(32) }); edit(state.bucket, orderRecordKey(TEST_ORDER_ID), { amount: "2" });
    const result = await runPaidOrderRecovery(state.env);
    expect(result).toMatchObject({ outcome: "degraded", inventory: { page_complete: true }, counts: { selected: 2, recovered: 1, requires_reconciliation: 1 } });
    expect(result.items.find(item => item.order_id === second)?.state).toBe("recovered"); noPurchaseWork(state);
  });

  it("keeps the input cursor on total deadline; late inventory cannot begin a completion", async () => {
    const state = await draft(), before = bytes(state.bucket);
    let release: ((value: unknown) => void) | undefined;
    state.bucket.list = () => new Promise(resolve => { release = resolve; });
    vi.useFakeTimers(); const pending = runPaidOrderRecovery(state.env, { cursor: "fixture:0", deadlineMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result).toMatchObject({ outcome: "degraded", reason: "run_deadline", inventory: { page_complete: false, next_cursor: "fixture:0" } });
    expect(validatePaidOrderRecoveryResult(result)).toBe(true);
    release?.({ objects: [{ key: orderRecordKey(TEST_ORDER_ID) }], truncated: false }); await vi.advanceTimersByTimeAsync(0);
    expect(bytes(state.bucket)).toEqual(before); expect(state.bucket.successfulWrites).toEqual([]); noPurchaseWork(state);
  });

  it("a stalled first order times out locally while the next original draft completes; its late read cannot write", async () => {
    const state = setup(); await purchase(state); const second = "22222222-2222-4222-8222-222222222222";
    await purchase(state, { orderId: second, nonce: "0x" + "ef".repeat(32) });
    const firstOrder = JSON.parse(state.bucket.values.get(orderRecordKey(TEST_ORDER_ID))!.text);
    const firstFulfillment = `fulfillments/${firstOrder.payment_fingerprint.slice(7)}.json`;
    const original = state.bucket.values.get(firstFulfillment)!.text;
    let release: (() => void) | undefined, started: (() => void) | undefined;
    const stalled = new Promise<void>(resolve => { started = resolve; });
    const get = state.bucket.get.bind(state.bucket), firstProof = JSON.parse(state.bucket.values.get(firstFulfillment)!.text).response.proof_id;
    state.bucket.get = async key => {
      if (key === `${firstProof}/page.html`) { started?.(); await new Promise<void>(resolve => { release = resolve; }); }
      return get(key);
    };
    vi.useFakeTimers(); const pending = runPaidOrderRecovery(state.env, { maxOrders: 2, deadlineMs: 3_000 });
    await stalled; await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result).toMatchObject({ outcome: "degraded", reason: "orders_require_reconciliation", inventory: { page_complete: true, next_cursor: null },
      counts: { inspected: 2, recovered: 1, requires_reconciliation: 1 } });
    expect(result.items).toEqual([{ order_id: TEST_ORDER_ID, state: "reconciliation_required", reason: "evidence_unavailable" },
      { order_id: second, state: "recovered", reason: "original_delivery_recovered" }]);
    expect(validatePaidOrderRecoveryResult(result)).toBe(true);
    release?.(); await vi.advanceTimersByTimeAsync(0);
    expect(state.bucket.values.get(firstFulfillment)!.text).toBe(original);
    expect(state.bucket.successfulWrites).toHaveLength(1); expect(state.bucket.successfulWrites).not.toContain(firstFulfillment); noPurchaseWork(state);
  });

  it("caller cancellation terminates a hung inventory immediately and late inventory performs no reads", async () => {
    const state = setup(), controller = new AbortController(); let release: ((value: unknown) => void) | undefined;
    state.bucket.list = () => new Promise(resolve => { release = resolve; });
    const get = vi.spyOn(state.bucket, "get"), pending = runPaidOrderRecovery(state.env, { signal: controller.signal, cursor: "start" });
    controller.abort(); const result = await pending;
    expect(result).toMatchObject({ outcome: "degraded", reason: "cancelled", inventory: { page_complete: false, next_cursor: "start" } });
    release?.({ objects: [{ key: orderRecordKey(TEST_ORDER_ID) }], truncated: false }); await Promise.resolve(); await Promise.resolve();
    expect(get).not.toHaveBeenCalled(); noPurchaseWork(state);
  });

  it("inventory transport failure does not clear a cursor or treat orders as absent", async () => {
    const state = setup(); state.bucket.list = async () => { throw new Error("provider_text_must_not_escape"); };
    const result = await runPaidOrderRecovery(state.env, { cursor: "retained" });
    expect(result).toMatchObject({ reason: "inventory_unavailable", inventory: { page_complete: false, next_cursor: "retained" }, counts: { inspected: 0 } });
    expect(JSON.stringify(result)).not.toContain("provider_text_must_not_escape"); noPurchaseWork(state);
    expect(validatePaidOrderRecoveryResult(result)).toBe(true);
  });

  it("legacy unscoped orders remain outside this capability inventory and unchanged", async () => {
    const state = await purchase(setup(), { legacy: true }, false), before = bytes(state.bucket);
    const result = await runPaidOrderRecovery(state.env);
    expect(result).toMatchObject({ outcome: "success", inventory: { complete: false, page_complete: true }, counts: { selected: 0, inspected: 0 } });
    expect(bytes(state.bucket)).toEqual(before); noPurchaseWork(state);
  });

  it.each([{ maxOrders: 0 }, { maxOrders: 11 }, { deadlineMs: 0 }, { deadlineMs: 120_001 }, { cursor: "" }, { cursor: "bad\nvalue" }])("validates explicit bounds before provider access (%j)", async options => {
    const state = setup();
    await expect(runPaidOrderRecovery(state.env, options)).rejects.toThrow("invalid_paid_order_recovery_options");
    expect(state.bucket.listRequests).toEqual([]); noPurchaseWork(state);
  });

  it.each(["root-extra", "inventory-extra", "counts-extra", "item-extra", "count-mismatch", "selected-bound", "duplicate-id", "reason-state", "cursor-advance", "timestamp", "outcome", "historical-claim"])("rejects corrupted stored readback (%s)", async corruption => {
    const state = await draft(), result = await runPaidOrderRecovery(state.env), invalid = structuredClone(result) as any;
    if (corruption === "root-extra") invalid.provider_secret = "must not pass through";
    if (corruption === "inventory-extra") invalid.inventory.hidden = "must not pass through";
    if (corruption === "counts-extra") invalid.counts.customer_revenue = 0;
    if (corruption === "item-extra") invalid.items[0].request_url = "must not pass through";
    if (corruption === "count-mismatch") invalid.counts.recovered = 0;
    if (corruption === "selected-bound") invalid.counts.selected = 11;
    if (corruption === "duplicate-id") { invalid.items.push(invalid.items[0]); invalid.counts.selected++; invalid.counts.inspected++; invalid.counts.recovered++; }
    if (corruption === "reason-state") invalid.items[0].reason = "settlement_unknown";
    if (corruption === "cursor-advance") { invalid.inventory.page_complete = false; invalid.inventory.next_cursor = "unsafe-next"; invalid.outcome = "degraded"; invalid.reason = "run_deadline"; }
    if (corruption === "timestamp") invalid.completed_at = "2020-01-01T00:00:00.000Z";
    if (corruption === "outcome") invalid.outcome = "degraded";
    if (corruption === "historical-claim") invalid.inventory.complete = true;
    expect(validatePaidOrderRecoveryResult(result)).toBe(true); expect(validatePaidOrderRecoveryResult(invalid)).toBe(false); noPurchaseWork(state);
  });
});
