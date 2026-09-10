import { describe, expect, it } from "vitest";
import { estimateVariableCost, quoteProduct } from "../src/pricing";
import type { RuntimeEnv } from "../src/env";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";

function env(overrides: Record<string, unknown> = {}): RuntimeEnv {
  return {
    BROWSER_COST_PER_HOUR_USD: "0.09",
    FACILITATOR_FEE_USD: "0.001",
    FAILURE_ALLOWANCE_USD: "0.001",
    WORKER_ALLOWANCE_USD: "0.0001",
    R2_WRITE_COST_PER_MILLION_USD: "4.5",
    R2_STORAGE_GB_MONTH_USD: "0.015",
    PRICING_BROWSER_MS: "25000",
    PRICING_STORAGE_BYTES: "9000000",
    TARGET_MARGIN_BPS: "6500",
    CAPTURE_BASE_PRICE_USD: "1",
    PREFLIGHT_BASE_PRICE_USD: "5",
    WATCH_BASE_PRICE_USD: "1",
    ...overrides,
  } as unknown as RuntimeEnv;
}

describe("owner-locked pricing", () => {
  it("deploys the current owner-authorized prices", () => {
    const config = JSON.parse(readFileSync(new NodeURL("../wrangler.jsonc", import.meta.url), "utf8"));
    expect(config.vars).toMatchObject({ CAPTURE_BASE_PRICE_USD: "1", PREFLIGHT_BASE_PRICE_USD: "5", WATCH_BASE_PRICE_USD: "1", PARTNER_PREFLIGHT_BASE_PRICE_USD: "1" });
  });

  it("enforces the $1 -> $5 entry/verification ladder", () => {
    const config = env();
    expect(quoteProduct(config, "capture").grossPriceUsd).toBe(1);
    expect(quoteProduct(config, "preflight").grossPriceUsd).toBe(5);
    expect(quoteProduct(config, "watch_check").grossPriceUsd).toBe(1);
  });

  it("keeps cost-floor telemetry without silently changing the owner price", () => {
    const quote = quoteProduct(env(), "capture");
    expect(quote.grossPriceUsd).toBe(1);
    expect(quote.grossPriceUsd).toBeGreaterThan(quote.expectedVariableCostUsd);
    expect(quote.estimatedContributionMarginUsd).toBeGreaterThan(0);
  });

  it("does not invent a fourth price when modeled costs exceed the configured ladder", () => {
    const quote = quoteProduct(env({ BROWSER_COST_PER_HOUR_USD: "100", PRICING_BROWSER_MS: "120000" }), "capture");
    expect(quote.minimumPriceUsd).toBeGreaterThan(1);
    expect(quote.grossPriceUsd).toBe(1);
  });

  it("raises the cost signal as browser time rises", () => {
    const low = estimateVariableCost(env(), 1_000, 1000);
    const high = estimateVariableCost(env(), 30_000, 1000);
    expect(high).toBeGreaterThan(low);
  });
});
