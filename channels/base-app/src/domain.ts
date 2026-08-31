import type { PaymentPolicy } from "@x402/fetch";

export const API_ORIGIN = "https://delta-witness-api.ruphussten.workers.dev";
export const BASE_NETWORK = "eip155:8453";
export const TREASURY = "0x1990e21bc219696ff7fbc26527dbaed335ac6367";
export const MAX_PAYMENT_USD = 0.10;

export type Product = "preflight" | "capture";

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

export function paymentPolicy(): PaymentPolicy {
  return (_version, requirements) => requirements.filter((requirement) =>
    requirement.network === BASE_NETWORK &&
    requirement.scheme === "exact" &&
    requirement.payTo.toLowerCase() === TREASURY,
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
  if (!Number.isFinite(price) || price <= 0 || price > MAX_PAYMENT_USD) {
    throw new Error(`${product === "preflight" ? "Guard" : "Capture"} quote exceeds the $${MAX_PAYMENT_USD.toFixed(2)} app limit`);
  }
}

export function compactProof(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 5)}…${id.slice(-4)}`;
}
