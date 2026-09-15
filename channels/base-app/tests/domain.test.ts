import { describe, expect, it } from "vitest";
import { BASE_NETWORK, TREASURY, maxPaymentUsd, paymentPolicy, requestBody, validateQuote } from "../src/domain";

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
  it("selects only exact Base mainnet payments to the configured treasury", () => {
    const selected = paymentPolicy()(2, [
      { scheme: "exact", network: BASE_NETWORK, payTo: TREASURY } as never,
      { scheme: "exact", network: "eip155:1", payTo: TREASURY } as never,
      { scheme: "exact", network: BASE_NETWORK, payTo: "0x0000000000000000000000000000000000000000" } as never,
    ]);
    expect(selected).toHaveLength(1);
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
