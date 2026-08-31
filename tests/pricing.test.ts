import { describe, expect, it } from "vitest";
import { estimateVariableCost, quoteProduct } from "../src/pricing";
import type { RuntimeEnv } from "../src/env";

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
    CAPTURE_BASE_PRICE_USD: "0.01",
    PREFLIGHT_BASE_PRICE_USD: "0.01",
    ...overrides,
  } as unknown as RuntimeEnv;
}

describe("contribution-margin pricing", () => {
  it("calculates a floor above expected variable cost", () => {
    const quote = quoteProduct(env(), "capture");
    expect(quote.grossPriceUsd).toBeGreaterThan(quote.expectedVariableCostUsd);
    expect(quote.grossPriceUsd).toBeGreaterThanOrEqual(quote.minimumPriceUsd);
    expect(quote.estimatedContributionMarginUsd).toBeGreaterThan(0);
  });

  it("raises the floor as browser time rises", () => {
    const low = estimateVariableCost(env(), 1_000, 1000);
    const high = estimateVariableCost(env(), 30_000, 1000);
    expect(high).toBeGreaterThan(low);
  });
});
