import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../src/env";
import { parseWatchRegistration, registerWatch, runDueWatches, type WatchRecord } from "../src/watch";

class MemoryBucket {
  values = new Map<string, { text: string; etag: string }>();
  sequence = 0;

  async get(key: string) {
    const value = this.values.get(key);
    if (!value) return null;
    return { etag: value.etag, json: async <T>() => JSON.parse(value.text) as T };
  }

  async put(key: string, value: string, options?: R2PutOptions) {
    const current = this.values.get(key);
    const condition = options?.onlyIf;
    if (condition && "etagDoesNotMatch" in condition && condition.etagDoesNotMatch === "*" && current) return null;
    if (condition && "etagMatches" in condition && condition.etagMatches !== current?.etag) return null;
    const etag = String(++this.sequence);
    this.values.set(key, { text: String(value), etag });
    return { key, version: etag, size: String(value).length, etag, httpEtag: etag, uploaded: new Date(), checksums: {} };
  }

  async list(options?: R2ListOptions) {
    const prefix = options?.prefix ?? "";
    return { objects: [...this.values.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
  }
}

function runtime(bucket: MemoryBucket): RuntimeEnv {
  return {
    PROOFS: bucket as unknown as R2Bucket,
    ANALYTICS: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset,
    BROWSER: { quickAction: vi.fn() } as unknown as BrowserRun,
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
  } as unknown as RuntimeEnv;
}

describe("prepaid Watch", () => {
  it("bounds quota and polling frequency", async () => {
    await expect(parseWatchRegistration({ url: "https://example.com", checks: 0, interval_seconds: 900 })).rejects.toThrow("invalid_checks");
    await expect(parseWatchRegistration({ url: "https://example.com", checks: 1, interval_seconds: 60 })).rejects.toThrow("invalid_interval_seconds");
    await expect(parseWatchRegistration({ url: "https://example.com", checks: 1001, interval_seconds: 900 })).rejects.toThrow("invalid_checks");
  });

  it("rejects underfunded quota and stores a funded registration idempotently", async () => {
    const bucket = new MemoryBucket();
    const env = runtime(bucket);
    const request = await parseWatchRegistration({ url: "https://example.com", checks: 3, interval_seconds: 900 });
    const underfunded = await registerWatch({ env, request, requestHash: "sha256:req", fingerprint: "sha256:key", partner: "rapidapi", channel: "rapidapi", grossPaidUsd: 0.001 });
    expect(underfunded.status).toBe(402);
    expect(bucket.values.size).toBe(0);

    const created = await registerWatch({ env, request, requestHash: "sha256:req", fingerprint: "sha256:key", partner: "rapidapi", channel: "rapidapi", grossPaidUsd: 0.09 });
    expect(created.status).toBe(201);
    expect(created.body.checks_remaining).toBe(3);
    const replay = await registerWatch({ env, request, requestHash: "sha256:req", fingerprint: "sha256:key", partner: "rapidapi", channel: "rapidapi", grossPaidUsd: 0.09 });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotent_replay).toBe(true);
    expect(replay.body.webhook_secret).toBeUndefined();
  });

  it("pauses a due watch before capture when its prepaid unit price falls below the current floor", async () => {
    const bucket = new MemoryBucket();
    const env = runtime(bucket);
    const record: WatchRecord = {
      schema: "delta-watch/v1",
      watch_id: "7d9d12f7-8f91-5f41-9f0c-5ef257d9ea5d",
      request_hash: "sha256:req",
      partner: "rapidapi",
      channel: "rapidapi",
      url: "https://example.com/",
      checks_purchased: 2,
      checks_remaining: 2,
      checks_attempted: 0,
      interval_seconds: 900,
      next_check_at: "2020-01-01T00:00:00.000Z",
      state: "active",
      prepaid_check_price_usd: 0.001,
      created_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2020-01-01T00:00:00.000Z",
    };
    await bucket.put(`watches/${record.watch_id}.json`, JSON.stringify(record));
    await runDueWatches(env);
    const paused = await bucket.get(`watches/${record.watch_id}.json`);
    const value = await paused!.json<WatchRecord>();
    expect(value.state).toBe("paused_margin");
    expect(value.checks_remaining).toBe(2);
    expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
});
