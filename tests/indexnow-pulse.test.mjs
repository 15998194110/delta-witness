import { describe, expect, it, vi } from "vitest";
import { runIndexNowPulse } from "../scripts/indexnow-pulse.mjs";

describe("IndexNow discovery pulse", () => {
  it("retries retryable failures and records the eventual success", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{"ok":false,"status":503}', { status: 502 }))
      .mockResolvedValueOnce(new Response('{"ok":true,"status":200}', { status: 200 }));
    const sleep = vi.fn(async () => undefined);
    const log = vi.fn();
    const result = await runIndexNowPulse("core", {
      adminSecret: "secret",
      attempts: 4,
      fetchImpl,
      sleep,
      log,
    });

    expect(result).toEqual({ ok: true, target: "core", attempts: 2, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(log.mock.calls[0][0]).toMatchObject({ target: "core", http_status: 502, retryable: true });
    expect(JSON.stringify(log.mock.calls)).not.toContain("Bearer secret");
  });

  it("does not retry a permanent authorization failure", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 }));
    const sleep = vi.fn(async () => undefined);
    const result = await runIndexNowPulse("core", {
      adminSecret: "secret",
      attempts: 4,
      fetchImpl,
      sleep,
      log: vi.fn(),
    });

    expect(result).toMatchObject({ ok: false, target: "core", attempts: 1, status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails safely before making a request when the admin secret is missing", async () => {
    const fetchImpl = vi.fn();
    const result = await runIndexNowPulse("core", {
      adminSecret: "",
      fetchImpl,
      log: vi.fn(),
    });

    expect(result).toEqual({ ok: false, target: "core", error: "missing_admin_secret", attempts: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
