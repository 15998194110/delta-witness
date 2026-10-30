import type { RuntimeEnv } from "./env";
import { sha256, stableJson, uuidFromDigest } from "./crypto";
import { MAX_TOTAL_ARTIFACT_BYTES, readStoredCapture } from "./capture";
import { authenticateOrder, OrderAccessError, orderPrivateHeaders, readOrderEntitlement, orderRetention } from "./orders";
import { readOrderSettlement } from "./settlement";
import { readFulfillment, fulfillmentRecordKey } from "./fulfillment";
import { withinDeadline } from "./deadline";

export { MAX_EXPORT_MANIFEST_BYTES } from "./order-storage";
import { createOrderReadSnapshot } from "./order-storage";
export const ORDER_EXPORT_TIMEOUT_MS = 15_000;
export type OrderArtifact = "html" | "markdown" | "screenshot" | "manifest";

class ExportError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 405 | 409 | 503) { super(code); }
}

function secureHeaders(headers = new Headers()): Headers {
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set("pragma", "no-cache");
  headers.set("x-robots-tag", "noindex, nofollow");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "sandbox; default-src 'none'; frame-ancestors 'none'");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("vary", "Origin, x-delta-recovery-token");
  return headers;
}

// Download only. This module never creates entitlement, settles, captures,
// mutates an order, or exposes a public proof ID as a download credential.
export async function exportOrderArtifact(env: RuntimeEnv, orderId: string, request: Request, artifact: string): Promise<Response> {
  let headers = secureHeaders();
  const snapshot = createOrderReadSnapshot(env);
  const boundedEnv = snapshot.env;

  try {
    headers = secureHeaders(orderPrivateHeaders(env, request));
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    return await withinDeadline((async () => {
      if (request.method !== "GET") throw new ExportError("method_not_allowed", 405);
      const order = await authenticateOrder(boundedEnv, orderId, request);
      snapshot.assertActive();
      if (!order.scope.includes("export")) throw new ExportError("order_export_not_authorized", 403);
      if (!["html", "markdown", "screenshot", "manifest"].includes(artifact)) throw new ExportError("invalid_order_artifact", 400);
      if (request.headers.has("payment-signature") || request.headers.has("x-payment") || request.body !== null) throw new ExportError("order_export_input_forbidden", 400);
      const proofId = uuidFromDigest(await sha256(`${order.payment_fingerprint}\n${order.product}`));
      const keys = [`${proofId}/page.html`, `${proofId}/page.md`, `${proofId}/screenshot.png`, `${proofId}/manifest.json`];
      snapshot.allowArtifactsFor(proofId);
      const journal = await readOrderSettlement(boundedEnv, order);
      const original = await readFulfillment(boundedEnv, fulfillmentRecordKey(order.payment_fingerprint));
      const retention = await orderRetention(order, journal, original);
      if (retention.state === "expired") throw new OrderAccessError("order_artifacts_expired", 410);
      if (order.retention_snapshot && retention.export_allowed !== true) throw new ExportError("order_retention_start_unknown", 503);
      const entitlement = await readOrderEntitlement(boundedEnv, order);
      snapshot.assertActive();
      const delivery = entitlement.delivery;
      const fulfillment = entitlement.fulfillment;
      if (!delivery || !fulfillment || fulfillment.record.state !== "complete") throw new ExportError("order_delivery_not_complete", 409);
      const record = fulfillment.record;
      const paidPrice = Number(order.amount) / 1_000_000;
      if (record.partner !== undefined || record.payment_fingerprint !== order.payment_fingerprint ||
          record.fulfillment_fingerprint !== order.payment_fingerprint || record.request_hash !== order.request_hash ||
          record.route !== `/v1/${order.product}` || record.requested_url !== order.request_body.url ||
          record.paid_price_usd !== paidPrice || delivery.proof_id !== proofId || delivery.product !== order.product) throw new ExportError("order_artifacts_unverified", 503);
      const bytes = await Promise.all(keys.map(key => snapshot.readArtifact(key)));
      if (bytes[0].byteLength + bytes[1].byteLength + bytes[2].byteLength > MAX_TOTAL_ARTIFACT_BYTES) throw new ExportError("order_artifacts_unverified", 503);
      const verified = await readStoredCapture({
        env: boundedEnv, fulfillmentFingerprint: record.fulfillment_fingerprint,
        product: order.product, requestedUrl: order.request_body.url, grossPriceUsd: paidPrice, paymentProtocol: "x402-v2-upfront",
      });
      snapshot.assertActive();
      if (!verified || delivery.bundle_root !== verified.manifest.hashes.bundle_root ||
          delivery.observed_at !== verified.manifest.capture_completed_at) throw new ExportError("order_artifacts_unverified", 503);
      const index = ["html", "markdown", "screenshot", "manifest"].indexOf(artifact);
      const contentHash = await sha256(bytes[index]);
      // Recheck the shared capability immediately before publishing bytes. An
      // expired/revoked/rotated credential cannot finish a long storage read.
      const stillAuthorized = await authenticateOrder(boundedEnv, orderId, request);
      snapshot.assertActive();
      if (stableJson(stillAuthorized) !== stableJson(order)) throw new ExportError("order_export_authorization_changed", 409);
      if ((await orderRetention(order, journal, original)).state === "expired") throw new OrderAccessError("order_artifacts_expired", 410);

      const names = ["page.html", "page.md", "screenshot.png", "manifest.json"];
      const types = ["application/octet-stream", "application/octet-stream", "image/png", "application/json; charset=utf-8"];
      headers.set("access-control-expose-headers", "Content-Disposition, Content-Length, X-Delta-Content-Sha256");
      headers.set("content-type", types[index]);
      headers.set("content-disposition", `attachment; filename="delta-${proofId}-${names[index]}"`);
      headers.set("content-length", String(bytes[index].byteLength));
      headers.set("x-delta-content-sha256", contentHash);
      snapshot.assertActive();
      return new Response(bytes[index], { status: 200, headers });
    })(), ORDER_EXPORT_TIMEOUT_MS, "order_export_deadline", snapshot.cancel);
  } catch (error) {
    const known = error instanceof OrderAccessError || error instanceof ExportError;
    const status = known ? error.status : 503;
    headers.set("content-type", "application/json; charset=utf-8");
    headers.delete("content-disposition");
    headers.delete("content-length");
    headers.delete("x-delta-content-sha256");
    if (status === 405) headers.set("allow", "GET");
    return new Response(JSON.stringify({ ok: false, error: known ? error.code : "order_export_unavailable", retryable: false }), { status, headers });
  } finally { snapshot.cancel(); }
}
