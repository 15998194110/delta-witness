import { vi } from "vitest";
import type { RuntimeEnv } from "../../src/env";

export class MemoryBucket {
  values = new Map<string, { text: string; etag: string; bytes?: Uint8Array }>();
  sequence = 0;
  async get(key: string) {
    const value = this.values.get(key);
    const bytes = value && (value.bytes ?? new TextEncoder().encode(value.text)).slice();
    return value ? { etag: value.etag, size: value.bytes?.byteLength ?? new TextEncoder().encode(value.text).byteLength,
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes!); controller.close(); } }),
      json: async () => JSON.parse(value.text), text: async () => value.text,
      arrayBuffer: async () => (value.bytes ?? new TextEncoder().encode(value.text)).slice().buffer } : null;
  }
  async put(key: string, value: unknown, options?: R2PutOptions) {
    const current = this.values.get(key), condition = options?.onlyIf;
    if (condition && "etagDoesNotMatch" in condition && condition.etagDoesNotMatch === "*" && current) return null;
    if (condition && "etagMatches" in condition && condition.etagMatches !== current?.etag) return null;
    const etag = String(++this.sequence);
    this.values.set(key, { text: String(value), etag, bytes: value instanceof Uint8Array ? value.slice() : undefined });
    return { etag };
  }
}
export const TEST_ORDER_ID = "11111111-1111-4111-8111-111111111111";
export const TEST_RECOVERY_TOKEN = Buffer.alloc(32, 17).toString("base64url");
export const TEST_PAYER = "0x1111111111111111111111111111111111111111";
const payTo = "0x1990e21bc219696ff7fbc26527dbaed335ac6367";
const asset = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

export function orderRuntime(bucket: MemoryBucket): RuntimeEnv & { ORDER_RECOVERY_TTL_SECONDS: string } {
  return { PROOFS: bucket, APP_VERSION: "0.7.1", NETWORK: "eip155:8453", PAY_TO: payTo,
    CAPTURE_BASE_PRICE_USD: "1", PREFLIGHT_BASE_PRICE_USD: "5", WATCH_BASE_PRICE_USD: "1",
    FACILITATOR_URL: "https://facilitator.test", PUBLIC_ORIGIN: "https://delta.test", ORDER_RECOVERY_TTL_SECONDS: "3600",
    ANALYTICS_DB: { prepare: () => ({ bind: () => ({ run: async () => undefined }) }) },
    BROWSER: { quickAction: vi.fn(async () => Response.json({ success: true,
      result: { content: "<h1>Example</h1>", markdown: "Example", screenshot: png },
      meta: { status: 200, finalUrl: "https://example.com/" } }, { headers: { "x-browser-ms-used": "1" } })) },
  } as unknown as RuntimeEnv & { ORDER_RECOVERY_TTL_SECONDS: string };
}
export function orderPayment(product = "capture", nonce = "0x" + "cd".repeat(32)) {
  const amount = product === "capture" ? "1000000" : product === "preflight" ? "5000000" : "10000000";
  return { x402Version: 2, resource: { url: `https://delta.test/v1/${product}` },
    accepted: { scheme: "exact", network: "eip155:8453", asset, amount, payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2", paymentFlow: "upfront" } },
    payload: { signature: "0x" + "ab".repeat(65), authorization: { from: TEST_PAYER, to: payTo, value: amount, validAfter: "0", validBefore: "9999999999", nonce } } };
}
export function orderRequest(options: { product?: string; orderId?: string; token?: string; nonce?: string; body?: Record<string, unknown>; unpaid?: boolean; legacy?: boolean } = {}) {
  const product = options.product ?? "capture";
  const headers = new Headers({ "content-type": "application/json" });
  if (!options.legacy) { headers.set("x-delta-order-id", options.orderId ?? TEST_ORDER_ID); headers.set("x-delta-recovery-token", options.token ?? TEST_RECOVERY_TOKEN); }
  if (!options.unpaid) headers.set("payment-signature", Buffer.from(JSON.stringify(orderPayment(product, options.nonce))).toString("base64"));
  return new Request(`https://delta.test/v1/${product}`, { method: "POST", headers,
    body: JSON.stringify(options.body ?? { url: "https://example.com/" }) });
}
export function statusRequest(options: { id?: string; token?: string; recover?: boolean; origin?: string; query?: string } = {}) {
  const headers = new Headers({ "x-delta-recovery-token": options.token ?? TEST_RECOVERY_TOKEN });
  if (options.origin) headers.set("origin", options.origin);
  return new Request(`https://delta.test/v1/orders/${options.id ?? TEST_ORDER_ID}${options.recover ? "/recover" : ""}${options.query ?? ""}`,
    { method: options.recover ? "POST" : "GET", headers });
}
export function mockOrderNetwork(settle: () => Promise<Response> = async () => Response.json({ success: true, transaction: "0x" + "12".repeat(32), network: "eip155:8453", payer: TEST_PAYER }), verify = true) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://cloudflare-dns.com/")) return Response.json(new URL(url).searchParams.get("type") === "A" ? { Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] } : { Status: 0, Answer: [] });
    if (url === "https://example.com/") return new Response("", { status: 200 });
    if (url.endsWith("/supported")) return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (url.endsWith("/verify")) return Response.json({ isValid: verify, payer: TEST_PAYER, ...(verify ? {} : { invalidReason: "invalid_signature" }) });
    if (url.endsWith("/settle")) return settle();
    throw new Error("unexpected_mocked_request");
  });
}
