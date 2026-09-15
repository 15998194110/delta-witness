import { describe, expect, it } from "vitest";
import {
  BASE_NETWORK,
  CANONICAL_USDC,
  TREASURY,
  maxPaymentUsd,
  parsePurchaseParams,
  paymentPolicy,
  rawPaymentAmount,
  requestBody,
  updatePurchaseSearch,
  validateQuote,
} from "../src/domain";

const preflightQuote = {
  price: "$5.00",
  network: BASE_NETWORK,
  asset: "USDC",
  pay_to: TREASURY,
  payment_flow: "upfront",
  economics: { estimatedContributionMarginUsd: 4.9 },
};

const captureQuote = {
  ...preflightQuote,
  price: "$1.00",
  economics: { estimatedContributionMarginUsd: 0.9 },
};

describe("Base app payment gates", () => {
  it.each([[
    "capture",
    "1000000",
  ], [
    "preflight",
    "5000000",
  ]] as const)("selects only the exact canonical-USDC %s payment", (product, amount) => {
    const valid = {
      scheme: "exact",
      network: BASE_NETWORK,
      payTo: TREASURY,
      asset: CANONICAL_USDC,
      amount,
    };
    const selected = paymentPolicy(product)(2, [
      valid,
      { ...valid, network: "eip155:1" },
      { ...valid, payTo: "0x0000000000000000000000000000000000000000" },
      { ...valid, asset: "0x0000000000000000000000000000000000000000" },
      { ...valid, amount: product === "capture" ? "5000000" : "1000000" },
      { ...valid, scheme: "upto" },
    ] as never);
    expect(selected).toEqual([valid]);
    expect(rawPaymentAmount(product)).toBe(amount);
  });

  it("pins each product to the current owner-authorized amount", () => {
    expect(maxPaymentUsd("capture")).toBe(1);
    expect(maxPaymentUsd("preflight")).toBe(5);
    expect(() => validateQuote(captureQuote, "capture")).not.toThrow();
    expect(() => validateQuote(preflightQuote, "preflight")).not.toThrow();
    expect(() => validateQuote({ ...captureQuote, price: "$5.00" }, "capture")).toThrow();
    expect(() => validateQuote({ ...preflightQuote, price: "$1.00" }, "preflight")).toThrow();
  });

  it("rejects destination or flow drift", () => {
    expect(() => validateQuote({ ...preflightQuote, pay_to: "0x0000000000000000000000000000000000000000" }, "preflight")).toThrow();
    expect(() => validateQuote({ ...preflightQuote, payment_flow: "deferred" }, "preflight")).toThrow();
  });

  it("creates the smallest deterministic Guard request", () => {
    expect(requestBody("preflight", "https://example.com", " Refund window ")).toEqual({
      url: "https://example.com",
      expected: { contains: ["Refund window"] },
    });
    expect(requestBody("capture", "https://example.com", "ignored")).toEqual({ url: "https://example.com" });
  });
});

describe("shareable purchase links", () => {
  it("prefills a buyer-facing Capture request from a link without executing it", () => {
    expect(parsePurchaseParams("?product=capture&url=https%3A%2F%2Fexample.org%2Fpricing")).toEqual({
      product: "capture",
      url: "https://example.org/pricing",
      mustContain: "30-day refund",
    });
  });

  it("prefills Public Preflight expectations and keeps unrelated attribution params", () => {
    const search = updatePurchaseSearch("?utm_source=partner", {
      product: "preflight",
      url: "https://example.org/terms",
      mustContain: "Refund window",
    });
    expect(search).toContain("utm_source=partner");
    expect(parsePurchaseParams(search)).toEqual({
      product: "preflight",
      url: "https://example.org/terms",
      mustContain: "Refund window",
    });
  });

  it("falls back safely for an invalid target and never turns parsing into a request", () => {
    expect(parsePurchaseParams("?product=preflight&url=javascript%3Aalert(1)&contains=Policy")).toEqual({
      product: "preflight",
      url: "https://example.com/terms",
      mustContain: "Policy",
    });
  });
});
