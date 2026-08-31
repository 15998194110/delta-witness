import { describe, expect, it } from "vitest";
import { buildPreflightBody, deltaPaymentPolicy } from "../src/index.js";

describe("DELTA MCP client guardrails", () => {
  it("builds a compact deterministic preflight body", () => {
    expect(buildPreflightBody({ url: "https://example.com", contains: ["Example"] })).toEqual({
      url: "https://example.com",
      prior_proof_id: undefined,
      freshness_seconds: undefined,
      expected: { html_sha256: undefined, markdown_sha256: undefined, contains: ["Example"], excludes: undefined },
    });
  });

  it("accepts only DELTA's Base mainnet exact-payment treasury requirement", () => {
    const policy = deltaPaymentPolicy();
    const valid = { network: "eip155:8453", scheme: "exact", payTo: "0x1990E21BC219696FF7FBC26527DBAED335AC6367" };
    const wrongTreasury = { ...valid, payTo: "0x0000000000000000000000000000000000000000" };
    const wrongNetwork = { ...valid, network: "eip155:84532" };
    expect(policy(2, [valid, wrongTreasury, wrongNetwork] as never)).toEqual([valid]);
  });
});
