import type { RuntimeEnv } from "./env";
import { sha256, stableJson, uuidFromDigest } from "./crypto";
import { withinDeadline } from "./deadline";
import { fulfillmentRecordKey, readFulfillment, recoverDelivery } from "./fulfillment";
import { createOrderReadSnapshot, MetadataReadError, StorageWriteError } from "./order-storage";
import { orderRetention, readOrderBinding, readOrderEntitlement, type OrderBinding } from "./orders";
import { readOrderSettlement } from "./settlement";

const PREFIX = "orders/";
const ORDER_KEY = /^orders\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
export const PAID_ORDER_RECOVERY_ITEM_MAX_MS = 8_000;

export type PaidOrderRecoveryItem = {
  order_id: string;
  state: "recovered" | "complete" | "reconciliation_required" | "skipped" | "write_unconfirmed" | "concurrent";
  reason: "original_delivery_recovered" | "already_complete" | "settlement_unknown" | "settlement_rejected" |
    "fulfillment_missing" | "delivery_draft_missing" | "fulfillment_not_processing" | "raw_artifacts_expired" |
    "order_revoked" | "order_missing" | "evidence_inconsistent" | "evidence_unavailable" | "order_changed" |
    "original_write_unconfirmed" | "original_cas_conflict";
};

export type PaidOrderRecoveryResult = {
  schema: "delta-paid-order-recovery-run/v1";
  run_id: string;
  started_at: string;
  completed_at: string;
  outcome: "success" | "degraded";
  reason: "none" | "orders_require_reconciliation" | "inventory_unavailable" | "inventory_invalid" | "run_deadline" | "cancelled";
  inventory: {
    prefix: "orders/";
    complete: false;
    page_complete: boolean;
    truncated: boolean | null;
    input_cursor: string | null;
    next_cursor: string | null;
  };
  counts: { selected: number; inspected: number; recovered: number; already_complete: number;
    requires_reconciliation: number; skipped: number; conflicts: number; write_unconfirmed: number };
  items: PaidOrderRecoveryItem[];
};

export type PaidOrderRecoveryOptions = { cursor?: string; orderIds?: string[]; maxOrders?: number; deadlineMs?: number; signal?: AbortSignal };

function validCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2_048 && !/[\u0000-\u001f\u007f]/.test(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES_AND_REASONS: Record<PaidOrderRecoveryItem["state"], PaidOrderRecoveryItem["reason"][]> = {
  recovered: ["original_delivery_recovered"], complete: ["already_complete"],
  reconciliation_required: ["settlement_unknown", "settlement_rejected", "fulfillment_missing", "delivery_draft_missing",
    "fulfillment_not_processing", "order_missing", "evidence_inconsistent", "evidence_unavailable", "order_changed", "raw_artifacts_expired", "order_revoked"],
  skipped: ["raw_artifacts_expired", "order_revoked"], write_unconfirmed: ["original_write_unconfirmed"], concurrent: ["original_cas_conflict"],
};
function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

// Stored operational readback must not pass through arbitrary provider text or
// extra fields. This validates a bounded observation, not historical coverage,
// payment receipt, revenue, or permission to execute an order again.
export function validatePaidOrderRecoveryResult(value: unknown): value is PaidOrderRecoveryResult {
  try {
    if (!exactObject(value, ["schema", "run_id", "started_at", "completed_at", "outcome", "reason", "inventory", "counts", "items"]) ||
        value.schema !== "delta-paid-order-recovery-run/v1" || typeof value.run_id !== "string" || !UUID.test(value.run_id) ||
        !iso(value.started_at) || !iso(value.completed_at) || Date.parse(value.completed_at) < Date.parse(value.started_at) ||
        Date.parse(value.completed_at) - Date.parse(value.started_at) > 86_400_000 ||
        typeof value.outcome !== "string" || !["success", "degraded"].includes(value.outcome) ||
        typeof value.reason !== "string" || !["none", "orders_require_reconciliation", "inventory_unavailable", "inventory_invalid", "run_deadline", "cancelled"].includes(value.reason) ||
        !exactObject(value.inventory, ["prefix", "complete", "page_complete", "truncated", "input_cursor", "next_cursor"]) ||
        !exactObject(value.counts, ["selected", "inspected", "recovered", "already_complete", "requires_reconciliation", "skipped", "conflicts", "write_unconfirmed"]) ||
        !Array.isArray(value.items) || value.items.length > 10) return false;
    const inventory = value.inventory, counts = value.counts, items = value.items;
    if (inventory.prefix !== PREFIX || inventory.complete !== false || typeof inventory.page_complete !== "boolean" ||
        inventory.truncated !== null && typeof inventory.truncated !== "boolean" ||
        inventory.input_cursor !== null && !validCursor(inventory.input_cursor) || inventory.next_cursor !== null && !validCursor(inventory.next_cursor) ||
        Object.values(counts).some(count => !Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > 10) ||
        Number(counts.inspected) !== items.length || Number(counts.inspected) > Number(counts.selected) ||
        new Set(items.map(item => item?.order_id)).size !== items.length) return false;
    for (const item of items) {
      if (!exactObject(item, ["order_id", "state", "reason"]) || typeof item.order_id !== "string" || !UUID.test(item.order_id) ||
          typeof item.state !== "string" || !Object.hasOwn(STATES_AND_REASONS, item.state) ||
          typeof item.reason !== "string" || !STATES_AND_REASONS[item.state as PaidOrderRecoveryItem["state"]].includes(item.reason as PaidOrderRecoveryItem["reason"])) return false;
    }
    const total = (state: PaidOrderRecoveryItem["state"]) => items.filter(item => item.state === state).length;
    const reconciliations = total("reconciliation_required") + total("write_unconfirmed") + total("concurrent");
    if (counts.recovered !== total("recovered") || counts.already_complete !== total("complete") || counts.skipped !== total("skipped") ||
        counts.conflicts !== total("concurrent") || counts.write_unconfirmed !== total("write_unconfirmed") || counts.requires_reconciliation !== reconciliations ||
        (value.outcome === "success") !== (value.reason === "none") || value.outcome === "success" && reconciliations !== 0) return false;
    if (!inventory.page_complete) {
      if (inventory.next_cursor !== inventory.input_cursor || value.outcome !== "degraded" ||
          !["inventory_unavailable", "inventory_invalid", "run_deadline", "cancelled"].includes(String(value.reason))) return false;
    } else if (typeof inventory.truncated !== "boolean" || counts.inspected !== counts.selected ||
        inventory.truncated && (!validCursor(inventory.next_cursor) || inventory.next_cursor === inventory.input_cursor) ||
        !inventory.truncated && inventory.next_cursor !== null ||
        value.reason !== (reconciliations > 0 ? "orders_require_reconciliation" : "none")) return false;
    if (inventory.truncated === null && (counts.selected !== 0 || counts.inspected !== 0)) return false;
    return true;
  } catch { return false; }
}

// One bounded inventory page is an observation of selected scoped orders, never
// evidence of complete historical inventory. The caller owns durable scan state.
// Only the existing original-fulfillment CAS may change a business record here.
export async function runPaidOrderRecovery(env: RuntimeEnv, options: PaidOrderRecoveryOptions = {}): Promise<PaidOrderRecoveryResult> {
  const maxOrders = options.maxOrders ?? options.orderIds?.length ?? 5, deadlineMs = options.deadlineMs ?? 60_000;
  if (!Number.isSafeInteger(maxOrders) || maxOrders < 1 || maxOrders > 10 ||
      !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000 ||
      options.cursor !== undefined && !validCursor(options.cursor) ||
      options.orderIds !== undefined && (!Array.isArray(options.orderIds) || options.orderIds.length < 1 || options.orderIds.length > maxOrders ||
        options.orderIds.some(id => typeof id !== "string" || !UUID.test(id)) || new Set(options.orderIds).size !== options.orderIds.length || options.cursor !== undefined)) throw new Error("invalid_paid_order_recovery_options");
  // Reserve a share for inventory/final reporting so a stalled first item does
  // not repeatedly starve every later item on the same opaque inventory page.
  const itemDeadlineMs = Math.max(1, Math.min(PAID_ORDER_RECOVERY_ITEM_MAX_MS, Math.floor(deadlineMs / (maxOrders + 1))));
  const result: PaidOrderRecoveryResult = {
    schema: "delta-paid-order-recovery-run/v1", run_id: crypto.randomUUID(), started_at: new Date().toISOString(),
    completed_at: "", outcome: "success", reason: "none",
    inventory: { prefix: PREFIX, complete: false, page_complete: false, truncated: null,
      input_cursor: options.cursor ?? null, next_cursor: options.cursor ?? null },
    counts: { selected: 0, inspected: 0, recovered: 0, already_complete: 0,
      requires_reconciliation: 0, skipped: 0, conflicts: 0, write_unconfirmed: 0 }, items: [],
  };
  let cancelled = false;
  const snapshots = new Set<ReturnType<typeof createOrderReadSnapshot>>();
  const cancel = () => { cancelled = true; for (const snapshot of snapshots) snapshot.cancel(); };
  const assertActive = () => { if (cancelled || options.signal?.aborted) throw new Error("paid_recovery_cancelled"); };
  const append = (item: PaidOrderRecoveryItem) => {
    assertActive(); result.items.push(item); result.counts.inspected++;
    if (item.state === "recovered") result.counts.recovered++;
    else if (item.state === "complete") result.counts.already_complete++;
    else if (item.state === "skipped") result.counts.skipped++;
    else {
      result.counts.requires_reconciliation++;
      if (item.state === "concurrent") result.counts.conflicts++;
      if (item.state === "write_unconfirmed") result.counts.write_unconfirmed++;
      result.outcome = "degraded"; result.reason = "orders_require_reconciliation";
    }
  };
  const inspect = async (id: string): Promise<PaidOrderRecoveryItem> => {
    const snapshot = createOrderReadSnapshot(env), bounded = snapshot.env;
    let originalCompletionStarted = false;
    snapshots.add(snapshot);
    const item = (state: PaidOrderRecoveryItem["state"], reason: PaidOrderRecoveryItem["reason"]): PaidOrderRecoveryItem => ({ order_id: id, state, reason });
    const assertOriginal = async (order: OrderBinding) => {
      assertActive(); snapshot.assertActive();
      const current = await readOrderBinding(bounded, id);
      assertActive(); snapshot.assertActive();
      if (stableJson(current) !== stableJson(order)) throw new Error("paid_recovery_order_changed");
    };
    try {
      return await withinDeadline((async (): Promise<PaidOrderRecoveryItem> => {
      const order = await readOrderBinding(bounded, id); assertActive();
      if (!order) return item("reconciliation_required", "order_missing");
      // Credential expiry is not a new grant or an excuse to delete a paid
      // obligation. No buyer credential is created/read/extended by this worker.
      // Revoking a credential is not evidence that a paid obligation ended.
      if (order.revoked_at) return item("reconciliation_required", "order_revoked");
      const journal = await readOrderSettlement(bounded, order); assertActive();
      if (journal.state !== "settlement_confirmed") return item("reconciliation_required", journal.state);
      const original = await readFulfillment(bounded, fulfillmentRecordKey(order.payment_fingerprint)); assertActive();
      if ((await orderRetention(order, journal, original)).state === "expired") return item(original?.record.state === "complete" ? "skipped" : "reconciliation_required", "raw_artifacts_expired");
      snapshot.allowArtifactsFor(uuidFromDigest(await sha256(`${order.payment_fingerprint}\n${order.product}`)));
      const entitlement = await readOrderEntitlement(bounded, order); assertActive();
      if (entitlement.settlement.state !== "settlement_confirmed") return item("reconciliation_required", entitlement.settlement.state);
      if ((await orderRetention(order, entitlement.settlement, entitlement.fulfillment)).state === "expired") return item(entitlement.fulfillment?.record.state === "complete" ? "skipped" : "reconciliation_required", "raw_artifacts_expired");
      if (!entitlement.fulfillment) return item("reconciliation_required", "fulfillment_missing");
      if (entitlement.fulfillment.record.state === "complete" && entitlement.delivery) return item("complete", "already_complete");
      if (entitlement.fulfillment.record.state !== "processing") return item("reconciliation_required", "fulfillment_not_processing");
      if (!entitlement.delivery) return item("reconciliation_required", "delivery_draft_missing");
      await assertOriginal(order);
      if ((await orderRetention(order, entitlement.settlement, entitlement.fulfillment)).state === "expired") return item("reconciliation_required", "raw_artifacts_expired");
      assertActive(); snapshot.assertActive();
      originalCompletionStarted = true;
      const recovered = await recoverDelivery(bounded, fulfillmentRecordKey(order.payment_fingerprint), entitlement.fulfillment,
        order.request_body, order.product, order.payment_fingerprint);
      assertActive(); snapshot.assertActive();
      if (!recovered) return item("concurrent", "original_cas_conflict");
      // An acknowledged conditional write is still followed by original state
      // readback; neither a CAS conflict nor an unknown ACK permits a new write.
      await assertOriginal(order);
      const actual = await readOrderEntitlement(bounded, order); assertActive(); snapshot.assertActive();
      return actual.fulfillment?.record.state === "complete" && actual.delivery && stableJson(actual.delivery) === stableJson(recovered)
        ? item("recovered", "original_delivery_recovered") : item("write_unconfirmed", "original_write_unconfirmed");
      })(), itemDeadlineMs, "paid_recovery_item_deadline", snapshot.cancel);
    } catch (error) {
      assertActive();
      if (error instanceof StorageWriteError) return item("write_unconfirmed", "original_write_unconfirmed");
      if (originalCompletionStarted && error instanceof Error && error.message === "paid_recovery_item_deadline") return item("write_unconfirmed", "original_write_unconfirmed");
      if (error instanceof Error && error.message === "paid_recovery_order_changed") return item("reconciliation_required", "order_changed");
      return item("reconciliation_required", error instanceof MetadataReadError || error instanceof Error && error.message === "paid_recovery_item_deadline" ? "evidence_unavailable" : "evidence_inconsistent");
    } finally { snapshot.cancel(); snapshots.delete(snapshot); }
  };
  let rejectAborted: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
  const onAbort = () => { cancel(); rejectAborted?.(new Error("paid_recovery_cancelled")); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    assertActive();
    await withinDeadline(Promise.race([(async () => {
      let page: R2Objects;
      // Priority entries select original identities only. They never become
      // proof of a full inventory or authority to settle/capture anything.
      try { page = options.orderIds ? { objects: options.orderIds.map(id => ({ key: `${PREFIX}${id}.json` })), truncated: false } as R2Objects :
        await env.PROOFS.list({ prefix: PREFIX, limit: maxOrders, ...(options.cursor ? { cursor: options.cursor } : {}) }); }
      catch { assertActive(); result.outcome = "degraded"; result.reason = "inventory_unavailable"; return; }
      assertActive();
      if (!page || !Array.isArray(page.objects) || page.objects.length > maxOrders || typeof page.truncated !== "boolean" ||
          page.objects.some(object => !object || typeof object.key !== "string" || !ORDER_KEY.test(object.key)) ||
          new Set(page.objects.map(object => object.key)).size !== page.objects.length ||
          "delimitedPrefixes" in page && (!Array.isArray(page.delimitedPrefixes) || page.delimitedPrefixes.length !== 0) ||
          page.truncated && (!validCursor(page.cursor) || page.cursor === options.cursor) ||
          !page.truncated && "cursor" in page && page.cursor !== undefined) {
        result.outcome = "degraded"; result.reason = "inventory_invalid"; return;
      }
      result.inventory.truncated = page.truncated;
      result.counts.selected = page.objects.length;
      for (const object of page.objects) { assertActive(); append(await inspect(ORDER_KEY.exec(object.key)![1])); }
      assertActive();
      result.inventory.page_complete = true;
      // null after the last page means a future pass starts at the first page.
      // Timeout/invalid/partial pages retain their original input cursor.
      result.inventory.next_cursor = page.truncated ? page.cursor : null;
    })(), aborted]), deadlineMs, "paid_recovery_run_deadline", cancel);
  } catch (error) {
    result.outcome = "degraded";
    result.reason = options.signal?.aborted ? "cancelled" : error instanceof Error && error.message === "paid_recovery_run_deadline" ? "run_deadline" : "inventory_unavailable";
  } finally { cancel(); options.signal?.removeEventListener("abort", onAbort); }
  result.completed_at = new Date().toISOString();
  return result;
}
