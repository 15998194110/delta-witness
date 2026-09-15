import type { PaymentPolicy } from "@x402/fetch";

export const API_ORIGIN = "https://delta-witness-api.ruphussten.workers.dev";
export const BASE_NETWORK = "eip155:8453";
export const TREASURY = "0x1990e21bc219696ff7fbc26527dbaed335ac6367";
export const CANONICAL_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

export type Product = "preflight" | "capture";

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

export type PurchaseParams = {
  product: Product;
  url: string;
  mustContain: string;
};

const DEFAULT_PURCHASE: PurchaseParams = {
  product: "capture",
  url: "https://example.com/terms",
  mustContain: "30-day refund",
};

export function parsePurchaseParams(search: string): PurchaseParams {
  const params = new URLSearchParams(search);
  const product: Product = params.get("product") === "preflight" ? "preflight" : "capture";
  const rawUrl = params.get("url")?.trim() || DEFAULT_PURCHASE.url;
  let url = DEFAULT_PURCHASE.url;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") url = parsed.toString();
  } catch {
    // Keep the safe default. No request is made while parsing a share link.
  }
  const mustContain = (params.get("contains") || DEFAULT_PURCHASE.mustContain).slice(0, 200);
  return { product, url, mustContain };
}

export function updatePurchaseSearch(currentSearch: string, purchase: PurchaseParams): string {
  const params = new URLSearchParams(currentSearch);
  params.set("product", purchase.product);
  params.set("url", purchase.url);
  if (purchase.product === "preflight" && purchase.mustContain.trim()) {
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
