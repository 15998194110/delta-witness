import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app as core } from "../src/index";
import { app as gateway } from "../channels/partner-gateway/src/index";
import { MemoryBucket, mockOrderNetwork, orderRuntime } from "./helpers/order-runtime";
import { runDueWatches } from "../src/watch";

class Bucket extends MemoryBucket {
  async list(options?: R2ListOptions) {
    return {objects: [...this.values.keys()].filter(key => key.startsWith(options?.prefix ?? "")).map(key => ({key})), truncated: false};
  }
}
beforeEach(() => {
  const original = crypto;
  const subtle = new Proxy(original.subtle, {get(target, name) {
    if (name === "timingSafeEqual") return (a: ArrayBuffer, b: ArrayBuffer) => Buffer.from(a).equals(Buffer.from(b));
    const value = Reflect.get(target, name); return typeof value === "function" ? value.bind(target) : value;
  }});
  vi.stubGlobal("crypto", {subtle, getRandomValues: original.getRandomValues.bind(original), randomUUID: original.randomUUID.bind(original)});
});
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});

function fixture() {
  const bucket = new Bucket(), env = Object.assign(orderRuntime(bucket), {PARTNER_GATEWAY_SECRET: "synthetic-core-secret"});
  const network = mockOrderNetwork(async () => {throw new Error("partner_rail_must_not_settle");});
  vi.stubGlobal("fetch", network);
  const request = (partner: string, product: string, id: string, body: Record<string, unknown>, presented = "synthetic-proxy-secret", configured = "synthetic-proxy-secret") => gateway.request(`https://gateway.test/${product}`, {
    method: "POST", headers: {"content-type": "application/json", "x-delta-partner-secret": presented, "idempotency-key": id}, body: JSON.stringify(body),
  }, {APP_VERSION: "0.7.1", PARTNER_ID: partner, PARTNER_SECRET: configured, CORE_SERVICE_SECRET: "synthetic-core-secret",
    PARTNER_NET_CAPTURE_USD: "1", PARTNER_NET_PREFLIGHT_USD: "1", PARTNER_NET_WATCH_CHECK_USD: "1",
    PARTNER_RATE_LIMITER: {limit: async () => ({success: true})}, CORE: {fetch: (req: Request) => core.fetch(req, env)},
  } as any);
  return {bucket, env, request, network};
}

describe("partner Core + gateway isolated same-order contract", () => {
  it("concurrent same tenant/key captures once and a new tenant gets a distinct proof", async () => {
    const state = fixture(), body = {url: "https://example.com/"};
    const pair = await Promise.all([state.request("tenant-a", "capture", "shared-order-001", body), state.request("tenant-a", "capture", "shared-order-001", body)]);
    expect(pair.map(x => x.status).sort()).toEqual([200, 202]);
    const completed = await pair.find(x => x.status === 200)!.json() as any;
    const replay = await (await state.request("tenant-a", "capture", "shared-order-001", body)).json() as any;
    expect(replay.proof_id).toBe(completed.proof_id);
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
    expect((await state.request("tenant-a", "preflight", "shared-order-001", body)).status).toBe(409);
    const separate = await (await state.request("tenant-b", "capture", "shared-order-001", body)).json() as any;
    expect(separate.proof_id).not.toBe(completed.proof_id);
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(2);
    expect(state.network.mock.calls.some(([url]) => String(url).endsWith("/settle"))).toBe(false);
  });

  it("rotating the server proxy credential preserves original negative Guard decision and artifact bytes", async () => {
    const state = fixture(), body = {url: "https://example.com/", expected: {contains: ["absent-condition"]}};
    const first = await (await state.request("tenant-a", "preflight", "negative-order-001", body)).json() as any;
    expect(first).toMatchObject({ok: true, safe: false});
    const before = [...state.bucket.values].filter(([key]) => key.startsWith(first.proof_id));
    expect((await state.request("tenant-a", "preflight", "negative-order-001", body, "synthetic-proxy-secret", "synthetic-rotated-secret")).status).toBe(401);
    const recovered = await (await state.request("tenant-a", "preflight", "negative-order-001", body, "synthetic-rotated-secret", "synthetic-rotated-secret")).json();
    expect(recovered).toEqual({...first, idempotent_replay: true});
    expect([...state.bucket.values].filter(([key]) => key.startsWith(first.proof_id))).toEqual(before);
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });

  it("high modeled cost blocks only new partner orders without repricing or breaking an original paid replay", async () => {
    const state = fixture(), body = {url: "https://example.com/"};
    const original = await (await state.request("tenant-a", "preflight", "old-fixed-price-001", body)).json() as any;
    expect(original.ok).toBe(true);
    Object.assign(state.env, {FACILITATOR_FEE_USD: "2"});
    state.network.mockClear();
    const refused = await state.request("tenant-a", "preflight", "new-high-cost-001", body);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({error: "economics_unavailable"});
    const replay = await (await state.request("tenant-a", "preflight", "old-fixed-price-001", body)).json();
    expect(replay).toEqual({...original, idempotent_replay: true});
    expect(state.network).not.toHaveBeenCalled();
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });

  it("concurrent Watch registration and the last prepaid slot consume one original entitlement", async () => {
    const state = fixture(), body = {url: "https://example.com/", checks: 1, interval_seconds: 900};
    const registrations = await Promise.all([state.request("tenant-a", "watch", "watch-order-001", body), state.request("tenant-a", "watch", "watch-order-001", body)]);
    expect(registrations.map(x => x.status).sort()).toEqual([200, 201]);
    const registration = await registrations[0].json() as any, key = `watches/${registration.watch_id}.json`;
    expect([...state.bucket.values.keys()].filter(key => key.startsWith("watches/"))).toHaveLength(1);
    await state.bucket.put(key, JSON.stringify({...JSON.parse(state.bucket.values.get(key)!.text), next_check_at: "2020-01-01T00:00:00Z"}));
    await Promise.all([runDueWatches(state.env), runDueWatches(state.env)]);
    await runDueWatches(state.env);
    expect(JSON.parse(state.bucket.values.get(key)!.text)).toMatchObject({state: "exhausted", checks_purchased: 1, checks_attempted: 1, checks_remaining: 0});
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
    expect((await state.request("tenant-a", "watch", "watch-order-001", {...body, checks: 2})).status).toBe(409);
    const other = await (await state.request("tenant-b", "watch", "watch-order-001", body)).json() as any;
    expect(other.watch_id).not.toBe(registration.watch_id);
    expect(other.checks_remaining).toBe(1);
  });
});
