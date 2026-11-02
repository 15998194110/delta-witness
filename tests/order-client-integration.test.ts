import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
// Execute the actual locally bundled JS client against the Core fixture.
import { DeltaWitness } from "../packages/js-client/src/index.js";
import { app } from "../src/index";
import { sha256 } from "../src/crypto";
import { MemoryBucket, orderRuntime, orderPayment, mockOrderNetwork, statusRequest } from "./helpers/order-runtime";

type Kind = "normal" | "draft" | "unknown" | "corrupt";
type Case = { id: string; index: number; kind: Kind; product: "capture" | "preflight"; input: Record<string, unknown> };
const seed = 20261029;
const nonce = (index: number) => `0x${(seed + index).toString(16).padStart(64, "0")}`;
const orderId = (index: number) => `20261029-0000-4000-8000-${index.toString().padStart(12, "0")}`;
function makeCase(index: number, kind: Kind): Case {
  const product = index % 2 ? "preflight" : "capture";
  return { id: orderId(index), index, kind, product, input: {
    url: `https://example.com/?order=${index}`,
    ...(product === "preflight" ? { expected: { contains: ["missing promise"] } } : {}),
  } };
}

// This is an atomic in-memory fixture, not a claim about a production store.
class ClientStore {
  records = new Map<string, any>();
  async load(id: string) { return structuredClone(this.records.get(id) ?? null); }
  async compareAndSet(id: string, revision: number | null, next: any) {
    if ((this.records.get(id)?.revision ?? null) !== revision) return false;
    this.records.set(id, structuredClone(next));
    return true;
  }
}

function harness(cases: Case[]) {
  const bucket = new MemoryBucket(), env = orderRuntime(bucket), store = new ClientStore();
  const byIndex = new Map(cases.map(value => [value.index, value]));
  const failedFinal = new Set<number>(), damaged = new Map<string, number>();
  const trace: Array<{ stage: string; order_id: string; status?: number }> = [];
  const originalDelivery = new Map<string, any>();
  const put = bucket.put.bind(bucket), get = bucket.get.bind(bucket);
  bucket.put = async (key, value, options) => {
    if (key.startsWith("fulfillments/")) {
      const record = JSON.parse(String(value));
      const index = Number(new URL(record.requested_url).searchParams.get("order"));
      const scenario = byIndex.get(index)!;
      if (record.response) originalDelivery.set(scenario.id, structuredClone(record.response));
      if (record.state === "complete" && scenario.kind === "draft" && !failedFinal.has(index)) {
        failedFinal.add(index);
        trace.push({ stage: "final_write_interrupted", order_id: scenario.id });
        throw new Error("synthetic_final_write_interruption");
      }
    }
    return put(key, value, options);
  };
  // Faults are injected at reads; the original evidence is never erased.
  bucket.get = async key => {
    const index = damaged.get(key);
    if (index !== undefined) {
      if (index % 2 === 0) return null;
      const object = await get(key);
      const corrupted = new TextEncoder().encode("synthetic corruption");
      return object && { ...object, arrayBuffer: async () => corrupted.slice().buffer,
        body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(corrupted); controller.close(); } }) };
    }
    return get(key);
  };
  const settlements = new Map<string, number>();
  const baseNetwork = mockOrderNetwork();
  const network = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://example.com/")) return new Response("", { status: 200 });
    if (url.endsWith("/settle")) {
      const body = JSON.parse(String(init?.body));
      const authorization = body.paymentPayload.payload.authorization;
      const scenario = cases.find(value => nonce(value.index) === authorization.nonce)!;
      if (!scenario) throw new Error("unmapped_synthetic_settlement");
      settlements.set(scenario.id, (settlements.get(scenario.id) ?? 0) + 1);
      trace.push({ stage: "settlement_attempt", order_id: scenario.id });
      if (scenario.kind === "unknown") throw new Error("synthetic_settlement_outcome_unknown");
    }
    return baseNetwork(input);
  });
  vi.stubGlobal("fetch", network);
  const plainFetch = vi.fn(async (url: string, init?: RequestInit) => app.fetch(new Request(url, init), env));
  const newClient = () => new DeltaWitness({ baseUrl: "https://delta.test", fetchImpl: plainFetch, orderStore: store });
  const signCounts = new Map<string, number>();
  const paidFetch = (scenario: Case) => vi.fn(async (url: string, init?: RequestInit) => {
    signCounts.set(scenario.id, (signCounts.get(scenario.id) ?? 0) + 1);
    const probe = await app.fetch(new Request(url, init), env);
    expect(probe.status).toBe(402);
    trace.push({ stage: "challenge", order_id: scenario.id, status: 402 });
    const headers = new Headers(init?.headers);
    headers.set("payment-signature", Buffer.from(JSON.stringify(orderPayment(scenario.product, nonce(scenario.index)))).toString("base64"));
    const response = await app.fetch(new Request(url, { ...init, headers }), env);
    trace.push({ stage: "paid_response", order_id: scenario.id, status: response.status });
    return response;
  });
  const start = async (scenario: Case) => {
    const client = newClient();
    await client.prepareOrder(scenario.product, scenario.input, { orderId: scenario.id });
    let result: any;
    try { result = await client.executeOrder(scenario.id, paidFetch(scenario)); }
    catch (error) { expect(["draft", "unknown"]).toContain(scenario.kind); }
    if (scenario.kind === "normal" || scenario.kind === "corrupt") expect(result.state).toBe("complete");
    if (scenario.kind === "corrupt") damaged.set(`${originalDelivery.get(scenario.id).proof_id}/page.html`, scenario.index);
    return result;
  };
  const recover = async (scenario: Case) => {
    const neverSign = vi.fn(async () => { throw new Error("recovery_must_not_sign"); });
    let result: any, error: any;
    try { result = await newClient().executeOrder(scenario.id, neverSign); } catch (caught) { error = caught; }
    expect(neverSign).not.toHaveBeenCalled();
    if (scenario.kind === "normal" || scenario.kind === "draft") {
      expect(error).toBeUndefined();
      expect(result).toMatchObject({ state: "complete", order_id: scenario.id, delivery: originalDelivery.get(scenario.id) });
      if (scenario.product === "preflight") expect(result.delivery).toMatchObject({ safe: false, reason: "expectation_failed" });
    } else {
      expect(result).toBeUndefined(); expect(error).toBeDefined();
      expect(String(error.message).toLowerCase()).not.toContain("unpaid");
    }
    trace.push({ stage: "recover_checked", order_id: scenario.id });
  };
  const artifactHashes = async () => Object.fromEntries(await Promise.all([...bucket.values.entries()]
    .filter(([key]) => !/^(orders|settlements|fulfillments)\//.test(key))
    .map(async ([key, value]) => [key, await sha256(value.bytes ?? new TextEncoder().encode(value.text))])));
  return { env, bucket, store, trace, network, settlements, signCounts, originalDelivery, start, recover, artifactHashes, newClient, paidFetch };
}

async function concurrent<T>(items: T[], limit: number, action: (value: T) => Promise<unknown>) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) { const value = items[index++]; await action(value); }
  }));
}
beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => undefined));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("JS to Core same-order integration (offline)", () => {
  it("preserves authorization and original evidence across client restarts and injected failures", async () => {
    const cases = [makeCase(1, "normal"), makeCase(2, "draft"), makeCase(3, "unknown"), makeCase(4, "corrupt"), makeCase(5, "draft")];
    const state = harness(cases);
    await concurrent(cases, 3, state.start);
    const hashes = await state.artifactHashes(), browserCalls = vi.mocked(state.env.BROWSER.quickAction).mock.calls.length;
    await concurrent(cases, 3, state.recover);
    await concurrent(cases, 3, state.recover);
    expect(await state.artifactHashes()).toEqual(hashes);
    expect(vi.mocked(state.env.BROWSER.quickAction).mock.calls.length).toBe(browserCalls);
    expect([...state.settlements.values()]).toEqual(cases.map(() => 1));
    expect([...state.signCounts.values()]).toEqual(cases.map(() => 1));
  });
  it("two clients executing one durable prepared order can start only one paid call", async () => {
    const scenario = makeCase(6, "normal"), state = harness([scenario]);
    await state.newClient().prepareOrder(scenario.product, scenario.input, { orderId: scenario.id });
    await Promise.allSettled([state.newClient().executeOrder(scenario.id, state.paidFetch(scenario)), state.newClient().executeOrder(scenario.id, state.paidFetch(scenario))]);
    await state.recover(scenario);
    expect(state.signCounts.get(scenario.id)).toBe(1); expect(state.settlements.get(scenario.id)).toBe(1);
  });
});

describe.skipIf(process.env.DELTA_LOCAL_ORDER_WORKLOAD !== "1")("predeclared finite order recovery workload", () => {
  it("converges a fixed 200-order population and then exercises recovery for at least60seconds", async () => {
    const started = Date.now();
    const cases = Array.from({ length: 200 }, (_, offset) => makeCase(offset + 1, offset < 100 ? "normal" : offset < 150 ? "draft" : offset < 175 ? "unknown" : "corrupt"));
    const state = harness(cases);
    await concurrent(cases, 8, state.start);
    const originalHashes = await state.artifactHashes();
    const browserCalls = vi.mocked(state.env.BROWSER.quickAction).mock.calls.length;
    const doubleRecover = cases.filter(value => value.kind === "draft");
    await concurrent(doubleRecover, 8, async scenario => Promise.all([state.recover(scenario), state.recover(scenario)]));
    await concurrent(cases, 8, state.recover);
    for (const scenario of cases) {
      const wrong = statusRequest({ id: scenario.id, token: Buffer.alloc(32, 99).toString("base64url") });
      expect((await app.fetch(wrong, state.env)).status).toBe(404);
      const exportRequest = new Request(`${wrong.url}/artifacts/html`, { headers: wrong.headers });
      expect((await app.fetch(exportRequest, state.env)).status).toBe(404);
    }
    const convergedObjects = state.bucket.values.size;
    let reads = 0;
    while (Date.now() - started < 60_000) {
      // Fixed-seed rotating sample; no new orders and no fresh paid attempts.
      const sample = Array.from({ length: 8 }, (_, index) => cases[(reads + index + seed) % cases.length]);
      await concurrent(sample, 8, state.recover); reads += sample.length;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect([...state.settlements.values()]).toHaveLength(200);
    expect([...state.settlements.values()].every(value => value === 1)).toBe(true);
    expect([...state.signCounts.values()].every(value => value === 1)).toBe(true);
    expect(vi.mocked(state.env.BROWSER.quickAction).mock.calls.length).toBe(browserCalls);
    expect(browserCalls).toBe(175);
    expect(await state.artifactHashes()).toEqual(originalHashes);
    expect(state.bucket.values.size).toBe(convergedObjects);
    expect([...state.bucket.values.keys()].filter(key => key.startsWith("orders/"))).toHaveLength(200);
    const summary = { seed, duration_ms: Date.now() - started, orders: 200, concurrency: 8,
      completed: 100, recovered: 50, settlement_unknown: 25, inconsistent_artifacts: 25,
      settlement_attempts: 200, synthetic_confirmed: 175, browser_invocations: browserCalls, additional_read_checks: reads,
      retained_objects: convergedObjects,
      treasury_received: null, real_revenue: null, actual_variable_cost: null, actual_contribution_margin: null };
    if (process.env.DELTA_LOCAL_ORDER_WORKLOAD_REPORT) {
      // Explicit local evidence destination, create-only; contains no capability
      // or signed payment bytes. A failed evidence write fails this run.
      await writeFile(process.env.DELTA_LOCAL_ORDER_WORKLOAD_REPORT, JSON.stringify({ summary, artifact_hashes: originalHashes, trace: state.trace }, null, 2), { flag: "wx" });
    }
    console.log("DELTA_LOCAL_ORDER_WORKLOAD " + JSON.stringify(summary));
  }, 180_000);
});
