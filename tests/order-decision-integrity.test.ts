import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { MemoryBucket, orderRuntime, orderRequest, mockOrderNetwork, statusRequest } from "./helpers/order-runtime";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(["complete", "processing"])("original decision digest (%s)", state => {
  it.each(["safe", "changed", "reason", "diff", "missing_digest"])("rejects altered %s without reevaluating or charging", async field => {
    const bucket = new MemoryBucket(), env = orderRuntime(bucket), network = mockOrderNetwork();
    vi.stubGlobal("fetch", network);
    const options = { product: "preflight", body: { url: "https://example.com/", expected: { contains: ["missing promise"] } } };
    const delivered = await app.fetch(orderRequest(options), env);
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toMatchObject({ safe: false });
    const [key, object] = [...bucket.values.entries()].find(([key]) => key.startsWith("fulfillments/"))!;
    const record = JSON.parse(object.text);
    record.state = state;
    expect(record.response_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    if (field === "missing_digest") delete record.response_hash;
    else record.response[field] = field === "safe" ? true : field === "changed" ? true : field === "reason" ? "all_clear" : { invented: true };
    bucket.values.set(key, { ...object, text: JSON.stringify(record) });
    network.mockClear(); vi.mocked(env.BROWSER.quickAction).mockClear();
    expect((await app.fetch(statusRequest({ recover: true }), env)).status).toBe(503);
    expect((await app.fetch(orderRequest(options), env)).status).toBe(503);
    expect((await app.fetch(orderRequest({ ...options, legacy: true }), env)).status).toBe(503);
    expect(network).not.toHaveBeenCalled(); expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
    expect(JSON.parse(bucket.values.get(key)!.text)).toEqual(record);
  });
});
