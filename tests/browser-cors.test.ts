import { describe, expect, it } from "vitest";
import { app } from "../src/index";

describe("browser x402 CORS", () => {
  it("exposes v2 payment challenge and settlement response headers", async () => {
    const response = await app.request("https://delta.example/v1/unknown", { headers: { origin: "https://delta-witness-app.pages.dev" } }, {});
    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const exposed = response.headers.get("access-control-expose-headers")?.toLowerCase().split(/,\s*/);
    expect(exposed).toEqual(["payment-required", "payment-response", "x-payment-response"]);
  });
  it("keeps the request-header allowlist narrow", async () => {
    const response = await app.request("https://delta.example/v1/capture", { method: "OPTIONS", headers: { origin: "https://delta-witness-app.pages.dev", "access-control-request-method": "POST", "access-control-request-headers": "content-type,payment-signature,x-delta-channel" } });
    expect(response.status).toBe(204);
    const allowed = response.headers.get("access-control-allow-headers")?.toLowerCase();
    for (const header of ["content-type", "payment-signature", "x-delta-channel"]) expect(allowed).toContain(header);
    expect(allowed).not.toContain("x-delta-partner-user");
    expect(allowed).not.toContain("access-control-expose-headers");
  });
});
