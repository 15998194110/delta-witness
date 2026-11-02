import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveOrderAccounting, readCoreAccountingEvidence, readPrepaidWatchAccounting, type AuditAttestation } from "../src/accounting";
import { MemoryBucket, orderRuntime, orderRequest, mockOrderNetwork, TEST_ORDER_ID, TEST_PAYER } from "./helpers/order-runtime";
import { app } from "../src/index";
import { recordEvent } from "../src/telemetry";
import { estimateVariableCost } from "../src/pricing";
// @ts-ignore shared canonical receipt module
import { normalizeLogs, NETWORK, USDC, TREASURY, TRANSFER_TOPIC, TO_TOPIC } from "../scripts/treasury-reconciliation.mjs";

const asOf = "2026-11-02T00:00:00.000Z", tx = `0x${"12".repeat(32)}`, hash = `0x${"ab".repeat(32)}`;
function checkpoint() {
  const logs = normalizeLogs([{ removed: false, address: USDC, transactionHash: tx, blockHash: hash, blockNumber: "0x64", logIndex: "0x0",
    topics: [TRANSFER_TOPIC, `0x${TEST_PAYER.slice(2).padStart(64, "0")}`, TO_TOPIC], data: `0x${(1000000n).toString(16).padStart(64, "0")}` }], 90, 110);
  return { schema: "delta-treasury-checkpoint/v1", network: NETWORK, asset: USDC, treasury: TREASURY, origin_block: 90, checked_through_block: 110,
    confirmation_depth: 1, checked_at: asOf, checked_through_hash: hash, reorg_anchor: { number: 100, hash }, corrections: [], transfers: logs };
}
const audit = (): AuditAttestation => ({ order_id: TEST_ORDER_ID, buyer: "independent_customer", evidence_ref: "synthetic-purpose-1",
  refunds: { coverage: "complete", raw_amount: "0", evidence_ref: "synthetic-refund-audit-1" } });
async function fixture() {
  vi.setSystemTime(new Date(asOf));
  const bucket = new MemoryBucket(), env = orderRuntime(bucket), network = mockOrderNetwork();
  vi.stubGlobal("fetch", network);
  expect((await app.fetch(orderRequest(), env)).status).toBe(200);
  const order = await readCoreAccountingEvidence(env, TEST_ORDER_ID);
  expect(order).toMatchObject({ state: "verified", delivered: "confirmed", settlement_confirmed: "confirmed" });
  const input = { as_of: asOf, orders: [order], treasury_checkpoint: checkpoint(), attestations: [audit()] };
  return { bucket, env, network, order, input };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("derived original-order accounting, synthetic sources only", () => {
  it("links same order through original settlement, proof and unique canonical receipt; unknown invoices cannot imply profit", async () => {
    const f = await fixture(), sequence = f.bucket.sequence, calls = f.network.mock.calls.length;
    const result = await deriveOrderAccounting(f.input);
    expect(result.rows[0]).toMatchObject({ treasury_received_raw: "1000000", recognized_customer_revenue_raw: "1000000", actual_contribution_margin_raw: null, counted_customer_transactions: 1 });
    expect(result.rows[0].proof_id).toBe(f.order.proof_id); expect(result.rows[0].service_fee_tx).toBe(tx);
    expect(f.bucket.sequence).toBe(sequence); expect(f.network.mock.calls).toHaveLength(calls);
  });
  it("received but not delivered exposes a liability and never earned income", async () => {
    const f = await fixture(); f.input.orders[0].delivered = "unknown";
    expect((await deriveOrderAccounting(f.input)).rows[0]).toMatchObject({ received_pending_delivery_raw: "1000000", recognized_customer_revenue_raw: null, responsibility: "core_delivery_or_refund_policy_review" });
    expect((await deriveOrderAccounting({ ...f.input, treasury_checkpoint: null })).rows[0]).toMatchObject({ received_pending_delivery_raw: null, settled_pending_delivery_gross_raw: "1000000", responsibility: "core_delivery_or_refund_policy_review" });
  });
  it.each([null, { schema: "invalid" }])("delivered without valid Treasury coverage remains unknown (%j)", async checkpointValue => {
    const f = await fixture(); const result = await deriveOrderAccounting({ ...f.input, treasury_checkpoint: checkpointValue });
    expect(result.recognized_customer_revenue_raw).toBeNull(); expect(result.rows[0].treasury_received).toBe("unknown");
  });
  it("receipt alone does not resolve an unknown settlement", async () => {
    const f = await fixture(); f.input.orders[0].settlement_confirmed = "unknown";
    expect((await deriveOrderAccounting(f.input)).rows[0]).toMatchObject({ treasury_received: "confirmed", recognized_customer_revenue_raw: null });
  });
  it("exact repeated inputs count once, changed duplicate order is rejected", async () => {
    const f = await fixture(); f.input.orders.push(structuredClone(f.order));
    expect((await deriveOrderAccounting(f.input)).rows).toHaveLength(1);
    f.input.orders[1].amount_raw = "2"; await expect(deriveOrderAccounting(f.input)).rejects.toThrow("conflicting_accounting_order");
  });
  it("two orders claiming the same settlement or receipt cannot create two purchases", async () => {
    const f = await fixture(); f.input.orders.push({ ...f.order, order_id: "another-order", settlement_key: "settlements/other.json" });
    expect((await deriveOrderAccounting(f.input)).rows.every(r => r.treasury_received_raw === null)).toBe(true);
    f.input.orders[1].settlement_key = f.order.settlement_key;
    expect((await deriveOrderAccounting(f.input)).rows.every(r => r.recognized_customer_revenue_raw === null)).toBe(true);
  });
  it.each(["owner_test", "platform_test", "unknown"] as const)("does not recognize %s", async buyer => {
    const f = await fixture(); f.input.attestations[0].buyer = buyer;
    expect((await deriveOrderAccounting(f.input)).rows[0].recognized_customer_revenue_raw).toBeNull();
  });
  it("fully refunded revenue is zero; overrefund and missing refund coverage stay unknown", async () => {
    const f = await fixture(); f.input.attestations[0].refunds.raw_amount = "1000000";
    expect((await deriveOrderAccounting(f.input)).rows[0]).toMatchObject({ recognized_customer_revenue_raw: "0", counted_customer_transactions: 0 });
    f.input.attestations[0].refunds.raw_amount = "1000001";
    expect((await deriveOrderAccounting(f.input)).rows[0].recognized_customer_revenue_raw).toBeNull();
    f.input.attestations[0].refunds = { coverage: "unknown", raw_amount: null, evidence_ref: "synthetic-incomplete-refunds" };
    expect((await deriveOrderAccounting(f.input)).rows[0].refund_raw).toBeNull();
  });
  it("all invoice categories are required; failed attempts and platform/support/acquisition costs remain distinct", async () => {
    const f = await fixture(); f.input.attestations[0].costs = Object.fromEntries(["browser", "storage", "compute", "reads_downloads", "settlement", "failed_attempts", "platform", "support", "acquisition"].map(key => [key, { raw_usdc: "100", evidence_ref: `synthetic-invoice-${key}` }]));
    expect((await deriveOrderAccounting(f.input)).rows[0]).toMatchObject({ actual_variable_cost_raw: "700", actual_contribution_margin_raw: "999300", operating_profit_raw: "999100" });
    delete f.input.attestations[0].costs.platform;
    expect((await deriveOrderAccounting(f.input)).rows[0].actual_contribution_margin_raw).toBeNull();
  });
  it("business IDs are opaque references and cannot create any payment evidence", async () => {
    const f = await fixture(); f.input.attestations[0].external_business_reference = { namespace: "fixture-invoice", id: "invoice-123", contract_evidence_ref: "fixture-schema-v1" };
    const value = await deriveOrderAccounting({ ...f.input, treasury_checkpoint: null });
    expect(value.rows[0].external_business_reference?.id).toBe("invoice-123"); expect(value.rows[0].recognized_customer_revenue_raw).toBeNull();
    f.input.attestations[0].external_business_reference.id = "https://private.example/invoice?token=secret";
    await expect(deriveOrderAccounting(f.input)).rejects.toThrow("invalid_business_reference");
  });
  it("tampered original artifacts fail delivered evidence without rewriting the original", async () => {
    const f = await fixture(); const key = [...f.bucket.values.keys()].find(key => key.endsWith("/page.html"))!;
    await f.bucket.put(key, "tampered"); const before = f.bucket.sequence;
    expect((await readCoreAccountingEvidence(f.env, TEST_ORDER_ID)).delivered).toBe("unknown"); expect(f.bucket.sequence).toBe(before);
  });
  it("offline command adapter reads the same original records and artifacts, without a live source", async () => {
    const f = await fixture();
    // @ts-ignore import-safe local JavaScript CLI
    const { evaluateLocalAccounting } = await import("../scripts/query-order-accounting.mjs");
    const objects = [...f.bucket.values].map(([key, value]) => ({ key, base64: Buffer.from(value.bytes ?? new TextEncoder().encode(value.text)).toString("base64") }));
    const calls = f.network.mock.calls.length;
    const result = await evaluateLocalAccounting({ schema: "delta-local-accounting-input/v1", as_of: asOf, order_ids: [TEST_ORDER_ID], objects,
      treasury_checkpoint: checkpoint(), attestations: [audit()] });
    expect(result.rows[0]).toMatchObject({ delivered: "confirmed", treasury_received: "confirmed", recognized_customer_revenue_raw: "1000000" });
    expect(result.report_hash).toMatch(/^sha256:[a-f0-9]{64}$/); expect(f.network.mock.calls).toHaveLength(calls);
  });
  it("missing historical orders do not become zero-cost or completed", async () => {
    const env = orderRuntime(new MemoryBucket());
    expect(await readCoreAccountingEvidence(env, TEST_ORDER_ID)).toMatchObject({ state: "unknown", payment_authorized: "unknown", delivered: "unknown" });
  });
  it("does not use future order evidence to rewrite an earlier accounting snapshot", async () => {
    const f = await fixture();
    const result = await deriveOrderAccounting({ ...f.input, as_of: "2026-11-01T00:00:00.000Z" });
    expect(result.recognized_customer_revenue_raw).toBeNull(); expect(result.rows[0].delivered).toBe("unknown");
  });
  it("models explicitly different retention periods plus reads/retries/platform costs without repricing", () => {
    const env = orderRuntime(new MemoryBucket());
    const one = estimateVariableCost(env, 1000, 1e9, 5, { retentionMonths: 1 });
    expect(estimateVariableCost(env, 1000, 1e9, 5, { retentionMonths: 3 }) - one).toBeCloseTo(0.03);
    expect(estimateVariableCost(env, 1000, 1e9, 5, { retentionMonths: 1, failedAttemptCostUsd: 2, platformFeesUsd: 1, downloadCostUsd: 3, supportCostUsd: 4, readRequests: 1e6 }) - one).toBeCloseTo(10.36);
    expect(() => estimateVariableCost(env, NaN, 1)).toThrow("invalid_cost_model_input");
  });
  it("groups repeated prepaid registration once, keeps failed consumed credits separate and never invents platform cash", async () => {
    const bucket = new MemoryBucket(), env = orderRuntime(bucket);
    const id = "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa";
    await bucket.put(`watches/${id}.json`, JSON.stringify({ schema: "delta-watch/v1", watch_id: id, partner: "fixture-platform", request_hash: `sha256:${"a".repeat(64)}`,
      checks_purchased: 10, checks_attempted: 3, checks_remaining: 7, last_result: { ok: false, sequence: 3 } }));
    const before = bucket.sequence;
    const view = await readPrepaidWatchAccounting(env, [id, id]);
    expect(view).toMatchObject({ purchase_records: 1, fulfilled_paid_uses: null, treasury_received_raw: null, recognized_customer_revenue_raw: null });
    expect(view.rows).toHaveLength(1); expect(view.rows[0]).toMatchObject({ consumed_credits: 3, remaining_credits: 7, latest_check_delivered: "unknown" });
    expect(bucket.sequence).toBe(before);
  });
  it("nullable metric columns preserve unknown units and negative modeled margins", async () => {
    const env = orderRuntime(new MemoryBucket()); const bind = vi.fn(() => ({ run: vi.fn(async () => undefined) }));
    env.ANALYTICS_DB = { prepare: vi.fn(() => ({ bind })) } as any;
    await recordEvent(env, { event: "capture_failed", route: "/v1/capture", contributionMarginUsd: -2 });
    expect(bind.mock.calls[0].slice(-5)).toEqual(["delta-metrics/v2", null, null, null, -2]);
  });
  it.each([null, "nonsense", "2oops", "-1", "1.5"])("missing or malformed provider browser units %j remain unknown in new proof", async header => {
    const bucket = new MemoryBucket(), env = orderRuntime(bucket); const browser = env.BROWSER.quickAction;
    env.BROWSER.quickAction = vi.fn(async (...args: any[]) => { const response = await (browser as any)(...args); if (header === null) response.headers.delete("x-browser-ms-used"); else response.headers.set("x-browser-ms-used", header); return response; }) as any;
    vi.stubGlobal("fetch", mockOrderNetwork()); expect((await app.fetch(orderRequest(), env)).status).toBe(200);
    const manifest = JSON.parse([...bucket.values.entries()].find(([key]) => key.endsWith("/manifest.json"))![1].text);
    expect(manifest.execution).toMatchObject({ browser_ms_used: null, browser_ms_source: "unknown", estimated_browser_ms: 30000, cost_basis: "model_not_invoice" });
  });
});
