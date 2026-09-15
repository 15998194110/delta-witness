/** Current seller prices are not a grant of authority to spend a buyer's funds. */
export const PUBLIC_PAYMENT_USD = Object.freeze({ capture: 1, preflight: 5 } as const);
export type PaidProduct = keyof typeof PUBLIC_PAYMENT_USD;

/** Require explicit buyer approval, then cap this call to its exact product price. */
export function approvedPaymentUsd(product: PaidProduct, configured: string | undefined): number {
  const price = PUBLIC_PAYMENT_USD[product];
  if (price === undefined) throw new Error("Unsupported DELTA paid product");
  const cap = configured?.trim();
  if (!cap) {
    throw new Error(`Explicit buyer approval required: set DELTA_MAX_USD_PER_CALL to ${price.toFixed(2)} for ${product}. No payment was attempted.`);
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(cap)) {
    throw new Error("DELTA_MAX_USD_PER_CALL must be an explicit decimal USDC amount greater than 0 and at most 10");
  }
  const approved = Number(cap);
  if (!Number.isFinite(approved) || approved <= 0 || approved > 10) {
    throw new Error("DELTA_MAX_USD_PER_CALL must be greater than 0 and at most 10");
  }
  if (approved < price) {
    throw new Error(`${product} costs ${price.toFixed(2)} USDC, above the buyer's explicit ${cap} USDC limit. No payment was attempted; the buyer must explicitly approve a higher limit.`);
  }
  return price;
}
