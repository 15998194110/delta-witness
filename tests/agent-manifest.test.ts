import { describe, expect, it } from "vitest";
import { agentJsonManifest } from "../src/agent-manifest";
import type { PricingQuote } from "../src/pricing";

const quote = (product: "capture" | "preflight", price = 0.03): PricingQuote => ({
  product,
  grossPriceUsd: price,
  configuredPriceUsd: price,
  minimumPriceUsd: 0.01,
  expectedVariableCostUsd: 0.003,
  targetMarginBps: 6500,
  estimatedContributionMarginUsd: price - 0.003,
  assumptions: { browserMs: 25000, storageBytes: 9000000, facilitatorFeeUsd: 0.001, r2Writes: 5 },
});

describe("agent.json provider manifest", () => {
  it("publishes three same-origin x402-priced intents without unsupported trust claims", () => {
    const doc: any = agentJsonManifest(
      "https://delta-witness-api.ruphussten.workers.dev",
      "0x1990e21bc219696ff7fbc26527dbaed335ac6367",
      "https://facilitator.payai.network",
      quote("capture"),
      quote("preflight", 1),
    );
    expect(doc.version).toBe("1.4");
    expect(doc.origin).toBe("delta-witness-api.ruphussten.workers.dev");
    expect(doc.payout_address).toBe("0x1990e21bc219696ff7fbc26527dbaed335ac6367");
    expect(doc.identity).toBeUndefined();
    expect(doc.commitments).toBeUndefined();
    expect(doc.pricing.note).toBe("Capture is 0.03 USDC per call; public preflight is 1 USDC per call; guarded-action-pilot is a separate 10 USDC bounded pilot.");
    expect(doc.payments.x402.networks[0]).toMatchObject({
      network: "base",
      asset: "USDC",
      contract: "0x833589fCD6eDb6E08f4c7C32d4f71b54bdA02913",
      facilitator: "https://facilitator.payai.network",
      recipient: "0x1990e21bc219696ff7fbc26527dbaed335ac6367",
    });
    expect(doc.intents.map((x: any) => [x.name, x.endpoint, x.method, x.price.amount])).toEqual([
      ["capture_page_state", "/v1/capture", "POST", 0.03],
      ["preflight_verification", "/v1/preflight", "POST", 1],
      ["guarded_action_pilot", "/v1/guarded-action-pilot", "POST", 10],
    ]);
  });
});
