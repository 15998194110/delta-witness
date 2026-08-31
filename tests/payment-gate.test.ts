import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import type { RuntimeEnv } from "../src/env";

const supported = {
  kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
  extensions: ["bazaar"],
  signers: { "eip155:*": ["0xc6699d2aadA6c36Dfea5C248DD70f9CB0235cB63"] },
};

function runtime(browser: { quickAction: ReturnType<typeof vi.fn> }): RuntimeEnv {
  return {
    PROOFS: { get: vi.fn(async () => null) } as unknown as R2Bucket,
    ANALYTICS: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset,
    BROWSER: browser as unknown as BrowserRun,
    APP_VERSION: "0.6.0",
    PAY_TO: "0x1990e21bc219696ff7fbc26527dbaed335ac6367",
    NETWORK: "eip155:8453",
    CAPTURE_BASE_PRICE_USD: "0.01",
    PREFLIGHT_BASE_PRICE_USD: "0.01",
    BROWSER_COST_PER_HOUR_USD: "0.09",
    FACILITATOR_FEE_USD: "0.001",
    FAILURE_ALLOWANCE_USD: "0.001",
    WORKER_ALLOWANCE_USD: "0.0001",
    R2_WRITE_COST_PER_MILLION_USD: "4.5",
    R2_STORAGE_GB_MONTH_USD: "0.015",
    PRICING_BROWSER_MS: "25000",
    PRICING_STORAGE_BYTES: "9000000",
    TARGET_MARGIN_BPS: "6500",
    FACILITATOR_URL: "https://facilitator.test",
    PUBLIC_ORIGIN: "https://delta.test",
    DEMO_PROOF_ID: "56347db8-1aa5-447f-a0e4-3bb052d7aa89",
    INDEXNOW_KEY: "test-key",
  } as unknown as RuntimeEnv;
}

afterEach(() => vi.unstubAllGlobals());

describe("payment hard gate", () => {
  it("serves only the configured IndexNow ownership key", async () => {
    const env = runtime({ quickAction: vi.fn() });
    const valid = await app.request("https://delta.test/test-key.txt", {}, env);
    const invalid = await app.request("https://delta.test/not-the-key.txt", {}, env);
    expect(valid.status).toBe(200);
    expect(await valid.text()).toBe("test-key");
    expect(invalid.status).toBe(404);
  });

  it("returns 402 without ever invoking Browser Run", async () => {
    const browser = { quickAction: vi.fn() };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://cloudflare-dns.com/")) {
        const type = new URL(url).searchParams.get("type");
        return Response.json(type === "A" ? { Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] } : { Status: 0, Answer: [] });
      }
      if (url === "https://example.com/") return new Response("", { status: 200 });
      if (url === "https://facilitator.test/supported") return Response.json(supported);
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const response = await app.request("https://delta.test/v1/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    }, runtime(browser));
    expect(response.status).toBe(402);
    expect(browser.quickAction).not.toHaveBeenCalled();
    const paymentRequired = response.headers.get("payment-required");
    expect(paymentRequired).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(paymentRequired!, "base64").toString("utf8"));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts[0].network).toBe("eip155:8453");
    expect(decoded.accepts[0].extra.paymentFlow).toBe("upfront");
  });

  it("returns a 402 challenge before validating a missing body", async () => {
    const browser = { quickAction: vi.fn() };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://facilitator.test/supported") return Response.json(supported);
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const response = await app.request("https://delta.test/v1/capture", {
      method: "POST",
    }, runtime(browser));
    expect(response.status).toBe(402);
    expect(response.headers.get("payment-required")).toBeTruthy();
    expect(browser.quickAction).not.toHaveBeenCalled();
  });

  it("returns a 402 challenge before validating an unsafe URL", async () => {
    const browser = { quickAction: vi.fn() };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://facilitator.test/supported") return Response.json(supported);
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const response = await app.request("https://delta.test/v1/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data" }),
    }, runtime(browser));
    expect(response.status).toBe(402);
    expect(browser.quickAction).not.toHaveBeenCalled();
    expect(response.headers.get("payment-required")).toBeTruthy();
  });
});
