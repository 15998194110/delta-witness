import { describe, expect, it } from "vitest";
import {
  BASE_NETWORK,
  assertPaymentStorageAvailable,
  CANONICAL_USDC,
  clearPaymentAttempt,
  markSignedPaymentRequest,
  PAYMENT_ATTEMPT_KEY,
  TREASURY,
  maxPaymentUsd,
  isDelivery,
  isHttpSourceUrl,
  parsePurchaseParams,
  paymentNeedsRecovery,
  paymentPolicy,
  prepareBrowserPaymentRequest,
  purchaseOutcome,
  rawPaymentAmount,
  readPaymentAttempt,
  requestBody,
  updatePurchaseSearch,
  validateQuote,
  type PaymentStorage,
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

describe("paid response handling", () => {
  const proofId = "7d9d12f7-8f91-5f41-9f0c-5ef257d9ea5d";
  const delivery = {
    ok: true,
    product: "capture",
    proof_id: proofId,
    public_proof_url: `https://delta-witness-api.ruphussten.workers.dev/p/${proofId}`,
    manifest_url: `https://delta-witness-api.ruphussten.workers.dev/v1/proofs/${proofId}`,
    bundle_root: `sha256:${"a".repeat(64)}`,
    observed_at: "2026-09-30T12:00:00.000Z",
  };

  it("accepts only a complete response matching the purchased product", () => {
    expect(purchaseOutcome(200, delivery, "capture")).toEqual({ state: "complete", delivery });
    expect(isDelivery(delivery, "preflight")).toBe(false);
    const preflight = { ...delivery, product: "preflight", safe: false, changed: true, reason: "changed" };
    expect(purchaseOutcome(200, preflight, "preflight")).toEqual({ state: "complete", delivery: preflight });
    expect(isDelivery({ ...preflight, safe: null, changed: null }, "preflight")).toBe(true);
    expect(isDelivery({ ...delivery, product: "preflight" }, "preflight")).toBe(false);
  });

  it.each([
    [202, { ok: false, state: "processing", retryable: true }],
    [202, delivery],
    [202, null],
    [200, { ok: false, state: "processing" }],
  ])("keeps HTTP %s processing responses out of the proof renderer", (status, body) => {
    const outcome = purchaseOutcome(status as number, body, "capture");
    expect(outcome.state).toBe("processing");
    expect(outcome).not.toHaveProperty("delivery");
    if (outcome.state !== "complete") expect(outcome.message).toContain("Do not approve another payment");
  });

  it.each([
    null,
    [],
    { ok: false },
    { ...delivery, proof_id: undefined },
    { ...delivery, proof_id: "not-a-proof" },
    { ...delivery, observed_at: "invalid-date" },
    { ...delivery, bundle_root: "unverified" },
    { ...delivery, reason: {} },
    { ...delivery, public_proof_url: "javascript:alert(1)" },
    { ...delivery, public_proof_url: "https://unrelated.example/p/proof" },
    { ...delivery, manifest_url: "https://delta-witness-api.ruphussten.workers.dev/docs" },
    { ...delivery, product: "preflight" },
  ])("rejects malformed success body %# without rendering missing proof fields", (body) => {
    const outcome = purchaseOutcome(200, body, "capture");
    expect(outcome.state).toBe("uncertain");
    expect(outcome).not.toHaveProperty("delivery");
  });

  it("does not treat a retryable 502 promise as proof of payment or delivery", () => {
    const outcome = purchaseOutcome(502, { error: "capture_failed", retryable: true, payment_will_not_be_charged_again: true }, "capture");
    expect(outcome.state).toBe("retryable_failure");
    expect(outcome).not.toHaveProperty("delivery");
    if (outcome.state !== "complete") {
      expect(outcome.message).toContain("Payment status is not confirmed");
      expect(outcome.message).toContain("Do not approve another payment");
    }
    expect(purchaseOutcome(500, { error: "internal_error" }, "capture").state).toBe("uncertain");
    expect(purchaseOutcome(402, { error: "payment_required" }, "capture").state).toBe("uncertain");
  });

  it("blocks fresh payment for every unresolved outcome", () => {
    for (const state of ["processing", "retryable_failure", "uncertain"]) expect(paymentNeedsRecovery(state)).toBe(true);
    for (const state of ["idle", "connecting", "paying", "complete", "error"]) expect(paymentNeedsRecovery(state)).toBe(false);
  });
});

describe("browser payment transport", () => {
  it("strips only the SDK response-only request header and preserves signed payment identity/body", async () => {
    const controller = new AbortController();
    const body = JSON.stringify({ url: "https://example.org/terms" });
    const original = new Request("https://delta-witness-api.ruphussten.workers.dev/v1/capture", {
      method: "POST",
      headers: {
        "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
        "payment-signature": "test-signed-payment-unchanged",
        "x-payment": "test-legacy-payment-unchanged",
        "content-type": "application/json",
        "x-delta-channel": "base-app",
      },
      body,
      credentials: "omit",
      signal: controller.signal,
    });
    const request = prepareBrowserPaymentRequest(original.clone());
    expect(request.headers.has("access-control-expose-headers")).toBe(false);
    expect(original.headers.has("access-control-expose-headers")).toBe(true);
    expect(request.url).toBe(original.url);
    expect(request.method).toBe("POST");
    expect(request.credentials).toBe("omit");
    expect(Object.fromEntries(request.headers)).toEqual({
      "content-type": "application/json",
      "payment-signature": "test-signed-payment-unchanged",
      "x-delta-channel": "base-app",
      "x-payment": "test-legacy-payment-unchanged",
    });
    expect(await request.text()).toBe(body);
    expect(await original.text()).toBe(body);
    controller.abort();
    expect(request.signal.aborted).toBe(true);
  });

  it("accepts fetch input/init without adding or changing payment headers", async () => {
    const request = prepareBrowserPaymentRequest(new URL("https://delta-witness-api.ruphussten.workers.dev/v1/capture"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-delta-channel": "base-app" },
      body: '{"url":"https://example.org/"}',
    });
    expect(request.headers.has("payment-signature")).toBe(false);
    expect(request.headers.has("access-control-expose-headers")).toBe(false);
    expect(await request.json()).toEqual({ url: "https://example.org/" });
  });
});

describe("durable nonsecret payment markers", () => {
  function storage(): PaymentStorage {
    const values = new Map<string, string>();
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
  }

  it("probes writes and cleanup without overwriting the recovery marker", () => {
    const saved = storage();
    saved.setItem(PAYMENT_ATTEMPT_KEY, "existing-recovery-marker");
    assertPaymentStorageAvailable(saved);
    expect(saved.getItem(PAYMENT_ATTEMPT_KEY)).toBe("existing-recovery-marker");
    expect(saved.getItem(`${PAYMENT_ATTEMPT_KEY}:probe`)).toBeNull();
    expect(() => assertPaymentStorageAvailable({ ...saved, removeItem: () => {} })).toThrow("storage is unavailable");
  });

  it("does not persist an unsigned challenge request", async () => {
    const saved = storage();
    expect(await markSignedPaymentRequest(new Request("https://delta.example/v1/capture"), saved, "capture")).toBeNull();
    expect(readPaymentAttempt(saved)).toBeNull();
  });

  it("persists only an opaque signed-header fingerprint and minimal recovery metadata", async () => {
    const saved = storage();
    const request = new Request("https://delta.example/v1/capture", { method: "POST", headers: { "payment-signature": "synthetic-test-header" }, body: '{"url":"https://private-looking.example/source"}' });
    const marker = await markSignedPaymentRequest(request, saved, "capture");
    expect(marker).toEqual({ version: 1, product: "capture", startedAt: expect.any(String), attemptId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), phase: "signed_request" });
    const raw = saved.getItem(PAYMENT_ATTEMPT_KEY)!;
    expect(raw).not.toContain("synthetic-test-header");
    expect(raw).not.toContain("private-looking");
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["attemptId", "phase", "product", "startedAt", "version"]);
    expect(await markSignedPaymentRequest(request, saved, "capture")).toEqual(marker);
    expect(readPaymentAttempt(saved)).toEqual(marker);
  });

  it("supports legacy payment identity and refuses to clear another attempt", async () => {
    const saved = storage();
    const marker = await markSignedPaymentRequest(new Request("https://delta.example/", { headers: { "x-payment": "legacy-test-header" } }), saved, "preflight");
    expect(() => clearPaymentAttempt(saved, `sha256:${"0".repeat(64)}`)).toThrow();
    expect(readPaymentAttempt(saved)).toEqual(marker);
    clearPaymentAttempt(saved, marker!.attemptId);
    expect(readPaymentAttempt(saved)).toBeNull();
  });

  it("never overwrites a different unresolved signed request", async () => {
    const saved = storage();
    const first = await markSignedPaymentRequest(new Request("https://delta.example/", { headers: { "payment-signature": "first" } }), saved, "capture");
    await expect(markSignedPaymentRequest(new Request("https://delta.example/", { headers: { "payment-signature": "second" } }), saved, "capture")).rejects.toThrow();
    expect(readPaymentAttempt(saved)).toEqual(first);
  });

  it("fails closed for corrupt or silently nonpersistent storage", async () => {
    const saved = storage();
    saved.setItem(PAYMENT_ATTEMPT_KEY, "corrupt");
    expect(() => readPaymentAttempt(saved)).toThrow();
    const discardsWrites: PaymentStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    await expect(markSignedPaymentRequest(new Request("https://delta.example/", { headers: { "payment-signature": "header" } }), discardsWrites, "capture")).rejects.toThrow();
  });
});

describe("shareable purchase links", () => {
  it("prefills a buyer-facing Capture request from a link without executing it", () => {
    expect(parsePurchaseParams("?product=capture&url=https%3A%2F%2Fexample.org%2Fpricing")).toEqual({
      product: "capture",
      url: "https://example.org/pricing",
      mustContain: "",
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
      url: "",
      mustContain: "Policy",
    });
  });

  it("starts empty rather than suggesting payment for a fixture", () => {
    expect(parsePurchaseParams("")).toEqual({ product: "capture", url: "", mustContain: "" });
    expect(parsePurchaseParams("?product=preflight")).toEqual({ product: "preflight", url: "", mustContain: "" });
  });

  it("requires a supplied HTTP(S) source without URL credentials", () => {
    for (const value of ["", " ", "example.org", "javascript:alert(1)", "https://user:password@example.org/"]) expect(isHttpSourceUrl(value)).toBe(false);
    expect(isHttpSourceUrl("https://example.org/terms")).toBe(true);
    expect(isHttpSourceUrl("http://example.org/terms")).toBe(true);
  });

  it("does not serialize invalid or credential-bearing sources or their rules", () => {
    for (const url of ["", "javascript:alert(1)", "https://user:password@example.org/"]) {
      const params = new URLSearchParams(updatePurchaseSearch("?url=old&contains=old&utm_source=buyer", { product: "preflight", url, mustContain: "private text" }));
      expect(params.has("url")).toBe(false);
      expect(params.has("contains")).toBe(false);
      expect(params.get("utm_source")).toBe("buyer");
    }
  });
});
