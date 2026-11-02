import { HTTPFacilitatorClient, FacilitatorResponseError, FacilitatorTimeoutError, type FacilitatorClient } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import type { RuntimeEnv } from "./env";
import { sha256, stableJson, uuidFromDigest } from "./crypto";
import { createRetentionSnapshot } from "./retention";
import { bindOrder, orderAuthorityDigest, type OrderBinding, type OrderEnrollment, type OrderPaymentBinding } from "./orders";
import type { PaidRequest } from "./fulfillment";
import { readOrderMetadata, StorageWriteError, writeOrderObject } from "./order-storage";

export type SettlementRecord = {
  schema: "delta-settlement/v1";
  state: "settlement_unknown" | "settlement_rejected" | "settlement_confirmed";
  request_hash: string;
  payment_fingerprint: string;
  amount: string;
  order_id?: string;
  order_binding_hash?: string;
  updated_at: string;
  confirmed_at?: string;
  result?: SettleResponse;
  failure_class?: string;
  transaction_hint?: string;
  transaction_hint_network?: string;
};

function transactionHint(value: unknown, network: string) {
  if (!value || typeof value !== "object" || !("transaction" in value) || !("network" in value)) return {};
  return typeof value.transaction === "string" && /^0x[0-9a-f]{64}$/i.test(value.transaction) && value.network === network
    ? { transaction_hint: value.transaction, transaction_hint_network: network } : {};
}

function facilitatorFailure(error: unknown): string {
  if (error instanceof FacilitatorTimeoutError) return "timeout";
  if (error instanceof FacilitatorResponseError) return "malformed_response";
  const code = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : undefined;
  const status = code ?? (error instanceof Error ? Number(/^Facilitator (?:settle|verify|getSupported) failed \(([1-5][0-9]{2})\):/.exec(error.message)?.[1]) : NaN);
  if (Number.isInteger(status) && status! >= 100 && status! <= 599) return `upstream_http_${status}`;
  return "cause_unknown";
}

const CANONICAL_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
function sameAddress(left: unknown, right: unknown): boolean {
  return typeof left === "string" && typeof right === "string" && /^0x[0-9a-f]{40}$/i.test(left) && left.toLowerCase() === right.toLowerCase();
}

function authorizationMatches(payload: PaymentPayload, requirements: PaymentRequirements): boolean {
  const authorization = payload.payload.authorization as Record<string, unknown> | undefined;
  const permit = payload.payload.permit2Authorization as { from?: unknown; permitted?: { token?: unknown; amount?: unknown }; witness?: { to?: unknown } } | undefined;
  const value = authorization?.value ?? permit?.permitted?.amount;
  return typeof value === "string" && /^\d+$/.test(value) && /^\d+$/.test(requirements.amount) && BigInt(value) === BigInt(requirements.amount) &&
    sameAddress(authorization?.to ?? permit?.witness?.to, requirements.payTo) &&
    (authorization !== undefined || sameAddress(permit?.permitted?.token, requirements.asset));
}

// This is structural binding to the server's advertised resource and quote.
// The facilitator remains responsible for cryptographic/on-chain verification.
export function validatePaymentBinding(env: RuntimeEnv, header: string, resource: string, amount: string): void {
  const payload = decodePaymentSignatureHeader(header);
  if (payload.x402Version !== 2 || payload.resource?.url !== resource || payload.accepted.scheme !== "exact" || payload.accepted.network !== env.NETWORK ||
    !sameAddress(payload.accepted.asset, CANONICAL_USDC) || !sameAddress(payload.accepted.payTo, env.PAY_TO) || payload.accepted.amount !== amount ||
    !authorizationMatches(payload, payload.accepted)) throw new Error("payment_request_binding_mismatch");
}

function receiptMatches(result: SettleResponse, payload: PaymentPayload, requirements: PaymentRequirements): boolean {
  const authorization = (payload.payload.authorization ?? payload.payload.permit2Authorization) as { from?: unknown };
  return result.success === true && /^0x[0-9a-f]{64}$/i.test(result.transaction) && result.network === requirements.network &&
    (result.amount === undefined || result.amount === requirements.amount) &&
    (result.payer === undefined || sameAddress(result.payer, authorization.from));
}

// Lock the on-chain authorization, not a JSON/base64 representation of it.
// These fields are identity only; the facilitator still verifies the signature.
async function settlementKey(payload: PaymentPayload): Promise<string> {
  const authorization = payload.payload.authorization ?? payload.payload.permit2Authorization;
  if (!authorization || typeof authorization !== "object") throw new Error("settlement_identity_invalid");
  const { from, nonce } = authorization as Record<string, unknown>;
  if (typeof from !== "string" || !/^0x[0-9a-f]{40}$/i.test(from) || typeof nonce !== "string" || !/^(0x[0-9a-f]+|[0-9]+)$/i.test(nonce)) {
    throw new Error("settlement_identity_invalid");
  }
  const identity = [payload.accepted.network, payload.payload.authorization ? payload.accepted.asset.toLowerCase() : "permit2", from.toLowerCase(), BigInt(nonce).toString()];
  return `settlements/${(await sha256(stableJson(identity))).slice(7)}.json`;
}

export async function readSettlement(env: RuntimeEnv, header: string, allowUnstructuredLegacy = false): Promise<SettlementRecord | null> {
  // Legacy completed deliveries are checked first by callers, so they do not
  // require a new settlement identity or any change to historical records.
  let payload: PaymentPayload, key: string;
  try {
    payload = decodePaymentSignatureHeader(header);
    key = await settlementKey(payload);
  } catch (error) {
    // Only an already completed exact-header legacy replay may lack a semantic
    // identity. Storage/receipt errors below must never be swallowed here.
    if (allowUnstructuredLegacy) return null;
    throw error;
  }
  const stored = await readOrderMetadata<SettlementRecord>(env, key);
  if (!stored) return null;
  const { record } = stored;
  if (record.schema !== "delta-settlement/v1" || !["settlement_unknown", "settlement_rejected", "settlement_confirmed"].includes(record.state)) throw new Error("invalid_settlement_record");
  if (record.state === "settlement_confirmed" && (!record.result || !receiptMatches(record.result, payload, payload.accepted) || record.result.network !== env.NETWORK || record.amount !== payload.accepted.amount || !/^\d+$/.test(record.amount) || !Number.isSafeInteger(Number(record.amount)) || Number(record.amount) <= 0)) throw new Error("invalid_settlement_record");
  return record;
}

export async function readOrderSettlement(env: RuntimeEnv, order: OrderBinding): Promise<SettlementRecord> {
  const stored = await readOrderMetadata<SettlementRecord>(env, order.settlement_key);
  if (!stored) throw new Error("order_evidence_inconsistent");
  const { record } = stored;
  if (!record || record.schema !== "delta-settlement/v1" || record.order_id !== order.order_id ||
      record.order_binding_hash !== await orderAuthorityDigest(order) ||
      record.request_hash !== order.request_hash || record.payment_fingerprint !== order.payment_fingerprint ||
      record.amount !== order.amount || !["settlement_unknown", "settlement_rejected", "settlement_confirmed"].includes(record.state)) throw new Error("order_evidence_inconsistent");
  if (record.state === "settlement_confirmed" && (!record.result || record.result.success !== true ||
      !/^0x[0-9a-f]{64}$/i.test(record.result.transaction) || record.result.network !== order.network ||
      (record.result.amount !== undefined && record.result.amount !== order.amount) ||
      (record.result.payer !== undefined && !sameAddress(record.result.payer, order.payer)))) throw new Error("order_evidence_inconsistent");
  return record;
}

export type SettlementOrder = { enrollment: OrderEnrollment; product: "capture" | "preflight"; resource: string; request_body: PaidRequest };

export function guardedFacilitator(env: RuntimeEnv, requestHash: string, paymentFingerprint: string, order?: SettlementOrder) {
  const upstream = new HTTPFacilitatorClient({ url: env.FACILITATOR_URL, timeoutMs: 30_000 });
  let blocked: "settlement_unknown" | "settlement_rejected" | "settlement_identity_conflict" | undefined;
  const client: FacilitatorClient = {
    async getSupported() {
      try { return await upstream.getSupported(); } catch (error) { throw new Error(facilitatorFailure(error)); }
    },
    async verify(payload, requirements) {
      try { return await upstream.verify(payload, requirements); } catch (error) { throw new Error(facilitatorFailure(error)); }
    },
    async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
      if (!authorizationMatches(payload, requirements)) throw new Error("payment_request_binding_mismatch");
      const key = await settlementKey(payload);
      const authorization = (payload.payload.authorization ?? payload.payload.permit2Authorization) as { from: string };
      const orderPayment: OrderPaymentBinding | undefined = order ? {
        product: order.product, resource: order.resource, request_body: order.request_body, request_hash: requestHash,
        payment_fingerprint: paymentFingerprint, settlement_key: key, network: requirements.network,
        asset: requirements.asset, pay_to: requirements.payTo, payer: authorization.from, amount: requirements.amount,
      } : undefined;
      if (order?.enrollment.retention_policy && orderPayment) orderPayment.retention_snapshot = await createRetentionSnapshot(order.enrollment.retention_policy, {
        order_id: order.enrollment.order_id, tenant_id: "direct", proof_id: uuidFromDigest(await sha256(`${paymentFingerprint}\n${order.product}`)),
        payment_fingerprint: paymentFingerprint, purchased_at: order.enrollment.created_at,
      });
      const failure = (): SettleResponse => ({ success: false, errorReason: blocked, transaction: "", network: requirements.network });
      const existing = await readOrderMetadata<SettlementRecord>(env, key);
      if (existing) {
        const { record } = existing;
        if (record.request_hash !== requestHash || record.payment_fingerprint !== paymentFingerprint || (order && record.order_id !== order.enrollment.order_id)) blocked = "settlement_identity_conflict";
        else if (record.schema === "delta-settlement/v1" && record.state === "settlement_confirmed" && record.amount === requirements.amount && record.result && receiptMatches(record.result, payload, requirements)) return record.result;
        else blocked = record.state === "settlement_rejected" ? "settlement_rejected" : "settlement_unknown";
        return failure();
      }
      if (order) {
        // x402 upfront mode deliberately skips verify. A recovery capability
        // must not be enrolled for an unverified/publicly forged payment.
        let verified;
        try { verified = await upstream.verify(payload, requirements); }
        catch (error) { throw new Error(facilitatorFailure(error)); }
        if (!verified.isValid) return { success: false, errorReason: "payment_verification_failed", transaction: "", network: requirements.network };
      }
      const record: SettlementRecord = {
        schema: "delta-settlement/v1", state: "settlement_unknown", request_hash: requestHash,
        payment_fingerprint: paymentFingerprint, amount: requirements.amount, updated_at: new Date().toISOString(),
        ...(order && orderPayment ? { order_id: order.enrollment.order_id, order_binding_hash: await orderAuthorityDigest({ ...order.enrollment, ...orderPayment, scope: ["status", "recover", "export"] }) } : {}),
      };
      // This durable reservation has no expiry. A timed-out POST may have settled.
      // Unknown outcomes require receipt reconciliation; never retry that POST.
      let reserved;
      try {
        reserved = await writeOrderObject(env, key, JSON.stringify(record), {
          onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" },
        });
      } catch { blocked = "settlement_unknown"; return failure(); }
      if (!reserved) { blocked = "settlement_unknown"; return failure(); }
      try {
        // Claim entitlement only at the first verified authorization reservation.
        // An old/public payment signature can never mint a replacement capability.
        if (order && orderPayment) await bindOrder(env, order.enrollment, orderPayment);
        const result = await upstream.settle(payload, requirements);
        if (receiptMatches(result, payload, requirements)) {
          const confirmedAt = new Date().toISOString();
          const saved = await writeOrderObject(env, key, JSON.stringify({ ...record, state: "settlement_confirmed", result, updated_at: confirmedAt, confirmed_at: confirmedAt }), {
            onlyIf: { etagMatches: reserved.etag }, httpMetadata: { contentType: "application/json" },
          });
          if (saved) return result;
        } else if (result.success === false) {
          // success:false also covers pending/broadcast transactions. It alone
          // is not evidence of a terminal rejection or permission to submit again.
          await writeOrderObject(env, key, JSON.stringify({ ...record, failure_class: "reported_failure_unconfirmed", ...transactionHint(result, requirements.network), updated_at: new Date().toISOString() }), {
            onlyIf: { etagMatches: reserved.etag }, httpMetadata: { contentType: "application/json" },
          });
          blocked = "settlement_unknown";
          return failure();
        } else {
          await writeOrderObject(env, key, JSON.stringify({ ...record, failure_class: "receipt_binding_mismatch", ...transactionHint(result, requirements.network) }), {
            onlyIf: { etagMatches: reserved.etag }, httpMetadata: { contentType: "application/json" },
          });
        }
      } catch (error) {
        // A confirmation/binding write can commit after its ACK is lost. Keep
        // the original reservation; do not race it with a failure rewrite.
        if (error instanceof StorageWriteError) { blocked = "settlement_unknown"; return failure(); }
        // Do not persist/log facilitator bodies, signatures, headers or raw errors.
        try {
          await writeOrderObject(env, key, JSON.stringify({ ...record, failure_class: facilitatorFailure(error), ...transactionHint(error, requirements.network) }), {
            onlyIf: { etagMatches: reserved.etag }, httpMetadata: { contentType: "application/json" },
          });
        } catch { /* The original durable unknown record remains the safety gate. */ }
      }
      blocked = "settlement_unknown";
      return failure();
    },
  };
  return { client, blocked: () => blocked };
}

export function settlementBlockedBody(state: string) {
  return { ok: false, error: state, state, retryable: false, requires_settlement_reconciliation: true };
}
