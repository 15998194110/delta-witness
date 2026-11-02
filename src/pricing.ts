import type { RuntimeEnv } from "./env";
import { safeErrorCode } from "./failures";
import { parseRetentionPolicy, type RetentionPolicy } from "./retention";

export type Product = "capture" | "preflight" | "watch_check";

// Explicit model inputs are not provider invoices. Never infer an actual bill
// from an estimate, a free allowance, or an absent usage/cost field.
export type CostModelInputs = {
  retentionMonths?: number; readRequests?: number; downloadCostUsd?: number;
  failedAttemptCostUsd?: number; platformFeesUsd?: number; supportCostUsd?: number;
};

export type CostModelAssumptions = {
  schema: "delta-cost-model/v1";
  basis: "listed_components_estimate_not_total_actual_cost";
  storageMonths: number;
  storageDurationSource: "purchased_policy_maximum" | "configured_policy_maximum" | "one_month_fallback";
  storagePolicyId: string | null;
  storageScope: "all_artifact_bytes_longest_class_plus_deletion_window" | "all_artifact_bytes_30_days";
  unmodeledStorageTime: readonly ["before_retention_start", "legal_hold_or_overdue_deletion"];
  r2ReadCostPerMillionUsd: number;
  modeledReadRequests: number;
};

const MODEL_MONTH_SECONDS = 30 * 24 * 60 * 60;
// Standard-storage model assumption, not a claim about this bucket's class,
// current invoice, rounded billing units, free tier or actual request count.
const DEFAULT_R2_STANDARD_READ_MODEL_USD_PER_MILLION = 0.36;

export function costModelAssumptions(
  env: RuntimeEnv,
  suppliedPolicy?: RetentionPolicy,
  source: "purchased_policy_maximum" | "configured_policy_maximum" = "purchased_policy_maximum",
): CostModelAssumptions {
  const policy = parseRetentionPolicy(suppliedPolicy);
  return {
    schema: "delta-cost-model/v1",
    basis: "listed_components_estimate_not_total_actual_cost",
    storageMonths: policy ? Math.max(...Object.values(policy.classes).map(rule => rule.retain_seconds + rule.deletion_window_seconds)) / MODEL_MONTH_SECONDS : 1,
    storageDurationSource: policy ? source : "one_month_fallback",
    storagePolicyId: policy?.policy_id ?? null,
    storageScope: policy ? "all_artifact_bytes_longest_class_plus_deletion_window" : "all_artifact_bytes_30_days",
    unmodeledStorageTime: ["before_retention_start", "legal_hold_or_overdue_deletion"],
    r2ReadCostPerMillionUsd: numberSetting(env.R2_READ_COST_PER_MILLION_USD, DEFAULT_R2_STANDARD_READ_MODEL_USD_PER_MILLION, 0, 1_000),
    modeledReadRequests: 0,
  };
}

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
    costModel?: CostModelAssumptions;
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
  inputs: CostModelInputs = {},
): number {
  const values = [browserMs, storageBytes, r2Writes, ...Object.values(inputs)];
  if (values.some(value => !Number.isFinite(value) || value! < 0)) throw new Error("invalid_cost_model_input");
  const browserHourly = numberSetting(env.BROWSER_COST_PER_HOUR_USD, 0.09, 0, 100);
  const facilitator = numberSetting(env.FACILITATOR_FEE_USD, 0.001, 0, 10);
  const failureAllowance = numberSetting(env.FAILURE_ALLOWANCE_USD, 0.001, 0, 10);
  const workerAllowance = numberSetting(env.WORKER_ALLOWANCE_USD, 0.0001, 0, 10);
  const r2WritePerMillion = numberSetting(env.R2_WRITE_COST_PER_MILLION_USD, 4.5, 0, 1_000);
  const r2StorageGbMonth = numberSetting(env.R2_STORAGE_GB_MONTH_USD, 0.015, 0, 100);
  const r2ReadPerMillion = numberSetting(env.R2_READ_COST_PER_MILLION_USD, DEFAULT_R2_STANDARD_READ_MODEL_USD_PER_MILLION, 0, 1_000);
  return (
    (browserMs / 3_600_000) * browserHourly +
    facilitator +
    failureAllowance +
    workerAllowance +
    (r2Writes / 1_000_000) * r2WritePerMillion +
    (storageBytes / 1_000_000_000) * r2StorageGbMonth * (inputs.retentionMonths ?? 1) +
    (inputs.readRequests ?? 0) / 1_000_000 * r2ReadPerMillion +
    (inputs.downloadCostUsd ?? 0) + (inputs.failedAttemptCostUsd ?? 0) +
    (inputs.platformFeesUsd ?? 0) + (inputs.supportCostUsd ?? 0)
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
  // New quotes use the disclosed current proposal. Historical fulfillment must
  // instead pass its original purchased policy to capturePage, never this env.
  const costModel = costModelAssumptions(env, parseRetentionPolicy(env.RETENTION_POLICY_JSON), "configured_policy_maximum");
  const expectedVariableCostUsd = estimateVariableCost(env, expectedBrowserMs, expectedStorageBytes, 5, { retentionMonths: costModel.storageMonths });
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
      costModel,
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
  modeledVariableCostUsd: number,
): Promise<void> {
  // Never autonomously change a customer-facing price. Preserve the signal for
  // operator review instead; a newer owner decision is required to reprice.
  // Alerting needs the current fixed owner price, not current retention terms.
  // A malformed new proposal must not break a committed historical fulfillment.
  const configuredPriceUsd = Math.ceil(configuredProductPrice(env, product) * 1_000_000) / 1_000_000;
  if (!Number.isFinite(modeledVariableCostUsd) || modeledVariableCostUsd <= configuredPriceUsd) return;
  const alert = {
    schema: "delta-pricing-margin-alert/v2",
    product,
    configured_price_usd: configuredPriceUsd,
    actual_variable_cost_usd: null,
    estimated_variable_cost_usd: modeledVariableCostUsd,
    cost_basis: "model_not_invoice",
    reason: "modeled_fulfillment_margin_negative_owner_price_locked",
    updated_at: new Date().toISOString(),
  };
  try {
    await env.PROOFS.put(`pricing-alerts/${product}.json`, JSON.stringify(alert), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "pricing_margin_alert_write_failed", product, reason: safeErrorCode(error) }));
  }
}

export function x402Price(quote: PricingQuote): `$${string}` {
  return `$${quote.grossPriceUsd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}
