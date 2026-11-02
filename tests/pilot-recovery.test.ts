import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { MAX_PILOT_BROWSER_CALLS, PILOT_DEADLINE_MS } from "../src/guarded-pilot";
import { MemoryBucket, mockOrderNetwork, orderRequest, orderRuntime } from "./helpers/order-runtime";

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => undefined));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function setup(count = 2, negative = false) {
  const bucket = new MemoryBucket(), env = orderRuntime(bucket), network = mockOrderNetwork();
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).startsWith("https://example.com/") ? new Response("", { status: 200 }) : network(url)));
  const browser = vi.mocked(env.BROWSER.quickAction), original = browser.getMockImplementation()!;
  browser.mockImplementation(async (...args) => {
    const response = await original(...args), data = await response.json() as any;
    data.meta.finalUrl = (args[1] as any).url;
    return Response.json(data, { headers: { "x-browser-ms-used": "1" } });
  });
  const body = { urls: Array.from({ length: count }, (_, i) => `https://example.com/page${i + 1}`),
    ...(negative ? { preflight: { url_index: 0, expected: { contains: ["unmet condition"] } } } : {}) };
  const request = () => orderRequest({ product: "guarded-action-pilot", legacy: true, body });
  const record = () => JSON.parse([...bucket.values.entries()].find(([key]) => key.startsWith("guarded-pilot/"))![1].text);
  const key = () => [...bucket.values.keys()].find(key => key.startsWith("guarded-pilot/"))!;
  const artifacts = () => [...bucket.values.entries()].filter(([key]) => /\/(page\.html|page\.md|screenshot\.png|manifest\.json)$/.test(key));
  return { bucket, env, network, browser, body, request, record, key, artifacts };
}

describe("Pilot original-page recovery (all services isolated)", () => {
  it("resumes only failed page2 and preserves page1 bytes, time and negative Preflight", async () => {
    const s = setup(2, true), capture = s.browser.getMockImplementation()!;
    let calls = 0;
    s.browser.mockImplementation(async (...args) => ++calls === 2 ? new Response("temporary", { status: 503 }) : capture(...args));
    const first = await app.fetch(s.request(), s.env);
    expect(first.status).toBe(502); expect(await first.json()).toMatchObject({ state: "partial_failure", completed_pages: 1, retryable: true });
    const before = s.artifacts(), originalPage = s.record().progress.pages[0];
    expect(originalPage.phase).toBe("complete"); expect(originalPage.observation.preflight.safe).toBe(false);
    const retry = await app.fetch(s.request(), s.env);
    expect(retry.status).toBe(200); expect(await retry.json()).toMatchObject({ price_usd: 10, preflight: { safe: false, reason: "expectation_failed" } });
    expect(s.record().progress.pages[0]).toEqual(originalPage);
    for (const [key, artifact] of before) expect(s.bucket.values.get(key)).toEqual(artifact);
    expect(s.browser.mock.calls.map(call => (call[1] as any).url)).toEqual([s.body.urls[0], s.body.urls[1], s.body.urls[1]]);
    expect(s.network.mock.calls.filter(([url]) => String(url).endsWith("/settle"))).toHaveLength(1);
  });

  it("unknown Browser outcome never recaptures page2 or restarts page1", async () => {
    const s = setup(), capture = s.browser.getMockImplementation()!; let calls = 0;
    s.browser.mockImplementation(async (...args) => { if (++calls === 2) throw new Error("unknown provider outcome"); return capture(...args); });
    expect((await app.fetch(s.request(), s.env)).status).toBe(503);
    const before = s.artifacts();
    expect(s.record().progress.pages.map((page: any) => page.phase)).toEqual(["complete", "unknown"]);
    expect((await app.fetch(s.request(), s.env)).status).toBe(503);
    expect(s.browser).toHaveBeenCalledTimes(2); expect(s.artifacts()).toEqual(before);
  });

  it("concurrent partial recovery claims permit only one remaining-page observation", async () => {
    const s = setup(), capture = s.browser.getMockImplementation()!; let calls = 0;
    let entered!: () => void, release!: () => void;
    const active = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    s.browser.mockImplementation(async (...args) => {
      calls++;
      if (calls === 2) return new Response("temporary", { status: 503 });
      if (calls === 3) { entered(); await held; }
      return capture(...args);
    });
    expect((await app.fetch(s.request(), s.env)).status).toBe(502);
    const original = s.artifacts(), retry = app.fetch(s.request(), s.env); await active;
    expect((await app.fetch(s.request(), s.env)).status).toBe(202);
    release(); expect((await retry).status).toBe(200);
    for (const [key, artifact] of original) expect(s.bucket.values.get(key)).toEqual(artifact);
    expect(s.browser).toHaveBeenCalledTimes(3);
    expect(s.network.mock.calls.filter(([url]) => String(url).endsWith("/settle"))).toHaveLength(1);
  });

  it("a partial artifact write remains unknown and never recaptures its observed page", async () => {
    const s = setup(), put = s.bucket.put.bind(s.bucket); let htmlWrites = 0;
    s.bucket.put = async (key, value, options) => {
      if (key.endsWith("page.html") && ++htmlWrites === 2) throw new Error("simulated R2 partial failure");
      return put(key, value, options);
    };
    expect((await app.fetch(s.request(), s.env)).status).toBe(503);
    const before = s.artifacts();
    expect(s.record().progress.pages.map((page: any) => page.phase)).toEqual(["complete", "observed"]);
    expect((await app.fetch(s.request(), s.env)).status).toBe(503);
    expect(s.browser).toHaveBeenCalledTimes(2); expect(s.artifacts()).toEqual(before);
  });

  it("reconciles a fully stored page after its phase checkpoint failed and then resumes pending pages", async () => {
    const s = setup(), put = s.bucket.put.bind(s.bucket); let interrupted = false;
    s.bucket.put = async (key, value, options) => {
      if (!interrupted && key.startsWith("guarded-pilot/") && JSON.parse(String(value)).progress?.pages[0].phase === "complete") {
        interrupted = true; throw new Error("lost page checkpoint");
      }
      return put(key, value, options);
    };
    expect((await app.fetch(s.request(), s.env)).status).toBe(503);
    const original = s.artifacts();
    // The original worker is absent; expire its lease without altering its pages.
    const record = s.record(); await put(s.key(), JSON.stringify({ ...record, updated_at: "2020-01-01T00:00:00.000Z" }));
    const recovered = await app.fetch(s.request(), s.env);
    expect(recovered.status).toBe(200);
    expect(s.browser.mock.calls.map(call => (call[1] as any).url)).toEqual(s.body.urls);
    for (const [key, artifact] of original) expect(s.bucket.values.get(key)).toEqual(artifact);
  });

  it.each([1, 2, 3])("%s pages retain exactly one10USDC settlement and allocation sum", async (count) => {
    const s = setup(count); const first = await app.fetch(s.request(), s.env);
    expect(first.status).toBe(200);
    const result = await first.json() as any;
    expect(result.price_usd).toBe(10); expect(result.proofs.reduce((sum: number, proof: any) => sum + proof.allocated_price_usd, 0)).toBe(10);
    expect((await app.fetch(s.request(), s.env)).status).toBe(200);
    expect(s.browser).toHaveBeenCalledTimes(count);
    expect(s.network.mock.calls.filter(([url]) => String(url).endsWith("/settle"))).toHaveLength(1);
  });

  it("exhausted conservative call budget blocks unfinished pages rather than adding paid work", async () => {
    const s = setup(3), capture = s.browser.getMockImplementation()!; let calls = 0;
    s.browser.mockImplementation(async (...args) => ++calls === 2 ? new Response("temporary", { status: 503 }) : capture(...args));
    expect((await app.fetch(s.request(), s.env)).status).toBe(502);
    expect((await app.fetch(s.request(), s.env)).status).toBe(503);
    expect(s.record().state).toBe("blocked_failure"); expect(s.record().error).toBe("pilot_budget_exhausted");
    expect(s.browser).toHaveBeenCalledTimes(MAX_PILOT_BROWSER_CALLS);
    expect((await app.fetch(s.request(), s.env)).status).toBe(503); expect(s.browser).toHaveBeenCalledTimes(MAX_PILOT_BROWSER_CALLS);
  });

  it("corrupted page decision digest cannot become aggregate success or another capture", async () => {
    const s = setup(1, true); expect((await app.fetch(s.request(), s.env)).status).toBe(200);
    const record = s.record(); record.progress.pages[0].observation.preflight.safe = true;
    await s.bucket.put(s.key(), JSON.stringify(record));
    expect((await app.fetch(s.request(), s.env)).status).toBe(503); expect(s.browser).toHaveBeenCalledTimes(1);
  });

  it("whole-operation deadline bounds multi-page persistence and prevents late phase commits", async () => {
    const s = setup(3), put = s.bucket.put.bind(s.bucket);
    const entries = Array.from({ length: 3 }, () => {
      let entered!: () => void, release!: () => void, browserEntered!: () => void, browserRelease!: () => void;
      const active = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
      const browserActive = new Promise<void>(resolve => { browserEntered = resolve; }), browserHeld = new Promise<void>(resolve => { browserRelease = resolve; });
      return { active, held, entered, release, browserActive, browserHeld, browserEntered, browserRelease };
    });
    const browser = s.browser.getMockImplementation()!;
    let browserIndex = 0;
    s.browser.mockImplementation(async (...args) => {
      const entry = entries[browserIndex++]; entry.browserEntered(); await entry.browserHeld;
      return browser(...args);
    });
    let index = 0;
    s.bucket.put = async (key, value, options) => {
      if (key.endsWith("page.html")) { const entry = entries[index++]; entry.entered(); await entry.held; }
      return put(key, value, options);
    };
    vi.useFakeTimers();
    const running = app.fetch(s.request(), s.env);
    for (let page = 0; page < 2; page++) {
      await entries[page].browserActive;
      await vi.advanceTimersByTimeAsync(20_000);
      entries[page].browserRelease();
      await entries[page].active;
      // Each write is below its new15s boundary; only the whole90s budget
      // expires during page3. Do not weaken either independent constraint.
      await vi.advanceTimersByTimeAsync(14_000);
      entries[page].release();
    }
    await entries[2].browserActive;
    await vi.advanceTimersByTimeAsync(10_000);
    entries[2].browserRelease();
    await entries[2].active;
    await vi.advanceTimersByTimeAsync(PILOT_DEADLINE_MS - 78_000 + 1);
    expect((await running).status).toBe(503);
    const record = s.record();
    entries[2].release();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.record()).toEqual(record);
    expect(s.browser).toHaveBeenCalledTimes(MAX_PILOT_BROWSER_CALLS);
    expect(record.progress.pages.filter((page: any) => page.phase === "complete")).toHaveLength(2);
    expect(s.record().state).not.toBe("complete");
  });
});
