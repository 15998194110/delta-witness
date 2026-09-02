import { describe, expect, it } from "vitest";
import { openApi } from "../src/discovery";
import type { PricingQuote } from "../src/pricing";

const quote: PricingQuote = {
  product: "preflight",
  grossPriceUsd: 0.03,
  configuredPriceUsd: 0.03,
  minimumPriceUsd: 0.01,
  expectedVariableCostUsd: 0.003,
  targetMarginBps: 6_500,
  estimatedContributionMarginUsd: 0.027,
  assumptions: { browserMs: 25_000, storageBytes: 9_000_000, facilitatorFeeUsd: 0.001, r2Writes: 5 },
};

describe("OpenAPI paid discovery", () => {
  it("advertises Capture and Guard with x402scan-compatible fixed pricing", () => {
    const document = openApi("https://delta.example", "0.6.1", { ...quote, product: "capture" }, quote) as any;
    expect(document.info.contact.email).toBe("ruphussten@163.com");
    for (const path of ["/v1/capture", "/v1/preflight"]) {
      expect(document.paths[path].post.responses["402"]).toBeDefined();
      expect(document.paths[path].post.security).toEqual([]);
      expect(document.paths[path].post["x-payment-info"]).toEqual({
        price: { mode: "fixed", currency: "USD", amount: "0.03" },
        protocols: [{ x402: {} }],
        network: "eip155:8453",
      });
    }
    expect(JSON.stringify(document.paths["/v1/capture"].post).toLowerCase()).toContain("browser verification");
    expect(JSON.stringify(document.paths["/v1/capture"].post).toLowerCase()).toContain("page state proof");
    expect(JSON.stringify(document.paths["/v1/preflight"].post).toLowerCase()).toContain("preflight autonomous action");
  });
});
