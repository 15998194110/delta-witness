import type { RuntimeEnv } from "./env";
import { sha256, stableJson, uuidFromDigest } from "./crypto";
import { paidRequestHash, parseCaptureRequest, parsePreflightRequest, readFulfillment, fulfillmentRecordKey, verifiedDelivery, recoverDelivery, type PaidRequest, type StoredFulfillment, type DeliveryResponse } from "./fulfillment";
import { readOrderSettlement, type SettlementRecord } from "./settlement";
import { withinDeadline } from "./deadline";
import { createOrderReadSnapshot, readOrderMetadata, writeOrderObject } from "./order-storage";
import { deliveryDigest } from "./fulfillment";
import { parseRetentionPolicy, verifyRetentionSnapshot, evaluateRetention, type RetentionPolicy, type RetentionSnapshot } from "./retention";

export const ORDER_ID_HEADER = "x-delta-order-id";
export const ORDER_TOKEN_HEADER = "x-delta-recovery-token";
const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SETTLEMENT_KEY = /^settlements\/[0-9a-f]{64}\.json$/;

export class OrderAccessError extends Error {
  constructor(public readonly code: string, public readonly status: 400 | 403 | 404 | 409 | 410 | 503) { super(code); }
}

export type OrderEnrollment = { order_id: string; token_digest: string; ttl_seconds: number; created_at: string; expires_at: string; retention_policy?: RetentionPolicy };
export type OrderBinding = {
  schema: "delta-order-binding/v1";
  order_id: string;
  token_digest: string;
  scope: Array<"status" | "recover" | "export">;
  created_at: string;
  expires_at: string;
  revoked_at?: string;
  product: "capture" | "preflight";
  resource: string;
  request_hash: string;
  request_body: PaidRequest;
  payment_fingerprint: string;
  settlement_key: string;
  network: string;
  asset: string;
  pay_to: string;
  payer: string;
  amount: string;
  retention_snapshot?: RetentionSnapshot;
};
export type OrderPaymentBinding = Omit<OrderBinding, "schema" | "order_id" | "token_digest" | "scope" | "created_at" | "expires_at" | "revoked_at">;

function validToken(token: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  try {
    const bytes = atob(token.replaceAll("-", "+").replaceAll("_", "/") + "=");
    return bytes.length === 32 && btoa(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") === token;
  } catch { return false; }
}

async function tokenDigest(id: string, token: string): Promise<string> {
  return sha256(`delta-order-token/v1\n${id}\n${token}`);
}

function sameDigest(left: string, right: string): boolean {
  if (!DIGEST.test(left) || !DIGEST.test(right)) return false;
  let different = 0;
  for (let index = 0; index < 71; index++) different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return different === 0;
}

export function orderRecordKey(id: string): string {
  if (!ORDER_ID.test(id)) throw new OrderAccessError("order_unavailable", 404);
  return `orders/${id.toLowerCase()}.json`;
}

// A capability is opt-in. No production retention/authentication policy is
// invented: operators must explicitly configure the credential lifetime.
export function orderRecoveryDisclosure(env: RuntimeEnv) {
  const configured = env.ORDER_RECOVERY_TTL_SECONDS;
  const ttl = configured && /^[0-9]+$/.test(configured) ? Number(configured) : NaN;
  const enabled = Number.isSafeInteger(ttl) && ttl >= 60 && ttl <= 604800;
  return { schema: 'delta-order-recovery/v1', enabled, credential_ttl_seconds: enabled ? ttl : null,
    products: ['capture', 'preflight'], credential_storage: 'buyer_private', payment_on_recovery: false };
}

export async function parseOrderEnrollment(request: Request, env: RuntimeEnv): Promise<OrderEnrollment | undefined> {
  const id = request.headers.get(ORDER_ID_HEADER);
  const token = request.headers.get(ORDER_TOKEN_HEADER);
  if (id === null && token === null) return undefined;
  if (!id || !token || !ORDER_ID.test(id) || !validToken(token)) throw new OrderAccessError("invalid_order_credentials", 400);
  const digest = await tokenDigest(id.toLowerCase(), token), now = Date.now();
  // A rollback of new-enrollment configuration must not revoke an existing
  // credential or replace its purchased expiry. Original journal validation
  // still takes place in assertOrderReplay before any completed result is used.
  const previous = await readOrderBinding(env, id.toLowerCase(), digest);
  if (previous) {
    if (!sameDigest(digest, previous.token_digest)) throw new OrderAccessError('order_unavailable', 404);
    assertActive(previous);
    return { order_id: previous.order_id, token_digest: digest,
      ttl_seconds: (Date.parse(previous.expires_at) - Date.parse(previous.created_at)) / 1000,
      created_at: previous.created_at, expires_at: previous.expires_at };
  }
  const ttl = orderRecoveryDisclosure(env).credential_ttl_seconds;
  if (ttl === null) throw new OrderAccessError("order_recovery_not_configured", 503);
  // Existing orders keep their purchased policy even when current terms change.
  let policy: RetentionPolicy | undefined;
  if (!previous) {
    try { policy = parseRetentionPolicy(env.RETENTION_POLICY_JSON); }
    catch { throw new OrderAccessError("retention_policy_unavailable", 503); }
    if (policy && (request.headers.has("payment-signature") || request.headers.has("x-payment")) &&
        request.headers.get("x-delta-retention-policy-hash") !== await sha256(stableJson(policy))) {
      throw new OrderAccessError("retention_terms_changed", 409);
    }
  }
  return { order_id: id.toLowerCase(), token_digest: digest, ttl_seconds: ttl,
    created_at: new Date(now).toISOString(), expires_at: new Date(now + ttl * 1000).toISOString(), ...(policy ? { retention_policy: policy } : {}) };
}

export async function readOrderBinding(env: RuntimeEnv, id: string, expectedTokenDigest?: string): Promise<OrderBinding | null> {
  const stored = await readOrderMetadata<OrderBinding>(env, orderRecordKey(id));
  if (!stored) return null;
  try {
  const record = stored.record;
  if (expectedTokenDigest && (!record || !sameDigest(expectedTokenDigest, record.token_digest))) throw new OrderAccessError("order_unavailable", 404);
  if (!record || record.schema !== "delta-order-binding/v1" || record.order_id !== id.toLowerCase() || !DIGEST.test(record.token_digest) ||
      !DIGEST.test(record.request_hash) || !DIGEST.test(record.payment_fingerprint) || !SETTLEMENT_KEY.test(record.settlement_key) ||
      !["capture", "preflight"].includes(record.product) || !['["status","recover"]','["status","recover","export"]'].includes(stableJson(record.scope)) ||
      typeof record.network !== "string" || !/^eip155:[0-9]+$/.test(record.network) ||
      ![record.asset,record.pay_to,record.payer].every((value) => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value)) ||
      typeof record.amount !== "string" || !/^[1-9][0-9]*$/.test(record.amount) || !Number.isSafeInteger(Number(record.amount)) ||
      typeof record.resource !== "string" || !record.resource.endsWith(`/v1/${record.product}`) ||
      !Number.isFinite(Date.parse(record.created_at)) || !Number.isFinite(Date.parse(record.expires_at)) ||
      Date.parse(record.expires_at) <= Date.parse(record.created_at)) throw new OrderAccessError("order_evidence_inconsistent", 503);
  const request = record.product === "capture" ? parseCaptureRequest(record.request_body) : parsePreflightRequest(record.request_body);
  if (await paidRequestHash(`/v1/${record.product}`, request) !== record.request_hash || stableJson(request) !== stableJson(record.request_body)) {
    throw new OrderAccessError("order_evidence_inconsistent", 503);
  }
  return record;
  } catch (error) {
    if (error instanceof OrderAccessError) throw error;
    throw new OrderAccessError(expectedTokenDigest ? "order_unavailable" : "order_evidence_inconsistent", expectedTokenDigest ? 404 : 503);
  }
}

function assertActive(record: OrderBinding): void {
  if (record.revoked_at) throw new OrderAccessError("order_unavailable", 404);
  if (Date.now() >= Date.parse(record.expires_at)) throw new OrderAccessError("order_capability_expired", 410);
}

export async function authenticateOrder(env: RuntimeEnv, id: string, request: Request): Promise<OrderBinding> {
  if (new URL(request.url).search) throw new OrderAccessError("order_unavailable", 404);
  const token = request.headers.get(ORDER_TOKEN_HEADER);
  if (!ORDER_ID.test(id) || !token || !validToken(token)) throw new OrderAccessError("order_unavailable", 404);
  const record = await readOrderBinding(env, id.toLowerCase(), await tokenDigest(id.toLowerCase(), token));
  if (!record || !sameDigest(await tokenDigest(id.toLowerCase(), token), record.token_digest)) throw new OrderAccessError("order_unavailable", 404);
  // Expiry is disclosed only after the token matches, never to an enumerator.
  assertActive(record);
  return record;
}

export async function assertOrderReplay(env: RuntimeEnv, enrollment: OrderEnrollment, expected: {
  product: "capture" | "preflight"; request_hash: string; payment_fingerprint: string;
}, settlement: { order_id?: string } | null, hasFulfillment: boolean): Promise<void> {
  const record = await readOrderBinding(env, enrollment.order_id, enrollment.token_digest);
  if (!record) {
    if (settlement || hasFulfillment) throw new OrderAccessError("order_enrollment_not_available", 409);
    return;
  }
  if (!sameDigest(enrollment.token_digest, record.token_digest)) throw new OrderAccessError("order_unavailable", 404);
  assertActive(record);
  if (record.product !== expected.product || record.request_hash !== expected.request_hash || record.payment_fingerprint !== expected.payment_fingerprint) {
    throw new OrderAccessError("order_identity_conflict", 409);
  }
  if (!settlement || settlement.order_id !== record.order_id) throw new OrderAccessError("order_evidence_inconsistent", 503);
  try { await readOrderSettlement(env, record); }
  catch { throw new OrderAccessError("order_evidence_inconsistent", 503); }
}

// Only called after a verified payment has won the first settlement journal CAS.
// The immutable journal.order_id, not this index, is entitlement authority.
export async function bindOrder(env: RuntimeEnv, enrollment: OrderEnrollment, payment: OrderPaymentBinding): Promise<OrderBinding> {
  const record: OrderBinding = {
    schema: "delta-order-binding/v1", order_id: enrollment.order_id, token_digest: enrollment.token_digest,
    scope: ["status", "recover", "export"], created_at: enrollment.created_at,
    expires_at: enrollment.expires_at, ...payment,
  };
  assertActive(record);
  const saved = await writeOrderObject(env, orderRecordKey(record.order_id), JSON.stringify(record), {
    onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  if (saved) return record;
  const previous = await readOrderBinding(env, record.order_id);
  if (!previous || !sameDigest(previous.token_digest, record.token_digest) ||
      previous.request_hash !== record.request_hash || previous.payment_fingerprint !== record.payment_fingerprint ||
      previous.settlement_key !== record.settlement_key || previous.product !== record.product || previous.resource !== record.resource) {
    throw new OrderAccessError("order_identity_conflict", 409);
  }
  assertActive(previous);
  return previous;
}

export async function orderAuthorityDigest(order: Pick<OrderBinding, "order_id" | "token_digest" | "scope" | "created_at" | "expires_at"> & OrderPaymentBinding): Promise<string> {
  const { order_id, token_digest, product, resource, request_hash, request_body, payment_fingerprint, settlement_key, network, asset, pay_to, payer, amount } = order;
  return sha256(stableJson({ order_id, token_digest, scope: order.scope, created_at: order.created_at, expires_at: order.expires_at,
    product, resource, request_hash, request_body, payment_fingerprint, settlement_key, network, asset, pay_to, payer, amount,
    ...(order.retention_snapshot ? { retention_snapshot: order.retention_snapshot } : {}) }));
}

export async function orderRetention(order: OrderBinding, settlement: SettlementRecord, fulfillment: StoredFulfillment | null) {
  const snapshot = order.retention_snapshot;
  if (snapshot) {
    await verifyRetentionSnapshot(snapshot, snapshot.snapshot_hash);
    const proofId = uuidFromDigest(await sha256(`${order.payment_fingerprint}\n${order.product}`));
    if (snapshot.order_id !== order.order_id || snapshot.tenant_id !== "direct" || snapshot.proof_id !== proofId ||
        snapshot.payment_fingerprint !== order.payment_fingerprint || snapshot.purchased_at !== order.created_at) throw new OrderAccessError("order_evidence_inconsistent", 503);
    if (settlement.state === "settlement_confirmed" && !settlement.confirmed_at) throw new OrderAccessError("order_evidence_inconsistent", 503);
    if (fulfillment) {
      const record = fulfillment.record;
      if (record.route !== `/v1/${order.product}` || record.request_hash !== order.request_hash || record.payment_fingerprint !== order.payment_fingerprint ||
          record.fulfillment_fingerprint !== order.payment_fingerprint || record.requested_url !== order.request_body.url || record.partner ||
          record.paid_price_usd !== Number(order.amount) / 1_000_000 ||
          (record.response && record.response_hash !== await deliveryDigest(record, record.response))) throw new OrderAccessError("order_evidence_inconsistent", 503);
    }
  }
  return evaluateRetention(snapshot, {
    ...(settlement.state === "settlement_confirmed" && settlement.confirmed_at ? { settlement_confirmed_at: settlement.confirmed_at } : {}),
    ...(fulfillment?.record.state === "complete" && fulfillment.record.completed_at ? { fulfillment_completed_at: fulfillment.record.completed_at } : {}),
  }, new Date().toISOString());
}

export async function retentionDisclosure(env: RuntimeEnv) {
  const policy = parseRetentionPolicy(env.RETENTION_POLICY_JSON);
  return policy ? { scope: "new_scoped_capture_preflight_orders", policy, policy_hash: await sha256(stableJson(policy)),
    acceptance_header: "x-delta-retention-policy-hash", credential_expiry_is_independent: true } : null;
}

export type OrderEntitlement = { settlement: SettlementRecord; fulfillment: StoredFulfillment | null; delivery?: DeliveryResponse };
// Bindings are indexes, never standalone proof of paid entitlement. The original
// journal owns the order, and the original complete bundle owns delivery facts.
export async function readOrderEntitlement(env: RuntimeEnv, order: OrderBinding): Promise<OrderEntitlement> {
  const settlement = await readOrderSettlement(env, order);
  const fulfillment = await readFulfillment(env, fulfillmentRecordKey(order.payment_fingerprint));
  if (!fulfillment) return { settlement, fulfillment };
  const record = fulfillment.record;
  if (record.response && (!("response_hash" in record) || typeof record.response_hash !== "string" || !DIGEST.test(record.response_hash))) {
    throw new OrderAccessError("order_evidence_inconsistent", 503);
  }
  if (settlement.state !== "settlement_confirmed" || record.route !== `/v1/${order.product}` ||
      record.request_hash !== order.request_hash || record.requested_url !== order.request_body.url ||
      record.payment_fingerprint !== order.payment_fingerprint || record.fulfillment_fingerprint !== order.payment_fingerprint ||
      record.paid_price_usd !== Number(order.amount) / 1_000_000 || record.partner ||
      !["processing", "retryable_failure", "blocked_failure", "complete"].includes(record.state)) throw new OrderAccessError("order_evidence_inconsistent", 503);
  const delivery = await verifiedDelivery(env, fulfillment, order.request_body, order.product, order.payment_fingerprint);
  if (record.response && !delivery || record.state === "complete" && !delivery) throw new OrderAccessError("order_evidence_inconsistent", 503);
  return { settlement, fulfillment, ...(delivery ? { delivery } : {}) };
}

export function orderPrivateHeaders(env: RuntimeEnv, request: Request): Headers {
  const headers = new Headers({ "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow", vary: "Origin" });
  const origin = request.headers.get("origin");
  const trusted = [env.PUBLIC_ORIGIN || "https://delta-witness-api.ruphussten.workers.dev", "https://delta-witness-app.pages.dev"].map((url) => new URL(url).origin);
  if (origin && !trusted.includes(origin)) throw new OrderAccessError("order_unavailable", 404);
  if (origin) headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, x-delta-recovery-token, x-delta-channel");
  return headers;
}

export async function orderStatusResponse(env: RuntimeEnv, request: Request, id?: string, recover = false): Promise<Response> {
  let headers = new Headers({ "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow", vary: "Origin" });
  const snapshot = createOrderReadSnapshot(env), boundedEnv = snapshot.env;
  const assertCurrent = async (order: OrderBinding) => {
    snapshot.assertActive();
    const current = await authenticateOrder(boundedEnv, id ?? "", request);
    snapshot.assertActive();
    if (stableJson(current) !== stableJson(order)) throw new OrderAccessError("order_evidence_unavailable", 503);
  };
  try {
    headers = orderPrivateHeaders(env, request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    return await withinDeadline((async () => {
      const order = await authenticateOrder(boundedEnv, id ?? "", request);
      if (!order.scope.includes(recover ? "recover" : "status")) throw new OrderAccessError("order_scope_forbidden", 403);
      if (request.headers.has("payment-signature") || request.headers.has("x-payment") || request.body !== null) throw new OrderAccessError("order_recovery_input_forbidden", 400);
      snapshot.allowArtifactsFor(uuidFromDigest(await sha256(`${order.payment_fingerprint}\n${order.product}`)));
      const journal = await readOrderSettlement(boundedEnv, order);
      const original = await readFulfillment(boundedEnv, fulfillmentRecordKey(order.payment_fingerprint));
      const retention = await orderRetention(order, journal, original);
      if (retention.state === "expired") {
        await assertCurrent(order);
        return Response.json({ ok: true, order_id: order.order_id, product: order.product, state: "raw_artifacts_expired",
          payment: { state: journal.state, treasury_received: null }, retention,
          fulfillment: { state: original?.record.state ?? "not_started" },
          recovery: { expires_at: order.expires_at, can_recover: false } }, { status: 200, headers });
      }
      let entitlement = await readOrderEntitlement(boundedEnv, order);
      if (recover && entitlement.fulfillment?.record.state === "processing" && entitlement.delivery) {
        await assertCurrent(order);
        await recoverDelivery(boundedEnv, fulfillmentRecordKey(order.payment_fingerprint), entitlement.fulfillment, order.request_body, order.product, order.payment_fingerprint);
        entitlement = await readOrderEntitlement(boundedEnv, order);
      }
      await assertCurrent(order);
      const complete = entitlement.fulfillment?.record.state === "complete" && Boolean(entitlement.delivery);
      const available = !complete && Boolean(entitlement.delivery);
      const state = complete ? "complete" : available ? "recovery_available" : entitlement.fulfillment?.record.state ?? entitlement.settlement.state;
      return Response.json({ ok: true, order_id: order.order_id, product: order.product, state,
        payment: { state: entitlement.settlement.state, treasury_received: null },
        fulfillment: { state: available ? "recovery_available" : entitlement.fulfillment?.record.state ?? "not_started" },
        recovery: { expires_at: order.expires_at, can_recover: available },
        retention: await orderRetention(order, entitlement.settlement, entitlement.fulfillment),
        ...(complete ? { delivery: entitlement.delivery } : { reconciliation_required: true }),
      }, { status: complete ? 200 : 202, headers });
    })(), 15_000, "order_evidence_unavailable", snapshot.cancel);
  } catch (error) {
    const status = error instanceof OrderAccessError ? error.status : 503;
    const code = error instanceof OrderAccessError ? error.code : "order_evidence_unavailable";
    return Response.json({ ok: false, state: status === 404 ? "order_unknown" : code, error: code }, { status, headers });
  } finally { snapshot.cancel(); }
}
