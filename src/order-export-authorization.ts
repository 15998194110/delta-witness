import type { RuntimeEnv } from './env';
import { sha256, stableJson, uuidFromDigest } from './crypto';
import { withinDeadline } from './deadline';
import { createOrderReadSnapshot, readOrderMetadata, writeOrderObject } from './order-storage';
import { authenticateOrder, OrderAccessError, orderAuthorityDigest, orderPrivateHeaders, orderRecordKey,
  orderRetention, readOrderEntitlement, tokenDigest, validToken, type OrderBinding, type OrderExportAuthorization } from './orders';
import { readOrderSettlement } from './settlement';

export const EXPORT_AUTHORIZATION_TIMEOUT_MS = 15_000;
const MAX_INPUT_BYTES = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Input = { operation_id: string; token: string; ttl_seconds: number; expected_generation: number };

function metadata(order: OrderBinding) {
  const value = order.export_authorization;
  return { ok: true, order_id: order.order_id, authorization: value ? {
    operation_id: value.operation_id, generation: value.generation, expires_at: value.expires_at,
    scope: ['export'], state: Date.now() >= Date.parse(value.expires_at) ? 'expired' : 'active',
  } : null };
}

// Original root authority manages a mutable, export-only credential. It never
// renews the original purchased capability, journal, obligation or retention.
export async function orderExportAuthorizationResponse(env: RuntimeEnv, id: string, request: Request): Promise<Response> {
  let headers = new Headers({ 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow', vary: 'Origin, x-delta-recovery-token' });
  const snapshot = createOrderReadSnapshot(env), bounded = snapshot.env;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => {
    snapshot.cancel();
    if (reader) void reader.cancel().catch(() => {});
    else if (request.body && !request.body.locked) void request.body.cancel().catch(() => {});
  };
  const fail = (code: string, status: 400 | 403 | 404 | 409 | 410 | 503): never => { throw new OrderAccessError(code, status); };
  const reply = (order: OrderBinding, status = 200) => Response.json(metadata(order), { status, headers });
  try {
    headers = orderPrivateHeaders(env, request);
    headers.set('vary', 'Origin, x-delta-recovery-token');
    headers.set('referrer-policy', 'no-referrer');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    return await withinDeadline((async () => {
      if (!['GET', 'POST'].includes(request.method) || request.headers.has('payment-signature') || request.headers.has('x-payment')) fail('order_export_authorization_input_forbidden', 400);
      const order = await authenticateOrder(bounded, id, request);
      if (!order.scope.includes('export')) fail('order_export_not_authorized', 403);
      // An order index is not independently sufficient entitlement authority.
      await readOrderSettlement(bounded, order);
      snapshot.assertActive();
      if (request.method === 'GET') {
        if (request.body !== null) fail('order_export_authorization_input_forbidden', 400);
        const current = await authenticateOrder(bounded, id, request);
        snapshot.assertActive();
        if (stableJson(current) !== stableJson(order)) fail('order_export_authorization_conflict', 409);
        return reply(current);
      }
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !request.body) fail('invalid_export_authorization_request', 400);
      const contentLength = request.headers.get('content-length');
      if (contentLength !== null && (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > MAX_INPUT_BYTES)) fail('invalid_export_authorization_request', 400);
      reader = request.body!.getReader();
      const bytes = new Uint8Array(MAX_INPUT_BYTES); let length = 0;
      try {
        while (true) {
          const next = await reader.read(); snapshot.assertActive();
          if (next.done) break;
          if (!(next.value instanceof Uint8Array) || length + next.value.byteLength > MAX_INPUT_BYTES) fail('invalid_export_authorization_request', 400);
          bytes.set(next.value, length); length += next.value.byteLength;
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); reader = undefined; }
      let input: Input;
      try {
        input = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, length)));
        if (!input || Object.keys(input).sort().join(',') !== 'expected_generation,operation_id,token,ttl_seconds' ||
            typeof input.operation_id !== 'string' || !UUID.test(input.operation_id) || typeof input.token !== 'string' || !validToken(input.token) ||
            !Number.isSafeInteger(input.ttl_seconds) || input.ttl_seconds < 60 || input.ttl_seconds > 3600 ||
            !Number.isSafeInteger(input.expected_generation) || input.expected_generation < 0 || input.expected_generation >= Number.MAX_SAFE_INTEGER) throw new Error();
        input.operation_id = input.operation_id.toLowerCase();
      } catch { return fail('invalid_export_authorization_request', 400); }
      const digest = await tokenDigest(order.order_id, input.token);
      if (digest === order.token_digest) fail('invalid_export_authorization_request', 400);
      const requestHash = await sha256(stableJson({ order_id: order.order_id, operation_id: input.operation_id,
        token_digest: digest, ttl_seconds: input.ttl_seconds, expected_generation: input.expected_generation }));
      const previous = order.export_authorization;
      // Same-operation readback does not extend expiry or perform another put.
      if (previous?.operation_id === input.operation_id) {
        if (previous.request_hash !== requestHash || previous.generation !== input.expected_generation + 1) fail('order_export_authorization_conflict', 409);
        const current = await authenticateOrder(bounded, id, request); snapshot.assertActive();
        if (stableJson(current) !== stableJson(order)) fail('order_export_authorization_conflict', 409);
        return reply(current);
      }
      if ((previous?.generation ?? 0) !== input.expected_generation) fail('order_export_authorization_conflict', 409);
      // The same child secret cannot be silently renewed under a new operation.
      if (previous?.token_digest === digest) fail('invalid_export_authorization_request', 400);
      snapshot.allowArtifactsFor(uuidFromDigest(await sha256(`${order.payment_fingerprint}\n${order.product}`)));
      const entitlement = await readOrderEntitlement(bounded, order);
      snapshot.assertActive();
      if (entitlement.settlement.state !== 'settlement_confirmed' || entitlement.fulfillment?.record.state !== 'complete' || !entitlement.delivery) fail('order_delivery_not_complete', 409);
      const retention = await orderRetention(order, entitlement.settlement, entitlement.fulfillment);
      if (retention.state === 'expired') fail('order_artifacts_expired', 410);
      if (order.retention_snapshot && retention.export_allowed !== true) fail('order_retention_start_unknown', 503);
      const issued = Date.now();
      const expires = Math.min(issued + input.ttl_seconds * 1000, Date.parse(order.expires_at),
        retention.raw_expires_at === null ? Infinity : Date.parse(retention.raw_expires_at));
      if (expires <= issued) fail('order_export_authorization_expired', 410);
      const authorization: OrderExportAuthorization = { schema: 'delta-order-export-authorization/v1',
        operation_id: input.operation_id, generation: input.expected_generation + 1, token_digest: digest, request_hash: requestHash,
        requested_ttl_seconds: input.ttl_seconds, issued_at: new Date(issued).toISOString(), expires_at: new Date(expires).toISOString(), scope: ['export'] };
      const stored = await readOrderMetadata<OrderBinding>(bounded, orderRecordKey(order.order_id));
      snapshot.assertActive();
      if (!stored || stableJson(stored.record) !== stableJson(order)) fail('order_export_authorization_conflict', 409);
      const current = await authenticateOrder(bounded, id, request); snapshot.assertActive();
      if (stableJson(current) !== stableJson(order)) fail('order_export_authorization_conflict', 409);
      const next = { ...order, export_authorization: authorization };
      if (await orderAuthorityDigest(next) !== await orderAuthorityDigest(order)) fail('order_evidence_inconsistent', 503);
      snapshot.assertActive();
      const saved = await writeOrderObject(bounded, orderRecordKey(order.order_id), JSON.stringify(next), {
        onlyIf: { etagMatches: stored!.etag }, httpMetadata: { contentType: 'application/json; charset=utf-8' },
      });
      snapshot.assertActive();
      // No automatic retry after a lost write ACK. A successful conditional
      // conflict may only read back the exact same operation, never reapply it.
      const confirmed = await authenticateOrder(bounded, id, request); snapshot.assertActive();
      if (stableJson(confirmed) !== stableJson(next)) fail('order_export_authorization_conflict', 409);
      return reply(confirmed, saved ? 201 : 200);
    })(), EXPORT_AUTHORIZATION_TIMEOUT_MS, 'order_export_authorization_unconfirmed', cancel);
  } catch (error) {
    const known = error instanceof OrderAccessError;
    return Response.json({ ok: false, error: known ? error.code : 'order_export_authorization_unconfirmed', retryable: false },
      { status: known ? error.status : 503, headers });
  } finally { cancel(); }
}
