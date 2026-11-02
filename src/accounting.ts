// Internal read-only projection, never payment authority. Original orders,
// settlement journals, fulfillment/artifacts and Treasury checkpoints remain
// the sources of truth. No record is created, repaired or refunded here.
import type { RuntimeEnv } from "./env";
import { readOrderBinding } from "./orders";
import { readOrderSettlement } from "./settlement";
import { readFulfillment, fulfillmentRecordKey, verifiedDelivery } from "./fulfillment";
import { createOrderReadSnapshot } from "./order-storage";
import { withinDeadline } from "./deadline";
import { sha256, stableJson, uuidFromDigest } from "./crypto";
import type { WatchRecord } from "./watch";
import { readStoredCapture } from "./capture";
// Existing canonical receipt validator is deliberately shared with the scanner.
// @ts-ignore JavaScript module is covered by treasury-reconciliation tests.
import { validateCheckpoint, NETWORK, USDC, TREASURY } from "../scripts/treasury-reconciliation.mjs";

const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RAW = /^(0|[1-9][0-9]{0,77})$/;
type State = "confirmed" | "unknown";
export type CoreAccountingEvidence = {
  order_id: string; source: "core_original_records"; state: "verified" | "unknown";
  read_at: string;
  request_hash?: string; settlement_key?: string; payment_fingerprint?: string;
  product?: string; amount_raw?: string; payer?: string; network?: string; asset?: string; pay_to?: string;
  payment_authorized: State; settlement_confirmed: State; transaction?: string;
  delivered: State; proof_id?: string; bundle_root?: string; observed_at?: string;
};
export async function readCoreAccountingEvidence(env: RuntimeEnv, orderId: string): Promise<CoreAccountingEvidence> {
  const unknown: CoreAccountingEvidence = { order_id: orderId, source: "core_original_records", state: "unknown", read_at: new Date().toISOString(),
    payment_authorized: "unknown", settlement_confirmed: "unknown", delivered: "unknown" };
  const reader = createOrderReadSnapshot(env);
  try {
    return await withinDeadline((async () => {
      const order = await readOrderBinding(reader.env, orderId);
      if (!order) return unknown;
      reader.allowArtifactsFor(uuidFromDigest(await sha256(`${order.payment_fingerprint}\n${order.product}`)));
      const settlement = await readOrderSettlement(reader.env, order);
      const base: CoreAccountingEvidence = { ...unknown, state: "verified", request_hash: order.request_hash,
        settlement_key: order.settlement_key, payment_fingerprint: order.payment_fingerprint, product: order.product,
        amount_raw: order.amount, payer: order.payer, network: order.network, asset: order.asset, pay_to: order.pay_to,
        payment_authorized: "confirmed", settlement_confirmed: settlement.state === "settlement_confirmed" ? "confirmed" : "unknown",
        transaction: settlement.result?.transaction ?? settlement.transaction_hint };
      const stored = await readFulfillment(reader.env, fulfillmentRecordKey(order.payment_fingerprint));
      if (!stored || stored.record.state !== "complete" || stored.record.request_hash !== order.request_hash ||
          stored.record.route !== `/v1/${order.product}` || !stored.record.response_hash ||
          stored.record.paid_price_usd !== Number(order.amount) / 1e6) return base;
      const response = await verifiedDelivery(reader.env, stored, order.request_body, order.product, order.payment_fingerprint);
      return response ? { ...base, delivered: "confirmed", proof_id: response.proof_id, bundle_root: response.bundle_root, observed_at: response.observed_at } : base;
    })(), 15_000, "accounting_read_timeout", reader.cancel);
  } catch { return unknown; }
  finally { reader.cancel(); }
}

export type AuditAttestation = {
  order_id: string;
  // Non-secret opaque references only. These are audited caller inputs, not
  // provider API fields or automatic evidence of independent buyer purpose.
  evidence_ref: string;
  buyer: "independent_customer" | "owner_test" | "platform_test" | "unknown";
  refunds: { coverage: "complete" | "unknown"; raw_amount: string | null; evidence_ref: string };
  costs?: Partial<Record<"browser" | "storage" | "compute" | "reads_downloads" | "settlement" | "failed_attempts" | "platform" | "support" | "acquisition", { raw_usdc: string; evidence_ref: string }>>;
  external_business_reference?: { namespace: string; id: string; contract_evidence_ref: string };
};
const COSTS = ["browser", "storage", "compute", "reads_downloads", "settlement", "failed_attempts", "platform"] as const;
function raw(value: unknown): value is string { return typeof value === "string" && RAW.test(value); }
function validRef(value: unknown): value is string { return typeof value === "string" && REF.test(value); }
function money(value: bigint | null) { return value === null ? null : value.toString(); }
function auditInput(value: AuditAttestation) {
  if (!validRef(value.evidence_ref) || !["independent_customer", "owner_test", "platform_test", "unknown"].includes(value.buyer) ||
    !value.refunds || !["complete", "unknown"].includes(value.refunds.coverage) || !validRef(value.refunds.evidence_ref) ||
    (value.refunds.coverage === "complete" ? !raw(value.refunds.raw_amount) : value.refunds.raw_amount !== null)) throw new Error("invalid_accounting_attestation");
  if (value.costs) for (const [key, cost] of Object.entries(value.costs)) {
    if (![...COSTS, "support", "acquisition"].includes(key as any) || !cost || !raw(cost.raw_usdc) || !validRef(cost.evidence_ref)) throw new Error("invalid_cost_evidence");
  }
  const external = value.external_business_reference;
  if (external && (!validRef(external.namespace) || !validRef(external.id) || !validRef(external.contract_evidence_ref))) throw new Error("invalid_business_reference");
}

export async function deriveOrderAccounting(input: {
  as_of: string; orders: CoreAccountingEvidence[]; treasury_checkpoint: unknown | null;
  attestations?: AuditAttestation[];
}) {
  if (!Number.isFinite(Date.parse(input.as_of)) || new Date(input.as_of).toISOString() !== input.as_of ||
      !Array.isArray(input.orders) || input.orders.length > 500 || (input.attestations?.length ?? 0) > 500) throw new Error("invalid_accounting_scope");
  let checkpoint: any = null;
  try { if (input.treasury_checkpoint) { checkpoint = validateCheckpoint(input.treasury_checkpoint); if (Date.parse(checkpoint.checked_at) > Date.parse(input.as_of)) checkpoint = null; } } catch { checkpoint = null; }
  const audits = new Map<string, AuditAttestation>();
  for (const value of input.attestations ?? []) {
    auditInput(value);
    if (audits.has(value.order_id)) throw new Error("duplicate_accounting_attestation");
    audits.set(value.order_id, value);
  }
  const orders = new Map<string, CoreAccountingEvidence>();
  for (const order of input.orders) {
    if (!order || !validRef(order.order_id)) throw new Error("invalid_accounting_order");
    const old = orders.get(order.order_id);
    if (old && stableJson(old) !== stableJson(order)) throw new Error("conflicting_accounting_order");
    orders.set(order.order_id, order);
  }
  const settlements = new Map<string, number>();
  for (const order of orders.values()) if (order.settlement_key) settlements.set(order.settlement_key, (settlements.get(order.settlement_key) ?? 0) + 1);
  const match = (order: CoreAccountingEvidence) => checkpoint?.transfers.filter((r: any) =>
    r.tx_hash === order.transaction?.toLowerCase() && r.raw_amount === order.amount_raw && r.from === order.payer?.toLowerCase()) ?? [];
  const receipts = new Map<string, number>();
  for (const order of orders.values()) for (const receipt of match(order)) receipts.set(receipt.receipt_id, (receipts.get(receipt.receipt_id) ?? 0) + 1);
  const rows = [...orders.values()].map(order => {
    const audit = audits.get(order.order_id);
    const valid = order.source === "core_original_records" && order.state === "verified" && raw(order.amount_raw) &&
      Number.isFinite(Date.parse(order.read_at)) && Date.parse(order.read_at) <= Date.parse(input.as_of) &&
      (order.observed_at === undefined || Number.isFinite(Date.parse(order.observed_at)) && Date.parse(order.observed_at) <= Date.parse(input.as_of)) &&
      order.network === NETWORK && order.asset?.toLowerCase() === USDC && order.pay_to?.toLowerCase() === TREASURY &&
      order.settlement_key && settlements.get(order.settlement_key) === 1;
    const candidates = valid ? match(order) : [];
    const receipt = candidates.length === 1 && receipts.get(candidates[0].receipt_id) === 1 ? candidates[0] : undefined;
    const received = receipt ? BigInt(receipt.raw_amount) : null;
    const refund = audit?.refunds.coverage === "complete" && raw(audit.refunds.raw_amount) ? BigInt(audit.refunds.raw_amount) : null;
    const refundValid = received !== null && refund !== null && refund <= received;
    const excluded = receipt?.customer_revenue === false || ["owner_test", "platform_test"].includes(audit?.buyer ?? "");
    const earned = valid && received !== null && refundValid && order.settlement_confirmed === "confirmed" && order.delivered === "confirmed" &&
      audit?.buyer === "independent_customer" && !excluded ? received - refund! : null;
    const cost = audit?.costs && COSTS.every(key => audit.costs![key]) ? COSTS.reduce((sum, key) => sum + BigInt(audit.costs![key]!.raw_usdc), 0n) : null;
    const margin = earned !== null && cost !== null ? earned - cost : null;
    const operating = margin !== null && audit?.costs?.support && audit.costs.acquisition ? margin - BigInt(audit.costs.support.raw_usdc) - BigInt(audit.costs.acquisition.raw_usdc) : null;
    return { order_id: order.order_id, payment_authorized: valid ? order.payment_authorized : "unknown",
      settlement_confirmed: valid ? order.settlement_confirmed : "unknown", treasury_received: receipt ? "confirmed" : "unknown",
      delivered: valid ? order.delivered : "unknown", proof_id: valid ? order.proof_id ?? null : null,
      settlement_key: valid ? order.settlement_key : null, service_fee_tx: receipt?.tx_hash ?? null, receipt_id: receipt?.receipt_id ?? null,
      treasury_received_raw: money(received), recognized_customer_revenue_raw: money(earned), refund_raw: refundValid ? money(refund) : null,
      actual_variable_cost_raw: money(cost), actual_contribution_margin_raw: money(margin), operating_profit_raw: money(operating),
      received_pending_delivery_raw: received !== null && order.delivered !== "confirmed" && refundValid ? money(received - refund!) : null,
      settled_pending_delivery_gross_raw: valid && order.settlement_confirmed === "confirmed" && order.delivered !== "confirmed" ? order.amount_raw : null,
      responsibility: valid && order.delivered !== "confirmed" && (received !== null || order.settlement_confirmed === "confirmed") ? "core_delivery_or_refund_policy_review" : earned === null ? "evidence_reconciliation" : "none",
      counted_customer_transactions: earned !== null && earned > 0n ? 1 : excluded || (earned === 0n) ? 0 : null,
      exclusion: excluded ? "project_or_platform_test" : null, buyer_evidence_ref: audit?.evidence_ref ?? null,
      external_business_reference: audit?.external_business_reference ?? null,
      scope: "direct_capture_preflight_only; no prepaid purchase or usage recognition from missing entitlement ledger",
    };
  });
  const sumKnown = (key: "recognized_customer_revenue_raw" | "actual_variable_cost_raw" | "actual_contribution_margin_raw") =>
    rows.length > 0 && rows.every(r => r[key] !== null) ? rows.reduce((sum, row) => sum + BigInt(row[key]!), 0n).toString() : null;
  const body = { schema: "delta-order-accounting-view/v1", as_of: input.as_of, authority: "derived_not_a_ledger",
    state: checkpoint && rows.length > 0 && rows.every(row => row.recognized_customer_revenue_raw !== null && row.actual_contribution_margin_raw !== null && row.operating_profit_raw !== null) ? "complete" : "partial",
    revenue_reconciliation_state: checkpoint && rows.length > 0 && rows.every(row => row.recognized_customer_revenue_raw !== null) ? "complete" : "partial",
    units: "canonical_Base_USDC_raw_6_decimals", treasury_range: checkpoint ? { from: checkpoint.origin_block, through: checkpoint.checked_through_block, as_of: checkpoint.checked_at } : null,
    assurance: "Core evidence requires readCoreAccountingEvidence; buyer purpose, refund coverage and invoices are caller-supplied audit attestations, not independently verified by this projection",
    input_hash: await sha256(stableJson(input)), rows,
    recognized_customer_revenue_raw: sumKnown("recognized_customer_revenue_raw"), actual_variable_cost_raw: sumKnown("actual_variable_cost_raw"), actual_contribution_margin_raw: sumKnown("actual_contribution_margin_raw") };
  return { ...body, view_hash: await sha256(stableJson(body)) };
}

// The existing prepaid registration is entitlement authority, not platform
// payout or on-chain receipt evidence. Count each registration once and keep
// consumed credits separate from successful paid uses and cash revenue.
export async function readPrepaidWatchAccounting(env: RuntimeEnv, requestedIds: string[]) {
  if (!Array.isArray(requestedIds) || requestedIds.length > 100 || requestedIds.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))) throw new Error("invalid_watch_accounting_scope");
  const rows = [];
  for (const id of new Set(requestedIds)) {
    const reader = createOrderReadSnapshot(env, 262_144);
    const unknown = { watch_id: id, state: "unknown", purchase_records: null, consumed_credits: null, remaining_credits: null, latest_check_delivered: "unknown" };
    try {
      const row = await withinDeadline((async () => {
        const object = await reader.env.PROOFS.get(`watches/${id}.json`);
        if (!object) return unknown;
        const record = await object.json<WatchRecord>();
        if (record.schema !== "delta-watch/v1" || record.watch_id !== id || !validRef(record.partner) || !/^sha256:[0-9a-f]{64}$/.test(record.request_hash) ||
            ![record.checks_purchased, record.checks_attempted, record.checks_remaining].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000) ||
            record.checks_purchased < 1 || record.checks_attempted + record.checks_remaining !== record.checks_purchased) return unknown;
        let latest = "unknown";
        if (record.last_result?.ok === true && record.last_result.sequence === record.checks_attempted && record.last_proof_id) {
          const fingerprint = await sha256(`watch\n${id}\n${record.checks_attempted}`);
          reader.allowArtifactsFor(uuidFromDigest(await sha256(`${fingerprint}\nwatch_check`)));
          const artifacts = await readStoredCapture({ env: reader.env, fulfillmentFingerprint: fingerprint, product: "watch_check", requestedUrl: record.url,
            grossPriceUsd: record.prepaid_check_price_usd, paymentProtocol: "partner-prepaid", partner: record.partner });
          if (artifacts?.manifest.proof_id === record.last_proof_id && record.last_result.proof_id === record.last_proof_id) latest = "confirmed";
        }
        return { watch_id: id, partner: record.partner, state: "entitlement_verified", purchase_records: 1,
          consumed_credits: record.checks_attempted, remaining_credits: record.checks_remaining, latest_check_delivered: latest };
      })(), 15_000, "accounting_watch_timeout", reader.cancel);
      rows.push(row);
    } catch { rows.push(unknown); }
    finally { reader.cancel(); }
  }
  return { schema: "delta-prepaid-accounting-view/v1", scope: "original_watch_entitlements_only", rows,
    purchase_records: rows.every(row => row.purchase_records !== null) ? rows.reduce((sum, row) => sum + row.purchase_records!, 0) : null,
    fulfilled_paid_uses: null, treasury_received_raw: null, recognized_customer_revenue_raw: null,
    reason: "Original registration lacks an independently verified platform purchase/payout identity; consumed credits include failed attempts and cannot be counted as purchases or fulfilled uses" };
}
