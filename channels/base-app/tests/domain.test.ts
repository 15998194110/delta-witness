import { describe, expect, it } from "vitest";
import { BASE_NETWORK, TREASURY, paymentPolicy, requestBody, validateQuote } from "../src/domain";

const quote = {
  price: "$0.03",
  network: BASE_NETWORK,
  asset: "USDC",
  pay_to: TREASURY,
  payment_flow: "upfront",
  economics: { estimatedContributionMarginUsd: 0.027 },
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

  it("rejects destination, flow, or price drift", () => {
    expect(() => validateQuote(quote, "preflight")).not.toThrow();
    expect(() => validateQuote({ ...quote, pay_to: "0x0000000000000000000000000000000000000000" }, "preflight")).toThrow();
    expect(() => validateQuote({ ...quote, payment_flow: "deferred" }, "preflight")).toThrow();
    expect(() => validateQuote({ ...quote, price: "$0.11" }, "preflight")).toThrow();
  });

  it("creates the smallest deterministic Guard request", () => {
    expect(requestBody("preflight", "https://example.com", " Refund window ")).toEqual({
      url: "https://example.com",
      expected: { contains: ["Refund window"] },
    });
    expect(requestBody("capture", "https://example.com", "ignored")).toEqual({ url: "https://example.com" });
  });
});
