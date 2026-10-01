import type { PaymentPolicy } from "@x402/fetch";

export const API_ORIGIN = "https://delta-witness-api.ruphussten.workers.dev";
export const BASE_NETWORK = "eip155:8453";
export const TREASURY = "0x1990e21bc219696ff7fbc26527dbaed335ac6367";
export const CANONICAL_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

export type Product = "preflight" | "capture";

export function isHttpSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function maxPaymentUsd(product: Product): number {
  return product === "capture" ? 1 : 5;
}

export function rawPaymentAmount(product: Product): string {
  return String(maxPaymentUsd(product) * 1_000_000);
}

export type Quote = {
  price: string;
  network: string;
  asset: string;
  pay_to: string;
  payment_flow: string;
  economics: {
    estimatedContributionMarginUsd: number;
  };
};

export type Delivery = {
  ok: true;
  product: Product;
  proof_id: string;
  public_proof_url: string;
  manifest_url: string;
  bundle_root: string;
  observed_at: string;
  safe?: boolean | null;
  changed?: boolean | null;
  reason?: string;
};

export type PurchaseOutcome =
  | { state: "complete"; delivery: Delivery }
  | { state: "processing" | "retryable_failure" | "uncertain"; message: string };

export const PAYMENT_RECOVERY_WARNING = "Payment status is not confirmed here. Do not approve another payment for this request. Automatic recovery is not available; contact DELTA with the attempt reference before paying again.";

export const PAYMENT_ATTEMPT_KEY = "delta-witness:payment-attempt:v1";
export const PAYMENT_LOCK_NAME = "delta-witness:paid-request:v1";
export type PaymentAttempt = {
  version: 1;
  product: Product;
  startedAt: string;
  attemptId: string;
  phase: "signed_request" | "processing" | "retryable_failure" | "uncertain";
};
export type PaymentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function assertPaymentStorageAvailable(storage: PaymentStorage): void {
  const key = `${PAYMENT_ATTEMPT_KEY}:probe`;
  try {
    storage.setItem(key, "ready");
    if (storage.getItem(key) !== "ready") throw new Error("storage_probe_failed");
    storage.removeItem(key);
    if (storage.getItem(key) !== null) throw new Error("storage_probe_cleanup_failed");
  } catch {
    try { storage.removeItem(key); } catch { /* No payment data is stored in the probe. */ }
    throw new Error("Browser recovery storage is unavailable. No wallet authorization or signed request was started.");
  }
}

export function readPaymentAttempt(storage: PaymentStorage): PaymentAttempt | null {
  const saved = storage.getItem(PAYMENT_ATTEMPT_KEY);
  if (saved === null) return null;
  const value: unknown = JSON.parse(saved);
  if (!isRecord(value) || value.version !== 1 || !["capture", "preflight"].includes(String(value.product)) ||
      typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt)) ||
      typeof value.attemptId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.attemptId) ||
      !["signed_request", "processing", "retryable_failure", "uncertain"].includes(String(value.phase)) ||
      Object.keys(value).some((key) => !["version", "product", "startedAt", "attemptId", "phase"].includes(key))) {
    throw new Error("Saved payment recovery marker is invalid; do not start a new payment");
  }
  return value as PaymentAttempt;
}

export function writePaymentAttempt(storage: PaymentStorage, attempt: PaymentAttempt): void {
  const existing = readPaymentAttempt(storage);
  if (existing && existing.attemptId !== attempt.attemptId) throw new Error("Another payment attempt needs review");
  storage.setItem(PAYMENT_ATTEMPT_KEY, JSON.stringify(attempt));
  if (JSON.stringify(readPaymentAttempt(storage)) !== JSON.stringify(attempt)) throw new Error("Payment recovery marker could not be verified");
}

export function clearPaymentAttempt(storage: PaymentStorage, attemptId: string): void {
  const existing = readPaymentAttempt(storage);
  if (existing && existing.attemptId !== attemptId) throw new Error("Another payment attempt needs review");
  if (!existing) return;
  storage.removeItem(PAYMENT_ATTEMPT_KEY);
  if (storage.getItem(PAYMENT_ATTEMPT_KEY) !== null) throw new Error("Payment recovery marker could not be cleared");
}

export async function markSignedPaymentRequest(request: Request, storage: PaymentStorage, product: Product): Promise<PaymentAttempt | null> {
  const signature = request.headers.get("payment-signature") ?? request.headers.get("x-payment");
  if (!signature) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signature));
  const attemptId = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const existing = readPaymentAttempt(storage);
  const attempt: PaymentAttempt = existing?.attemptId === attemptId ? existing : {
    version: 1, product, startedAt: new Date().toISOString(), attemptId, phase: "signed_request",
  };
  writePaymentAttempt(storage, attempt);
  return attempt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProofUrl(value: unknown, path: string): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === API_ORIGIN && url.pathname === path && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isDelivery(value: unknown, product: Product): value is Delivery {
  if (!isRecord(value) || value.ok !== true || value.product !== product) return false;
  if (typeof value.proof_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.proof_id)) return false;
  if (!isProofUrl(value.public_proof_url, `/p/${value.proof_id}`) || !isProofUrl(value.manifest_url, `/v1/proofs/${value.proof_id}`)) return false;
  if (typeof value.bundle_root !== "string" || !/^sha256:[0-9a-f]{64}$/i.test(value.bundle_root)) return false;
  if (typeof value.observed_at !== "string" || !Number.isFinite(Date.parse(value.observed_at))) return false;
  if (value.reason !== undefined && typeof value.reason !== "string") return false;
  if (product === "preflight" && !([true, false, null].includes(value.safe as boolean | null) && [true, false, null].includes(value.changed as boolean | null))) return false;
  return true;
}

export function purchaseOutcome(status: number, body: unknown, product: Product): PurchaseOutcome {
  const response = isRecord(body) ? body : {};
  if (status === 202 || (response.ok === false && response.state === "processing")) {
    return { state: "processing", message: `The request is still processing; no completed proof has been returned. ${PAYMENT_RECOVERY_WARNING}` };
  }
  if (status === 502 || response.retryable === true || response.state === "retryable_failure") {
    return { state: "retryable_failure", message: `The observation was not delivered. ${PAYMENT_RECOVERY_WARNING}` };
  }
  if (status === 200 && isDelivery(body, product)) return { state: "complete", delivery: body };
  return { state: "uncertain", message: `DELTA did not return a valid completed proof (HTTP ${status}). ${PAYMENT_RECOVERY_WARNING}` };
}

export function paymentNeedsRecovery(state: string): boolean {
  return state === "processing" || state === "retryable_failure" || state === "uncertain";
}

export function prepareBrowserPaymentRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  // @x402/fetch 2.24 adds this response-only header to its signed request.
  // Strip that header at the browser boundary; retain the original payment/body.
  const request = new Request(input, init);
  request.headers.delete("access-control-expose-headers");
  return request;
}

export type PurchaseParams = {
  product: Product;
  url: string;
  mustContain: string;
};

const DEFAULT_PURCHASE: PurchaseParams = {
  product: "capture",
  url: "",
  mustContain: "",
};

export function parsePurchaseParams(search: string): PurchaseParams {
  const params = new URLSearchParams(search);
  const product: Product = params.get("product") === "preflight" ? "preflight" : "capture";
  const rawUrl = params.get("url")?.trim() || DEFAULT_PURCHASE.url;
  let url = DEFAULT_PURCHASE.url;
  try {
    const parsed = new URL(rawUrl);
    if (isHttpSourceUrl(rawUrl)) url = parsed.toString();
  } catch {
    // Keep the safe default. No request is made while parsing a share link.
  }
  const mustContain = (params.get("contains") || DEFAULT_PURCHASE.mustContain).slice(0, 200);
  return { product, url, mustContain };
}

export function updatePurchaseSearch(currentSearch: string, purchase: PurchaseParams): string {
  const params = new URLSearchParams(currentSearch);
  params.set("product", purchase.product);
  const validSource = isHttpSourceUrl(purchase.url);
  if (validSource) params.set("url", purchase.url);
  else params.delete("url");
  if (validSource && purchase.product === "preflight" && purchase.mustContain.trim()) {
    params.set("contains", purchase.mustContain.slice(0, 200));
  } else {
    params.delete("contains");
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function paymentPolicy(product: Product): PaymentPolicy {
  const expectedAmount = rawPaymentAmount(product);
  return (_version, requirements) => requirements.filter((requirement) =>
    requirement.network === BASE_NETWORK &&
    requirement.scheme === "exact" &&
    requirement.payTo.toLowerCase() === TREASURY &&
    requirement.asset.toLowerCase() === CANONICAL_USDC &&
    requirement.amount === expectedAmount,
  );
}

export function requestBody(product: Product, url: string, mustContain: string): Record<string, unknown> {
  if (product === "capture") return { url };
  const expectation = mustContain.trim();
  return {
    url,
    expected: expectation ? { contains: [expectation] } : undefined,
  };
}

export function validateQuote(quote: Quote, product: Product): void {
  if (quote.network !== BASE_NETWORK || quote.asset !== "USDC" || quote.pay_to.toLowerCase() !== TREASURY) {
    throw new Error("DELTA returned an unexpected payment destination");
  }
  if (quote.payment_flow !== "upfront") throw new Error("DELTA payment must settle before capture");
  const price = Number(quote.price.replace("$", ""));
  const expected = maxPaymentUsd(product);
  if (!Number.isFinite(price) || price !== expected) {
    throw new Error(`${product === "preflight" ? "Guard" : "Capture"} quote must match the current ${expected.toFixed(2)} USDC owner price`);
  }
}

export function compactProof(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 5)}…${id.slice(-4)}`;
}
