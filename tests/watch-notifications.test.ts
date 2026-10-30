import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWatchRegistration, registerWatch, runDueWatches, type WatchRecord, type WatchNotification } from "../src/watch";
import { MemoryBucket, orderRuntime } from "./helpers/order-runtime";
// @ts-expect-error Importable JavaScript sample intentionally has no generated declarations.
import { receiveWatchWebhook } from "../examples/watch-webhook-receiver.mjs";
import { hmacSha256 } from "../src/crypto";
import { createOrderReadSnapshot } from "../src/order-storage";

class WatchBucket extends MemoryBucket {
  async list(options?: R2ListOptions) {
    return { objects: [...this.values.keys()].filter(key => key.startsWith(options?.prefix ?? "")).map(key => ({key})), truncated: false };
  }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function setup(send: (request: Request) => Promise<Response> = async () => new Response(null, {status: 204}), checks = 1, expected?: WatchRecord["expected"]) {
  const bucket = new WatchBucket(), env = orderRuntime(bucket);
  const requests: Request[] = [];
  const network = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.hostname === "cloudflare-dns.com") return Response.json(url.searchParams.get("type") === "A" ? {Status: 0, Answer: [{type: 1, data: "93.184.216.34"}]} : {Status: 0, Answer: []});
    if (url.hostname === "example.com") return new Response("", {status: 200});
    if (url.hostname === "webhook.test") { requests.push(request.clone()); return send(request); }
    throw new Error("unmocked_network");
  });
  vi.stubGlobal("fetch", network);
  const request = await parseWatchRegistration({url: "https://example.com/", checks, interval_seconds: 900, webhook_url: "https://webhook.test/events", ...(expected ? {expected} : {})});
  const result = await registerWatch({ env, request,
    requestHash: "sha256:watch-fixture", fingerprint: "sha256:watch-notification-fixture", partner: "fixture", channel: "fixture", grossPaidUsd: checks });
  const key = `watches/${result.body.watch_id}.json`;
  const watch = JSON.parse(bucket.values.get(key)!.text);
  await bucket.put(key, JSON.stringify({...watch, next_check_at: "2020-01-01T00:00:00Z"}));
  const readWatch = () => JSON.parse(bucket.values.get(key)!.text) as WatchRecord;
  const events = () => [...bucket.values.entries()].filter(([key]) => key.startsWith("watch-notifications/")).map(([key, value]) => ({key, event: JSON.parse(value.text) as WatchNotification}));
  return {bucket, env, network, requests, key, readWatch, events, secret: result.body.webhook_secret as string};
}

describe("Watch independent notification journal", () => {
  it("concurrent schedulers consume a slot once and deliver one stable event", async () => {
    const state = await setup();
    await Promise.all([runDueWatches(state.env), runDueWatches(state.env)]);
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
    expect(state.readWatch()).toMatchObject({checks_attempted: 1, checks_remaining: 0, state: "exhausted"});
    expect(state.events()).toHaveLength(1);
    expect(state.events()[0].event).toMatchObject({attempts: 1, state: "delivered"});
    expect(state.requests).toHaveLength(1);
    const request = state.requests[0], raw = await request.text();
    expect(request.redirect).toBe("manual");
    expect(JSON.parse(raw).event_id).toBe(request.headers.get("x-delta-event-id"));
    expect(request.headers.get("x-delta-signature")).toBe(`sha256=${await hmacSha256(state.secret, `${request.headers.get("x-delta-timestamp")}.${raw}`)}`);
    await runDueWatches(state.env);
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
    expect(state.requests).toHaveLength(1);
  });

  it("retries the same notification with bounded backoff without a new check or quota debit", async () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-10-29T00:00:00Z");
    const state = await setup(async () => new Response(null, {status: 503}));
    await runDueWatches(state.env);
    const body = state.events()[0].event.raw_body, created = state.events()[0].event.created_at;
    for (let index = 1; index < 5; index++) {
      vi.setSystemTime(Date.parse(state.events()[0].event.next_attempt_at) + 1);
      await Promise.all([runDueWatches(state.env), runDueWatches(state.env)]);
    }
    expect(state.events()[0].event).toMatchObject({state: "failed", attempts: 5, raw_body: body, created_at: created, last_outcome: "http_503"});
    vi.setSystemTime(Date.now() + 100_000_000); await runDueWatches(state.env);
    expect(state.requests).toHaveLength(5);
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
    expect(state.readWatch()).toMatchObject({checks_attempted: 1, checks_remaining: 0});
    expect(new Set(await Promise.all(state.requests.map(request => request.text()))).size).toBe(1);
    expect(new Set(state.requests.map(request => request.headers.get("x-delta-timestamp"))).size).toBe(5);
  });

  it.each(["paused", "paused_margin", "expired", "exhausted"])("%s stops checks but still retries a committed notification", async stateName => {
    vi.useFakeTimers(); vi.setSystemTime("2026-10-29T00:00:00Z");
    let fail = true;
    const state = await setup(async () => new Response(null, {status: fail ? 500 : 204}));
    await runDueWatches(state.env);
    await state.bucket.put(state.key, JSON.stringify({...state.readWatch(), state: stateName}));
    const watchBefore = state.readWatch();
    fail = false; vi.setSystemTime(Date.parse(state.events()[0].event.next_attempt_at) + 1);
    await runDueWatches(state.env);
    expect(state.events()[0].event).toMatchObject({state: "delivered", attempts: 2});
    expect(state.readWatch()).toEqual(watchBefore);
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });

  it.each(["paused", "expiry", "exhausted"])("does not start a check when %s already applies", async kind => {
    const state = await setup();
    const watch = state.readWatch();
    await state.bucket.put(state.key, JSON.stringify({...watch, ...(kind === "expiry" ? {expires_at: "2020-01-01T00:00:00Z"} : kind === "exhausted" ? {state: "exhausted", checks_remaining: 0, checks_attempted: 1} : {state: "paused"})}));
    await runDueWatches(state.env);
    expect(state.env.BROWSER.quickAction).not.toHaveBeenCalled(); expect(state.requests).toHaveLength(0);
  });

  it("recovers an interrupted outbox promotion without repeating the capture", async () => {
    const state = await setup();
    const put = state.bucket.put.bind(state.bucket); let fail = true;
    state.bucket.put = async (key, value, options) => { if (fail && key.startsWith("watch-notifications/")) throw new Error("synthetic_promotion_loss"); return put(key, value, options); };
    await runDueWatches(state.env);
    const pending = state.readWatch().pending_notification!;
    expect(pending.event_id).toBeTruthy(); expect(state.requests).toHaveLength(0);
    fail = false; await runDueWatches(state.env);
    expect(state.readWatch().pending_notification).toBeUndefined();
    expect(state.events()[0].event).toMatchObject({event_id: pending.event_id, raw_body: pending.raw_body, state: "delivered"});
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });

  it("a check-list failure does not suppress an earlier queued notification", async () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-10-29T00:00:00Z");
    let fail = true;
    const state = await setup(async () => new Response(null, {status: fail ? 503 : 204}));
    await runDueWatches(state.env);
    const list = state.bucket.list.bind(state.bucket);
    state.bucket.list = async options => { if (options?.prefix === "watches/") throw new Error("synthetic_check_list_failure"); return list(options); };
    fail = false; vi.setSystemTime(Date.parse(state.events()[0].event.next_attempt_at) + 1);
    await expect(runDueWatches(state.env)).rejects.toThrow("synthetic_check_list_failure");
    expect(state.events()[0].event).toMatchObject({state: "delivered", attempts: 2});
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });

  it("corrupted persisted event bytes never become a webhook or another check", async () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-10-29T00:00:00Z");
    const state = await setup(async () => new Response(null, {status: 500}));
    await runDueWatches(state.env);
    const {key, event} = state.events()[0];
    await state.bucket.put(key, JSON.stringify({...event, raw_body: event.raw_body + " "}));
    vi.setSystemTime(Date.parse(event.next_attempt_at) + 1);
    await runDueWatches(state.env);
    expect(state.requests).toHaveLength(1);
    expect(state.events()[0].event.state).toBe("retry_wait");
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });

  it("an incomplete capture retains the prior baseline and publishes no change assertion", async () => {
    const state = await setup();
    const prior = "22222222-2222-5222-8222-222222222222";
    await state.bucket.put(state.key, JSON.stringify({...state.readWatch(), last_proof_id: prior}));
    vi.mocked(state.env.BROWSER.quickAction).mockResolvedValue(Response.json({success: true, result: {content: "incomplete", markdown: "partial"}}));
    await runDueWatches(state.env);
    const watch = state.readWatch();
    expect(watch.last_proof_id).toBe(prior);
    expect(watch.last_result).toMatchObject({ok: false, reason: "capture_incomplete"});
    expect(watch.last_result).not.toHaveProperty("changed");
    expect(JSON.parse(state.events()[0].event.raw_body)).not.toHaveProperty("changed");
  });

  it("lost ACK retries an identical event and the receiver durably accepts it once", async () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-10-29T00:00:00Z");
    const inboxRows = new Map<string, string>(); let calls = 0, secret = "";
    const inbox = {accept: async (id: string, hash: string) => { if (inboxRows.has(id)) return inboxRows.get(id) === hash ? "duplicate" : "conflict"; inboxRows.set(id, hash); return "accepted"; }};
    const state = await setup(async request => {
      const response = await receiveWatchWebhook(request, {secret, inbox});
      if (++calls === 1) throw new Error("ack_lost");
      return response;
    });
    secret = state.secret;
    await runDueWatches(state.env);
    expect(state.events()[0].event).toMatchObject({state: "retry_wait", last_outcome: "delivery_unknown"});
    vi.setSystemTime(Date.parse(state.events()[0].event.next_attempt_at) + 1); await runDueWatches(state.env);
    expect(inboxRows.size).toBe(1); expect(state.requests).toHaveLength(2);
    expect(state.events()[0].event.state).toBe("delivered"); expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });

  it("an expired in-flight notification lease can retry only the same event, never another slot", async () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-10-29T00:00:00Z");
    const state = await setup();
    const put = state.bucket.put.bind(state.bucket); let loseCommit = true;
    state.bucket.put = async (key, value, options) => {
      if (loseCommit && key.startsWith("watch-notifications/") && JSON.parse(String(value)).state === "delivered") throw new Error("delivery_commit_lost");
      return put(key, value, options);
    };
    await runDueWatches(state.env);
    expect(state.events()[0].event.state).toBe("delivering");
    const original = state.events()[0].event;
    loseCommit = false; vi.setSystemTime(Date.parse(original.lease_until!) + 1); await runDueWatches(state.env);
    expect(state.events()[0].event).toMatchObject({event_id: original.event_id, raw_body: original.raw_body, attempts: 2, state: "delivered"});
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });

  it("non-cooperative transport is bounded and its late success cannot mark delivery complete", async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const state = await setup(() => new Promise(done => { resolve = done; }));
    const pending = runDueWatches(state.env);
    await vi.waitFor(() => expect(state.requests).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(15_001); await pending;
    expect(state.events()[0].event).toMatchObject({state: "retry_wait", last_outcome: "notification_timeout"});
    resolve(new Response(null, {status: 204})); await Promise.resolve(); await Promise.resolve();
    expect(state.events()[0].event.state).toBe("retry_wait");
  });

  it("rejects a changed private DNS destination before webhook POST", async () => {
    const state = await setup();
    const network = state.network.getMockImplementation()!;
    state.network.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "cloudflare-dns.com" && url.searchParams.get("name") === "webhook.test") return Response.json({Status: 0, Answer: [{type: 1, data: "127.0.0.1"}]});
      return network(input, init);
    });
    await runDueWatches(state.env);
    expect(state.requests).toHaveLength(0);
    expect(state.events()[0].event).toMatchObject({state: "failed", last_outcome: "private_dns_target_not_allowed"});
  });

  it("does not follow webhook redirects or retry a permanent rejection", async () => {
    const state = await setup(async () => new Response(null, {status: 302, headers: {location: "http://169.254.169.254/"}}));
    await runDueWatches(state.env); await runDueWatches(state.env);
    expect(state.requests).toHaveLength(1);
    expect(state.events()[0].event).toMatchObject({state: "failed", last_outcome: "http_302"});
  });

  it("receiver rejects altered bodies, expired timestamps and event substitution before inbox effects", async () => {
    const state = await setup(); await runDueWatches(state.env);
    const original = state.requests[0], raw = await original.text(), inbox = {accept: vi.fn(async () => "accepted")};
    const valid = () => new Request(original.url, {method: "POST", headers: original.headers, body: raw});
    expect((await receiveWatchWebhook(new Request(original.url, {method: "POST", headers: original.headers, body: raw + " "}), {secret: state.secret, inbox})).status).toBe(401);
    expect((await receiveWatchWebhook(valid(), {secret: state.secret, inbox, nowSeconds: Number(original.headers.get("x-delta-timestamp")) + 301})).status).toBe(401);
    const changed = valid(); changed.headers.set("x-delta-event-id", "22222222-2222-5222-8222-222222222222");
    expect((await receiveWatchWebhook(changed, {secret: state.secret, inbox})).status).toBe(401);
    expect(inbox.accept).not.toHaveBeenCalled();
  });

  it("receiver bounds a stalled body and rejects an oversized body without inbox effects", async () => {
    const state = await setup(); await runDueWatches(state.env);
    const original = state.requests[0], inbox = {accept: vi.fn(async () => "accepted")};
    const oversized = new Request(original.url, {method: "POST", headers: original.headers, body: "x".repeat(32_001)});
    expect((await receiveWatchWebhook(oversized, {secret: state.secret, inbox})).status).toBe(413);
    vi.useFakeTimers();
    const stalled = new Request(original.url, {method: "POST", headers: original.headers, body: new ReadableStream(), duplex: "half"} as RequestInit);
    const pending = receiveWatchWebhook(stalled, {secret: state.secret, inbox});
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await pending).status).toBe(408);
    expect(inbox.accept).not.toHaveBeenCalled();
  });

  it.each(["get", "body", "claim", "final"])("bounds notification %s storage stalls and prevents late webhook work", async stage => {
    vi.useFakeTimers(); vi.setSystemTime("2026-10-30T00:00:00Z");
    let success = false;
    const state = await setup(async () => new Response(null, {status: success ? 204 : 503}));
    await runDueWatches(state.env); success = true;
    const {key, event} = state.events()[0];
    vi.setSystemTime(Date.parse(event.next_attempt_at) + 1);
    const get = state.bucket.get.bind(state.bucket), put = state.bucket.put.bind(state.bucket);
    let reached = false;
    const releases: Array<() => void> = [];
    state.bucket.get = async name => {
      const object = await get(name);
      if (name !== key || (stage !== "get" && stage !== "body")) return object;
      reached = true;
      if (stage === "get") return new Promise(resolve => { releases.push(() => resolve(object)); });
      return {...object!, body: new ReadableStream<Uint8Array>()};
    };
    state.bucket.put = async (name, value, options) => {
      const row = name === key ? JSON.parse(String(value)) : null;
      if (row && ((stage === "claim" && row.state === "delivering") || (stage === "final" && row.state === "delivered"))) {
        reached = true;
        return new Promise(resolve => { releases.push(() => { void put(name, value, options).then(resolve); }); });
      }
      return put(name, value, options);
    };
    const pending = runDueWatches(state.env);
    await vi.waitFor(() => expect(reached).toBe(true));
    await vi.advanceTimersByTimeAsync(20_001); await pending;
    expect(state.requests).toHaveLength(stage === "final" ? 2 : 1);
    expect(state.events()[0].event.state).toBe(stage === "final" ? "delivering" : "retry_wait");
    releases.forEach(release => release()); await vi.advanceTimersByTimeAsync(1);
    expect(state.requests).toHaveLength(stage === "final" ? 2 : 1);
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });

  it("outbox promotion has a whole-operation deadline and retains its pending identity", async () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-10-30T00:00:00Z");
    const state = await setup();
    const put = state.bucket.put.bind(state.bucket);
    let release!: () => void, reached = false;
    state.bucket.put = async (key, value, options) => {
      if (key.startsWith("watch-notifications/")) {
        reached = true;
        return new Promise(resolve => { release = () => { void put(key, value, options).then(resolve); }; });
      }
      return put(key, value, options);
    };
    const pending = runDueWatches(state.env);
    await vi.waitFor(() => expect(reached).toBe(true));
    await vi.advanceTimersByTimeAsync(20_001); await pending;
    const event = state.readWatch().pending_notification!;
    expect(event.event_id).toBeTruthy(); expect(state.requests).toHaveLength(0);
    release(); await vi.advanceTimersByTimeAsync(1);
    expect(state.readWatch().pending_notification?.event_id).toBe(event.event_id);
    expect(state.requests).toHaveLength(0);
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });

  it.each(["declared", "actual", "truncated"])("rejects %s invalid metadata byte length before retrying", async mode => {
    vi.useFakeTimers(); vi.setSystemTime("2026-10-30T00:00:00Z");
    const state = await setup(async () => new Response(null, {status: 503}));
    await runDueWatches(state.env);
    const {key, event} = state.events()[0], get = state.bucket.get.bind(state.bucket);
    vi.setSystemTime(Date.parse(event.next_attempt_at) + 1);
    state.bucket.get = async name => {
      const object = await get(name);
      if (name !== key) return object;
      const bytes = new TextEncoder().encode(JSON.stringify(event) + (mode === "truncated" ? "" : " ".repeat(262_145)));
      return {...object!, size: mode === "declared" ? bytes.length : mode === "actual" ? 1 : bytes.length + 1,
        body: new ReadableStream<Uint8Array>({start(controller) { controller.enqueue(bytes); controller.close(); }})};
    };
    await runDueWatches(state.env);
    expect(state.requests).toHaveLength(1);
    expect(state.events()[0].event).toEqual(event);
  });

  it("unknown prepaid price or nonpositive expected margin pauses checks without changing credits", async () => {
    const state = await setup();
    const before = state.readWatch();
    Object.assign(state.env, {FACILITATOR_FEE_USD: "2"});
    await runDueWatches(state.env);
    expect(state.readWatch()).toMatchObject({state: "paused_margin", prepaid_check_price_usd: before.prepaid_check_price_usd,
      checks_attempted: 0, checks_remaining: 1});
    expect(state.env.BROWSER.quickAction).not.toHaveBeenCalled(); expect(state.requests).toHaveLength(0);
    await state.bucket.put(state.key, JSON.stringify({...before, prepaid_check_price_usd: null}));
    await runDueWatches(state.env);
    expect(state.readWatch().state).toBe("paused_margin"); expect(state.env.BROWSER.quickAction).not.toHaveBeenCalled();
  });

  it.each(["nowSeconds", "maxSkewSeconds"])("receiver rejects invalid %s instead of disabling replay checks", async field => {
    const state = await setup(); await runDueWatches(state.env);
    const original = state.requests[0], body = await original.text(), inbox = {accept: vi.fn(async () => "accepted")};
    for (const value of [NaN, Infinity, -Infinity, -1, 0, 0.5, Number.MAX_SAFE_INTEGER + 1, "300"]) {
      const response = await receiveWatchWebhook(new Request(original.url, {method: "POST", headers: original.headers, body}),
        {secret: state.secret, inbox, [field]: value});
      expect(response.status).toBe(503);
    }
    expect(inbox.accept).not.toHaveBeenCalled();
  });

  it("valid multibyte expectations preserve the complete decision through a larger outbox and the next slot", async () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-10-30T00:00:00Z");
    const expected = {contains: Array(10).fill("甲".repeat(195)), excludes: Array(10).fill("乙".repeat(195))};
    const state = await setup(undefined, 2, expected);
    const browser = vi.mocked(state.env.BROWSER.quickAction), original = browser.getMockImplementation()!;
    browser.mockImplementation(async (...args) => {
      const response = await original(...args), body = await response.json() as any;
      body.result.markdown = "乙".repeat(195);
      return Response.json(body, {headers: {"x-browser-ms-used": "1"}});
    });
    const put = state.bucket.put.bind(state.bucket); let largestWatch = 0;
    state.bucket.put = async (key, value, options) => {
      if (key === state.key) largestWatch = Math.max(largestWatch, new TextEncoder().encode(String(value)).byteLength);
      return put(key, value, options);
    };
    await runDueWatches(state.env);
    expect(largestWatch).toBeGreaterThan(32_000);
    expect(state.readWatch().pending_notification).toBeUndefined();
    expect(state.events()[0].event.state).toBe("delivered");
    const result = JSON.parse(state.events()[0].event.raw_body);
    expect(result.safe).toBe(false);
    expect(result.diff.missing_text).toEqual(expected.contains);
    expect(result.diff.excluded_text_found).toEqual(expected.excludes);
    vi.setSystemTime(Date.parse(state.readWatch().next_check_at) + 1);
    await runDueWatches(state.env);
    expect(state.events()).toHaveLength(2);
    expect(state.events().every(({event}) => event.state === "delivered")).toBe(true);
    expect(state.readWatch()).toMatchObject({checks_attempted: 2, checks_remaining: 0});
    expect(browser).toHaveBeenCalledTimes(2);
  });

  it("an indefinitely pending old check inventory cannot starve existing notifications", async () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-10-30T00:00:00Z");
    let success = false;
    const state = await setup(async () => new Response(null, {status: success ? 204 : 503}));
    await runDueWatches(state.env); success = true;
    vi.setSystemTime(Date.parse(state.events()[0].event.next_attempt_at) + 1);
    const list = state.bucket.list.bind(state.bucket); let release!: () => void, settled = false;
    state.bucket.list = async options => options?.prefix === "watches/" ? new Promise(resolve => {
      release = () => { void list(options).then(resolve); };
    }) : list(options);
    const pending = runDueWatches(state.env).then(() => { settled = true; });
    await vi.waitFor(() => expect(state.events()[0].event.state).toBe("delivered"));
    expect(settled).toBe(false);
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
    release(); await pending;
  });

  it("shared metadata limit defaults stay strict and override configuration fails closed", async () => {
    const bucket = new WatchBucket(), env = orderRuntime(bucket), key = "watches/metadata-limit-fixture.json";
    for (const limit of [NaN, Infinity, 0, -1, 1.5, 262_145]) expect(() => createOrderReadSnapshot(env, limit)).toThrow("invalid_metadata_byte_limit");
    await bucket.put(key, JSON.stringify({padding: "x".repeat(32_001)}));
    await expect(createOrderReadSnapshot(env).env.PROOFS.get(key)).rejects.toThrow("order_evidence_unavailable");
    const object = await createOrderReadSnapshot(env, 262_144).env.PROOFS.get(key);
    expect((await object!.json<{padding: string}>()).padding).toHaveLength(32_001);
  });
});
