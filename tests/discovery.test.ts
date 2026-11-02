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
  it("describes credential updates as private unpaid operations with write-only secrets and a generation fence", () => {
    const document = openApi("https://delta.example", "0.7.1", { ...quote, product: "capture" }, quote) as any;
    const path = document.paths["/v1/orders/{order_id}/export-authorization"];
    for (const method of ["get", "post"]) {
      expect(path[method].security).toEqual([{ OrderCapability: [] }]);
      expect(path[method]["x-payment-info"]).toBeUndefined();
      expect(path[method].responses["402"]).toBeUndefined();
    }
    const input = path.post.requestBody.content["application/json"].schema;
    expect(input.required).toContain("expected_generation");
    expect(input.properties.token.writeOnly).toBe(true);
    const output = path.post.responses["201"].content["application/json"].schema;
    expect(output.properties.authorization.oneOf[1].properties.token).toBeUndefined();
    expect(output.properties.authorization.oneOf[1].properties.scope).toEqual({ const: ["export"] });
  });
  it("keeps scoped recovery and artifact downloads separate from paid discovery", () => {
    const document = openApi("https://delta.example", "0.7.1", { ...quote, product: "capture" }, quote) as any;
    for (const [path, method] of [["/v1/orders/{order_id}", "get"], ["/v1/orders/{order_id}/recover", "post"], ["/v1/orders/{order_id}/artifacts/{artifact}", "get"]]) {
      const operation = document.paths[path][method];
      expect(operation.security).toEqual([{ OrderCapability: [] }]);
      expect(operation["x-payment-info"]).toBeUndefined();
      expect(operation.requestBody).toBeUndefined();
      expect(operation.responses["404"].description).toContain("does not establish non-payment");
    }
    expect(document.components.securitySchemes.OrderCapability.name).toBe("x-delta-recovery-token");
    expect(document.paths["/v1/capture"].post.parameters.map((parameter: any) => parameter.name)).toEqual(["x-delta-order-id", "x-delta-retention-policy-hash", "x-delta-recovery-token"]);
    expect(document.paths["/v1/guarded-action-pilot"].post.parameters).toBeUndefined();
    expect(document.components.schemas.OrderStatus.properties.payment.properties.treasury_received.type).toBe("null");
  });
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
    expect(document.paths["/v1/capture"].post.operationId).toBe("browserVerificationPageStateProof");
    expect(document.paths["/v1/preflight"].post.operationId).toBe("preflightAutonomousAction");
  });
});
