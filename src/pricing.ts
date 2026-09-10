import type { RuntimeEnv } from "./env";

export type Product = "capture" | "preflight" | "watch_check";

export type PricingQuote = {
  product: Product;
  grossPriceUsd: number;
  configuredPriceUsd: number;
  minimumPriceUsd: number;
  expectedVariableCostUsd: number;
  targetMarginBps: number;
  estimatedContributionMarginUsd: number;
  assumptions: {
    browserMs: number;
    storageBytes: number;
    facilitatorFeeUsd: number;
    r2Writes: number;
  };
};

function numberSetting(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function estimateVariableCost(
  env: RuntimeEnv,
  browserMs: number,
  storageBytes: number,
  r2Writes = 5,
): number {
  const browserHourly = numberSetting(env.BROWSER_COST_PER_HOUR_USD, 0.09, 0, 100);
  const facilitator = numberSetting(env.FACILITATOR_FEE_USD, 0.001, 0, 10);
  const failureAllowance = numberSetting(env.FAILURE_ALLOWANCE_USD, 0.001, 0, 10);
  const workerAllowance = numberSetting(env.WORKER_ALLOWANCE_USD, 0.0001, 0, 10);
  const r2WritePerMillion = numberSetting(env.R2_WRITE_COST_PER_MILLION_USD, 4.5, 0, 1_000);
  const r2StorageGbMonth = numberSetting(env.R2_STORAGE_GB_MONTH_USD, 0.015, 0, 100);
  return (
    (browserMs / 3_600_000) * browserHourly +
    facilitator +
    failureAllowance +
    workerAllowance +
    (r2Writes / 1_000_000) * r2WritePerMillion +
    (storageBytes / 1_000_000_000) * r2StorageGbMonth
  );
}

function configuredProductPrice(env: RuntimeEnv, product: Product): number {
  const value = product === "capture"
    ? env.CAPTURE_BASE_PRICE_USD
    : product === "watch_check"
      ? env.WATCH_BASE_PRICE_USD
      : env.PREFLIGHT_BASE_PRICE_USD;
  const fallback = product === "preflight" ? 5 : 1;
  return numberSetting(value, fallback, 0.001, 10_000);
}

export function quoteProduct(env: RuntimeEnv, product: Product): PricingQuote {
  const expectedBrowserMs = numberSetting(env.PRICING_BROWSER_MS, 25_000, 1_000, 120_000);
  const expectedStorageBytes = numberSetting(env.PRICING_STORAGE_BYTES, 9_000_000, 0, 50_000_000);
  const targetMarginBps = numberSetting(env.TARGET_MARGIN_BPS, 6_500, 0, 9_500);
  const expectedVariableCostUsd = estimateVariableCost(env, expectedBrowserMs, expectedStorageBytes);
  const minimumPriceUsd = expectedVariableCostUsd / (1 - targetMarginBps / 10_000);
  const configuredPriceUsd = configuredProductPrice(env, product);
  // Owner pricing is fixed by explicit commercial policy, not autonomous repricing.
  // Cost-floor telemetry remains visible in minimumPriceUsd; it must not silently
  // invent a new customer-facing price without a newer explicit owner decision.
  const grossPriceUsd = Math.ceil(configuredPriceUsd * 1_000_000) / 1_000_000;
  return {
    product,
    grossPriceUsd,
    configuredPriceUsd,
    minimumPriceUsd,
    expectedVariableCostUsd,
    targetMarginBps,
    estimatedContributionMarginUsd: grossPriceUsd - expectedVariableCostUsd,
    assumptions: {
      browserMs: expectedBrowserMs,
      storageBytes: expectedStorageBytes,
      facilitatorFeeUsd: numberSetting(env.FACILITATOR_FEE_USD, 0.001, 0, 10),
      r2Writes: 5,
    },
  };
}

export async function quoteProductWithOverride(env: RuntimeEnv, product: Product): Promise<PricingQuote> {
  // Historical R2 price overrides are intentionally ignored. The owner-authorized
  // fixed ladder is authoritative until a newer explicit owner pricing decision.
  return quoteProduct(env, product);
}

export async function raisePriceAfterNegativeMargin(
  env: RuntimeEnv,
  product: Product,
  actualVariableCostUsd: number,
): Promise<void> {
  // Never autonomously change a customer-facing price. Preserve the signal for
  // operator review instead; a newer owner decision is required to reprice.
  const quote = quoteProduct(env, product);
  if (!Number.isFinite(actualVariableCostUsd) || actualVariableCostUsd <= quote.grossPriceUsd) return;
  const alert = {
    schema: "delta-pricing-margin-alert/v1",
    product,
    configured_price_usd: quote.grossPriceUsd,
    actual_variable_cost_usd: actualVariableCostUsd,
    reason: "actual_fulfillment_margin_negative_owner_price_locked",
    updated_at: new Date().toISOString(),
  };
  try {
    await env.PROOFS.put(`pricing-alerts/${product}.json`, JSON.stringify(alert), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "pricing_margin_alert_write_failed", product, message: error instanceof Error ? error.message : String(error) }));
  }
}

export function x402Price(quote: PricingQuote): `$${string}` {
  return `$${quote.grossPriceUsd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}
