import { describe, expect, it } from "vitest";
import { buildPreflightBody, deltaPaymentPolicy } from "../src/index.js";
import { approvedPaymentUsd } from "../src/payment-config.js";

describe("DELTA MCP client guardrails", () => {
  it("builds a compact deterministic preflight body", () => {
    expect(buildPreflightBody({ url: "https://example.com", contains: ["Example"] })).toEqual({
      url: "https://example.com",
      prior_proof_id: undefined,
      freshness_seconds: undefined,
      expected: { html_sha256: undefined, markdown_sha256: undefined, contains: ["Example"], excludes: undefined },
    });
  });

  it.each([["capture", "1000000"], ["preflight", "5000000"]] as const)("accepts only the exact %s price in canonical Base USDC", (product, amount) => {
    const policy = deltaPaymentPolicy(product);
    const valid = { network: "eip155:8453", scheme: "exact", payTo: "0x1990E21BC219696FF7FBC26527DBAED335AC6367", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount };
    const rejected = [
      { ...valid, payTo: "0x0000000000000000000000000000000000000000" },
      { ...valid, network: "eip155:84532" },
      { ...valid, asset: "0x0000000000000000000000000000000000000000" },
      { ...valid, scheme: "upto" },
      { ...valid, amount: "100000" },
      { ...valid, amount: "10000000" },
    ];
    expect(policy(2, [valid, ...rejected] as never)).toEqual([valid]);
  });
});

describe("explicit buyer approval stays aligned with current products", () => {
  it.each([
    ["capture", "1.00", 1],
    ["preflight", "5.00", 5],
    ["capture", "5.00", 1],
    ["capture", "10", 1],
    ["preflight", "10", 5],
  ] as const)("%s uses its exact price with approved limit %s", (product, approved, expected) => {
    expect(approvedPaymentUsd(product, approved)).toBe(expected);
  });

  it.each([undefined, "", " "])("does not invent a hidden cap when approval is %s", (approved) => {
    expect(() => approvedPaymentUsd("capture", approved)).toThrow("Explicit buyer approval required");
  });

  it("does not silently upgrade Capture-only approval to Public Preflight", () => {
    expect(() => approvedPaymentUsd("preflight", "1.00")).toThrow("above the buyer's explicit");
  });

  it.each(["0", "-1", "NaN", "Infinity", "11", "1e1", "0x5", "5.0000001"])("rejects invalid buyer limit %s", (approved) => {
    expect(() => approvedPaymentUsd("capture", approved)).toThrow();
  });

  it("preserves an existing buyer's lower explicit budget rather than silently spending more", () => {
    expect(() => approvedPaymentUsd("capture", "0.10")).toThrow("No payment was attempted");
  });
});
