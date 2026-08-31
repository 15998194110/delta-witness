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
  const value = product === "capture" ? env.CAPTURE_BASE_PRICE_USD : env.PREFLIGHT_BASE_PRICE_USD;
  return numberSetting(value, 0.01, 0.001, 10_000);
}

export function quoteProduct(env: RuntimeEnv, product: Product): PricingQuote {
  const expectedBrowserMs = numberSetting(env.PRICING_BROWSER_MS, 25_000, 1_000, 120_000);
  const expectedStorageBytes = numberSetting(env.PRICING_STORAGE_BYTES, 9_000_000, 0, 50_000_000);
  const targetMarginBps = numberSetting(env.TARGET_MARGIN_BPS, 6_500, 0, 9_500);
  const expectedVariableCostUsd = estimateVariableCost(env, expectedBrowserMs, expectedStorageBytes);
  const minimumPriceUsd = expectedVariableCostUsd / (1 - targetMarginBps / 10_000);
  const configuredPriceUsd = configuredProductPrice(env, product);
  const grossPriceUsd = Math.ceil(Math.max(configuredPriceUsd, minimumPriceUsd) * 1_000_000) / 1_000_000;
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

type PriceOverride = {
  schema: "delta-price-override/v1";
  product: Product;
  minimum_price_usd: number;
  reason: string;
  updated_at: string;
};

export async function quoteProductWithOverride(env: RuntimeEnv, product: Product): Promise<PricingQuote> {
  const quote = quoteProduct(env, product);
  try {
    const object = await env.PROOFS.get(`pricing-overrides/${product}.json`);
    if (!object) return quote;
    const override = await object.json<PriceOverride>();
    if (
      override.schema !== "delta-price-override/v1" ||
      override.product !== product ||
      !Number.isFinite(override.minimum_price_usd) ||
      override.minimum_price_usd <= quote.grossPriceUsd
    ) {
      return quote;
    }
    const grossPriceUsd = Math.ceil(override.minimum_price_usd * 1_000_000) / 1_000_000;
    return {
      ...quote,
      grossPriceUsd,
      minimumPriceUsd: Math.max(quote.minimumPriceUsd, grossPriceUsd),
      estimatedContributionMarginUsd: grossPriceUsd - quote.expectedVariableCostUsd,
    };
  } catch (error) {
    console.error(JSON.stringify({ event: "price_override_read_failed", product, message: error instanceof Error ? error.message : String(error) }));
    return quote;
  }
}

export async function raisePriceAfterNegativeMargin(
  env: RuntimeEnv,
  product: Product,
  actualVariableCostUsd: number,
): Promise<void> {
  const marginBps = numberSetting(env.TARGET_MARGIN_BPS, 6_500, 0, 9_500);
  const required = Math.ceil((actualVariableCostUsd / (1 - marginBps / 10_000)) * 1_000_000) / 1_000_000;
  const key = `pricing-overrides/${product}.json`;
  const current = await env.PROOFS.get(key);
  if (current) {
    const value = await current.json<Partial<PriceOverride>>();
    if (typeof value.minimum_price_usd === "number" && value.minimum_price_usd >= required) return;
  }
  const override: PriceOverride = {
    schema: "delta-price-override/v1",
    product,
    minimum_price_usd: required,
    reason: "actual_fulfillment_margin_negative",
    updated_at: new Date().toISOString(),
  };
  await env.PROOFS.put(key, JSON.stringify(override), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

export function x402Price(quote: PricingQuote): `$${string}` {
  return `$${quote.grossPriceUsd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}
