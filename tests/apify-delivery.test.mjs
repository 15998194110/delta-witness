import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, describe, it, expect, vi } from 'vitest';

const source = readFileSync(process.env.DELTA_APIFY_AUDIT_SOURCE || new URL('../channels/apify/main.mjs', import.meta.url), 'utf8').replace('import { Actor } from "apify";', 'const Actor = mockActor;');
const proof = {
  ok: true, product: 'capture', proof_id: '56347db8-1aa5-447f-a0e4-3bb052d7aa89',
  public_proof_url: 'https://delta-witness-api.ruphussten.workers.dev/p/56347db8-1aa5-447f-a0e4-3bb052d7aa89',
  manifest_url: 'https://delta-witness-api.ruphussten.workers.dev/v1/proofs/56347db8-1aa5-447f-a0e4-3bb052d7aa89',
  bundle_root: 'sha256:' + 'a'.repeat(64), observed_at: '2026-10-03T12:00:00Z',
};
async function simulate(status, result, options = {}) {
  const state = options.state ?? new Map();
  const actor = {
    init: vi.fn(), exit: vi.fn(), isAtHome: () => options.atHome ?? false,
    getInput: async () => ({ url: 'https://example.com', product: 'capture', ...options.input }),
    getChargingManager: () => ({ getPricingInfo: () => ({ isPayPerEvent: true, perEventPrices: { 'proof-created': options.eventPrice ?? 2 } }), calculateMaxEventChargeCountWithinLimit: () => 1 }),
    getEnv: () => ({ actorRunId: 'offline-run-001' }),
    getValue: vi.fn(async key => { if (options.stateError) throw new Error('fixture-secret KVS response lost'); return state.get(key) ?? null; }),
    setValue: vi.fn(async (key, value) => { state.set(key, structuredClone(value)); }),
    charge: vi.fn(async () => { if (options.chargeError) throw new Error('fixture-secret charge response lost'); return { chargedCount: 1 }; }),
    pushData: vi.fn(async () => { if (options.pushError) throw new Error('fixture-secret dataset response lost'); }),
  };
  const fetchMock = vi.fn(async (...args) => {
    if (options.fetchError) throw new Error('fixture-secret upstream URL token');
    if (options.fetchImpl) return options.fetchImpl(...args);
    return Response.json(result, { status });
  });
  let error;
  try {
    await vm.runInNewContext(`(async () => { ${source} })()`, {
      mockActor: actor, fetch: fetchMock, URL, Response, AbortController, setTimeout, clearTimeout,
      process: { env: { DELTA_PARTNER_GATEWAY_URL: 'https://gateway.test', DELTA_PARTNER_SECRET: 'fixture-secret', ...options.env } },
      console: { log: vi.fn() },
    });
  } catch (failure) { error = failure; }
  return { actor, fetchMock, error };
}

afterEach(() => vi.useRealTimers());

describe('Apify charges only a completed proof', () => {
  it('accepts a legitimate 35-second response using the same original request', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(() => new Promise(resolve => setTimeout(() => resolve(Response.json(proof)), 35000)));
    const pending = simulate(200, proof, { fetchImpl });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(35000);
    const run = await pending;
    expect(run.error).toBeUndefined();
    expect(run.actor.charge).toHaveBeenCalledOnce();
    expect(run.fetchMock).toHaveBeenCalledOnce();
  });
  it('stops a noncooperative fetch at the deadline and never bills a late result', async () => {
    vi.useFakeTimers();
    let resolveLate;
    const fetchImpl = vi.fn(() => new Promise(resolve => { resolveLate = resolve; }));
    const pending = simulate(200, proof, { fetchImpl });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(120001);
    const run = await pending;
    expect(run.error?.message).toContain('delivery_unconfirmed');
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    resolveLate(Response.json(proof));
    await vi.advanceTimersByTimeAsync(1);
    expect(run.actor.charge).not.toHaveBeenCalled();
    expect(run.actor.pushData).not.toHaveBeenCalled();
    expect(run.actor.exit).toHaveBeenCalledWith({ exitCode: 1 });
    expect(run.fetchMock).toHaveBeenCalledOnce();
  });
  it('cancels a stalled response body without billing or resubmitting', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ start() {}, cancel })));
    const pending = simulate(200, proof, { fetchImpl });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(120001);
    const run = await pending;
    expect(run.error?.message).toContain('delivery_unconfirmed');
    expect(cancel).toHaveBeenCalledOnce();
    expect(run.actor.charge).not.toHaveBeenCalled();
    expect(run.fetchMock).toHaveBeenCalledOnce();
  });
  it('rejects oversized metadata before billing and never echoes its body', async () => {
    const run = await simulate(200, proof, { fetchImpl: async () => new Response('x'.repeat(1_048_577)) });
    expect(run.error?.message).toContain('delivery_unconfirmed');
    expect(run.actor.charge).not.toHaveBeenCalled();
    expect(run.fetchMock).toHaveBeenCalledOnce();
  });
  it.each(['fetchError', 'chargeError', 'pushError', 'stateError'])('redacts %s and exits as failed', async (failure) => {
    const run = await simulate(200, proof, {[failure]: true});
    expect(run.error?.message).not.toContain('fixture-secret');
    expect(run.error?.message).toContain('reconciliation');
    expect(run.actor.exit).toHaveBeenCalledWith({exitCode: 1});
  });
  it('holds same-run same-URL Preflight input changes for reconciliation', async () => {
    const state = new Map();
    const preflight = {...proof, product: 'preflight', safe: true, changed: false};
    const first = await simulate(200, preflight, {state, input: {product: 'preflight', expected: {contains: ['A']}}});
    const next = await simulate(200, preflight, {state, input: {product: 'preflight', expected: {contains: ['B']}}});
    expect(first.error).toBeUndefined();
    expect(next.error?.message).toMatch(/reconciliation/i);
    expect(next.actor.charge).not.toHaveBeenCalled();
    expect(next.fetchMock).not.toHaveBeenCalled();
  });
  it('does not trust a historical completed marker missing full request identity', async () => {
    const state = new Map([['DELTA-PROOF-CHARGE-offline-run-001', {state: 'complete', product: 'capture', url: 'https://example.com', result: proof}]]);
    const run = await simulate(200, proof, {state});
    expect(run.error?.message).toMatch(/reconciliation/i);
    expect(run.actor.charge).not.toHaveBeenCalled();
  });
  it('accepts the current 1 USD gate without claiming positive margin', async () => {
    const run = await simulate(200, proof, { atHome: true, eventPrice: 1 });
    expect(run.error).toBeUndefined();
    expect(run.actor.charge).toHaveBeenCalledOnce();
  });
  it('uses the advertised Preflight default and accepts a completed negative comparison', async () => {
    const preflight = { ...proof, product: 'preflight', safe: false, changed: true };
    const run = await simulate(200, preflight, { input: { product: undefined } });
    expect(run.error).toBeUndefined();
    expect(run.fetchMock.mock.calls[0][0]).toBe('https://gateway.test/preflight');
    expect(run.actor.pushData).toHaveBeenCalledWith(preflight);
  });
  it('reports a failed Actor exit when delivery is not complete', async () => {
    const run = await simulate(503, {});
    expect(run.actor.exit).toHaveBeenCalledWith({ exitCode: 1 });
  });
  it('reports a successful Actor exit only after charge and delivery complete', async () => {
    const run = await simulate(200, proof);
    expect(run.actor.exit).toHaveBeenCalledWith({ exitCode: 0 });
  });
  it.each(['chargeError', 'pushError'])('does not charge again on same-run recovery after %s', async (failure) => {
    const state = new Map();
    const first = await simulate(200, proof, { state, [failure]: true });
    const next = await simulate(200, proof, { state });
    expect(first.actor.charge).toHaveBeenCalledOnce();
    expect(next.actor.charge).not.toHaveBeenCalled();
    expect(state.get('OUTPUT')).toEqual(proof);
    expect(next.error?.message).toMatch(/reconciliation/i);
  });
  it('a fully completed run restart reuses the result without another charge or dataset append', async () => {
    const state = new Map();
    const first = await simulate(200, proof, { state });
    const next = await simulate(200, proof, { state });
    expect(first.error).toBeUndefined();
    expect(next.error).toBeUndefined();
    expect(next.actor.charge).not.toHaveBeenCalled();
    expect(next.actor.pushData).not.toHaveBeenCalled();
    expect(next.fetchMock).not.toHaveBeenCalled();
  });
  it('rejects the historical 0.04 PPE price before invoking current 1 USDC partner service', async () => {
    const run = await simulate(200, proof, { atHome: true, eventPrice: 0.04 });
    expect(run.fetchMock).not.toHaveBeenCalled();
    expect(run.actor.charge).not.toHaveBeenCalled();
    expect(run.error).toBeDefined();
  });
  it('does not silently purchase Capture for an unsupported requested product', async () => {
    const run = await simulate(200, proof, { input: { product: 'guarded-action-pilot' } });
    expect(run.fetchMock).not.toHaveBeenCalled();
    expect(run.actor.charge).not.toHaveBeenCalled();
    expect(run.error).toBeDefined();
  });
  it('does not transmit the partner secret to a configured HTTP gateway', async () => {
    const run = await simulate(200, proof, { env: { DELTA_PARTNER_GATEWAY_URL: 'http://gateway.test' } });
    expect(run.fetchMock).not.toHaveBeenCalled();
    expect(run.actor.charge).not.toHaveBeenCalled();
    expect(run.error).toBeDefined();
  });
  it.each([
    [202, { ok: false, state: 'processing' }],
    [200, { ok: false, state: 'retryable_failure' }],
    [200, { ok: true }],
    [200, { ...proof, product: 'preflight' }],
    [200, { ...proof, manifest_url: 'https://attacker.test/private' }],
  ])('does not bill or publish partial/malformed HTTP %s', async (status, body) => {
    const run = await simulate(status, body);
    expect(run.actor.charge).not.toHaveBeenCalled();
    expect(run.actor.pushData).not.toHaveBeenCalled();
    expect(run.error?.message).toContain('delivery_unconfirmed');
    expect(run.fetchMock).toHaveBeenCalledTimes(1);
    expect(run.actor.exit).toHaveBeenCalledOnce();
  });
  it('charges and publishes one verified completed response', async () => {
    const run = await simulate(200, proof);
    expect(run.error).toBeUndefined();
    expect(run.actor.charge).toHaveBeenCalledOnce();
    expect(run.actor.pushData).toHaveBeenCalledWith(proof);
  });
  it('does not echo error bodies into logs or exceptions', async () => {
    const run = await simulate(503, { error: 'Bearer fixture-secret' });
    expect(run.error?.message).not.toContain('fixture-secret');
    expect(run.actor.charge).not.toHaveBeenCalled();
  });
});
