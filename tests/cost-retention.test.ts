import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePage, verifyManifestIntegrity } from "../src/capture";
import { costModelAssumptions, estimateVariableCost, quoteProduct, raisePriceAfterNegativeMargin } from "../src/pricing";
import type { RetentionPolicy } from "../src/retention";
import { app } from "../src/index";
import { sha256, stableJson } from "../src/crypto";
import { MemoryBucket, mockOrderNetwork, orderRuntime, orderRequest, TEST_PAYER } from "./helpers/order-runtime";

const month = 30 * 24 * 60 * 60;
function policy(months = 3): RetentionPolicy {
  return { schema: "delta-retention-policy/v1", policy_id: `synthetic-${months}-months`, classes: {
    raw_artifacts: { start_event: "settlement_confirmed", retain_seconds: month / 2, deletion_window_seconds: month / 2 },
    minimal_metadata: { start_event: "settlement_confirmed", retain_seconds: month, deletion_window_seconds: month / 2 },
    transaction_audit: { start_event: "fulfillment_completed", retain_seconds: month * (months - 1), deletion_window_seconds: month },
  }, export_rights: { raw_artifacts: "authenticated_until_raw_expiry", minimal_metadata: "authenticated_until_metadata_expiry" } };
}
function input() {
  return { env: orderRuntime(new MemoryBucket()), product: "capture" as const,
    target: { requestedUrl: "https://example.com/", finalUrl: "https://example.com/", redirects: [] },
    fulfillmentFingerprint: `sha256:${"a".repeat(64)}`, grossPriceUsd: 1,
    paymentProtocol: "x402-v2-upfront" as const, channel: "synthetic" };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("retention-aware cost models remain estimates", () => {
  it("quotes the configured longest obligation plus deletion window without changing owner price", () => {
    const env = orderRuntime(new MemoryBucket());
    const original = quoteProduct(env, "capture");
    env.RETENTION_POLICY_JSON = JSON.stringify(policy());
    const quote = quoteProduct(env, "capture");
    expect(quote.grossPriceUsd).toBe(1);
    expect(quote.assumptions.costModel).toMatchObject({ storageMonths: 3,
      storageDurationSource: "configured_policy_maximum", storagePolicyId: "synthetic-3-months",
      basis: "listed_components_estimate_not_total_actual_cost" });
    expect(quote.expectedVariableCostUsd - original.expectedVariableCostUsd).toBeCloseTo(9_000_000 / 1e9 * 0.015 * 2, 12);
    expect(original.assumptions.costModel).toMatchObject({ storageMonths: 1, storageDurationSource: "one_month_fallback", storagePolicyId: null });
  });
  it("captures with the original purchased policy rather than a changed current proposal", async () => {
    const args = input(); args.env.RETENTION_POLICY_JSON = JSON.stringify(policy(12));
    vi.stubGlobal("fetch", mockOrderNetwork());
    const { manifest } = await capturePage({ ...args, retentionPolicy: policy() });
    expect(manifest.execution.cost_model).toMatchObject({ storageMonths: 3, storageDurationSource: "purchased_policy_maximum", storagePolicyId: "synthetic-3-months" });
    expect(manifest.execution.estimated_variable_cost_usd).toBe(estimateVariableCost(args.env, 1, manifest.artifact_sizes.total_bytes, 5, { retentionMonths: 3 }));
    expect(await verifyManifestIntegrity(manifest)).toBe(true);
    expect(await verifyManifestIntegrity({ ...manifest, execution: { ...manifest.execution, cost_model: { ...manifest.execution.cost_model, storageMonths: 12 } } })).toBe(false);
  });
  it("Core passes the purchased original policy when current configuration changes during settlement", async () => {
    const bucket = new MemoryBucket(), env = orderRuntime(bucket);
    env.RETENTION_POLICY_JSON = JSON.stringify(policy());
    vi.stubGlobal("fetch", mockOrderNetwork(async () => {
      // Synthetic configuration drift after the original immutable journal is
      // created, before the first observation. Never contacts a facilitator.
      env.RETENTION_POLICY_JSON = JSON.stringify(policy(12));
      return Response.json({ success: true, transaction: `0x${"12".repeat(32)}`, network: "eip155:8453", payer: TEST_PAYER });
    }));
    const request = orderRequest(); request.headers.set("x-delta-retention-policy-hash", await sha256(stableJson(policy())));
    expect((await app.fetch(request, env)).status).toBe(200);
    const manifest = JSON.parse([...bucket.values].find(([key]) => key.endsWith("/manifest.json"))![1].text);
    expect(manifest.execution.cost_model).toMatchObject({ storageMonths: 3, storageDurationSource: "purchased_policy_maximum", storagePolicyId: "synthetic-3-months" });
    expect(quoteProduct(env, "capture").assumptions.costModel?.storageMonths).toBe(12);
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
    expect(await verifyManifestIntegrity(manifest)).toBe(true);
  });
  it("post-settlement policy lookup times out and a late storage result cannot start Browser work", async () => {
    vi.useFakeTimers();
    const bucket = new MemoryBucket(), env = orderRuntime(bucket), get = bucket.get.bind(bucket);
    let settled = false, unblock!: () => void, started!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const readStarted = new Promise<void>(resolve => { started = resolve; });
    bucket.get = async key => {
      if (settled && key.startsWith("orders/")) { started(); await blocked; }
      return get(key);
    };
    const network = mockOrderNetwork(async () => {
      settled = true;
      return Response.json({ success: true, transaction: `0x${"12".repeat(32)}`, network: "eip155:8453", payer: TEST_PAYER });
    });
    vi.stubGlobal("fetch", network);
    const pending = app.fetch(orderRequest(), env);
    await readStarted;
    const original = [...bucket.values];
    await vi.advanceTimersByTimeAsync(15_001);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ state: "fulfillment_unknown", retryable: false });
    unblock(); await vi.advanceTimersByTimeAsync(1);
    expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
    expect(network.mock.calls.filter(([url]) => String(url).endsWith("/settle"))).toHaveLength(1);
    expect([...bucket.values]).toEqual(original);
  });
  it("does not invent purchased retention for legacy/partner captures", async () => {
    const args = input(); args.env.RETENTION_POLICY_JSON = JSON.stringify(policy(12));
    vi.stubGlobal("fetch", mockOrderNetwork());
    const { manifest } = await capturePage(args);
    expect(manifest.execution.cost_model).toMatchObject({ storageMonths: 1, storageDurationSource: "one_month_fallback", storageScope: "all_artifact_bytes_30_days" });
  });
  it("rejects an invalid retention model before starting Browser work", async () => {
    const args = input(); const malformed = policy(); malformed.classes.raw_artifacts.retain_seconds = -1;
    await expect(capturePage({ ...args, retentionPolicy: malformed })).rejects.toThrow("invalid_retention_duration");
    expect(args.env.BROWSER.quickAction).not.toHaveBeenCalled();
    args.env.RETENTION_POLICY_JSON = "invalid";
    expect(() => quoteProduct(args.env, "capture")).toThrow("invalid_retention_policy");
  });
  it("keeps a named configurable read-cost model distinct from unknown actual invoice/usage", () => {
    const env = orderRuntime(new MemoryBucket());
    const baseline = estimateVariableCost(env, 1, 1, 5, { readRequests: 1e6 });
    env.R2_READ_COST_PER_MILLION_USD = "0.90";
    expect(estimateVariableCost(env, 1, 1, 5, { readRequests: 1e6 }) - baseline).toBeCloseTo(0.54);
    expect(costModelAssumptions(env)).toMatchObject({ r2ReadCostPerMillionUsd: 0.9, modeledReadRequests: 0,
      unmodeledStorageTime: ["before_retention_start", "legal_hold_or_overdue_deletion"] });
  });
  it("negative modeled margins emit an estimated alert rather than an invented actual bill or price change", async () => {
    const bucket = new MemoryBucket(), env = orderRuntime(bucket);
    await raisePriceAfterNegativeMargin(env, "capture", 2);
    expect(JSON.parse(bucket.values.get("pricing-alerts/capture.json")!.text)).toMatchObject({ schema: "delta-pricing-margin-alert/v2",
      actual_variable_cost_usd: null, estimated_variable_cost_usd: 2, cost_basis: "model_not_invoice" });
    expect(quoteProduct(env, "capture").grossPriceUsd).toBe(1);
  });
  it("a malformed current retention proposal cannot break an estimate-only margin alert", async () => {
    const bucket = new MemoryBucket(), env = orderRuntime(bucket); env.RETENTION_POLICY_JSON = "invalid";
    await raisePriceAfterNegativeMargin(env, "capture", 2);
    expect(JSON.parse(bucket.values.get("pricing-alerts/capture.json")!.text)).toMatchObject({ configured_price_usd: 1,
      actual_variable_cost_usd: null, estimated_variable_cost_usd: 2, cost_basis: "model_not_invoice" });
    expect(() => quoteProduct(env, "capture")).toThrow("invalid_retention_policy");
  });
});
