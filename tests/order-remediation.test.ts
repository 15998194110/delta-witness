import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { readOrderRemediationSummary } from '../src/orders';
import { drainPaidRecoveryPriority, enqueuePaidRecoveryPriority, PAID_RECOVERY_PRIORITY_PREFIX } from '../src/paid-recovery-priority';
import { MemoryBucket, mockOrderNetwork, orderRequest, orderRuntime, statusRequest, TEST_ORDER_ID } from './helpers/order-runtime';

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function original() {
  const bucket = new MemoryBucket(), env = orderRuntime(bucket), network = mockOrderNetwork();
  vi.stubGlobal('fetch', network);
  const response = await app.fetch(orderRequest(), env); expect(response.status).toBe(200);
  const delivery = await response.json();
  const fulfillment = [...bucket.values.keys()].find(key => key.startsWith('fulfillments/'))!;
  const value = bucket.values.get(fulfillment)!;
  bucket.values.set(fulfillment, { ...value, text: JSON.stringify({ ...JSON.parse(value.text), state: 'processing' }) });
  network.mockClear(); vi.mocked(env.BROWSER.quickAction).mockClear();
  return { bucket, env, network, fulfillment, delivery };
}
function noWork(s: Awaited<ReturnType<typeof original>>) {
  expect(s.network).not.toHaveBeenCalled(); expect(s.env.BROWSER.quickAction).not.toHaveBeenCalled();
}

it.each(['missing', 'corrupt'])('gives an authenticated buyer an honest responsibility path for %s proof without rewriting evidence', async fault => {
  const s = await original(), key = [...s.bucket.values.keys()].find(key => key.endsWith('/page.html'))!;
  const artifact = s.bucket.values.get(key)!;
  if (fault === 'missing') s.bucket.values.delete(key);
  else s.bucket.values.set(key, { ...artifact, text: 'changed bytes', bytes: new TextEncoder().encode('changed bytes') });
  const before = structuredClone([...s.bucket.values]);
  const response = await app.fetch(statusRequest({ recover: true }), s.env);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ ok: false, state: 'order_evidence_inconsistent',
    payment: { state: 'settlement_confirmed', treasury_received: null },
    remediation: { state: 'needs_intervention', obligation: 'original_paid_delivery_unresolved',
      historical_evidence_loss_confirmed: null, additional_payment_required: false, customer_revenue_recognized: null,
      replacement_observation: { authorized: false }, refund: { authorized: false } } });
  expect([...s.bucket.values]).toEqual(before); noWork(s);
  // A subsequently available exact original is validated and recovered using
  // the original identity. An earlier intervention view cannot become a lock.
  s.bucket.values.set(key, artifact);
  const restored = await app.fetch(statusRequest({ recover: true }), s.env);
  expect(restored.status).toBe(200); expect(await restored.json()).toMatchObject({ state: 'complete', delivery: s.delivery });
  noWork(s);
});

it('a temporary read failure never asserts irreversible loss, grants a remedy, or exposes authenticated facts', async () => {
  const s = await original(), get = s.bucket.get.bind(s.bucket);
  s.bucket.get = async key => { if (key.endsWith('/page.html')) throw new Error('temporary R2 outage'); return get(key); };
  const response = await app.fetch(statusRequest(), s.env);
  expect(response.status).toBe(503);
  const body: any = await response.json();
  expect(body.remediation?.historical_evidence_loss_confirmed ?? null).toBeNull();
  expect(body.remediation?.refund.authorized ?? false).toBe(false);
  const denied = await app.fetch(statusRequest({ token: 'invalid' }), s.env);
  expect(denied.status).toBe(404); expect(await denied.json()).not.toHaveProperty('remediation'); noWork(s);
});

it('quarantines a revoked unfinished original durably without resolving the debt or mutating payment/proof records', async () => {
  const s = await original();
  expect(await enqueuePaidRecoveryPriority(s.env, TEST_ORDER_ID)).toMatchObject({ outcome: 'enqueued' });
  const orderKey = `orders/${TEST_ORDER_ID}.json`, value = s.bucket.values.get(orderKey)!;
  s.bucket.values.set(orderKey, { ...value, text: JSON.stringify({ ...JSON.parse(value.text), revoked_at: new Date().toISOString() }) });
  const originalBytes = () => [...s.bucket.values].filter(([key]) => !key.startsWith(PAID_RECOVERY_PRIORITY_PREFIX));
  const before = structuredClone(originalBytes());
  const result = await drainPaidRecoveryPriority(s.env);
  expect(result).toMatchObject({ outcome: 'degraded', counts: { quarantined: 1, recovered: 0, skipped: 0 } });
  const record = JSON.parse(s.bucket.values.get(`${PAID_RECOVERY_PRIORITY_PREFIX}orders/${TEST_ORDER_ID}.json`)!.text);
  expect(record).toMatchObject({ state: 'quarantined', reason: 'order_revoked' });
  expect(originalBytes()).toEqual(before); noWork(s);
  expect((await app.fetch(statusRequest(), s.env)).status).toBe(404);
});

it('derives a stable overdue episode from the original payment clock, then observes exact original recovery', async () => {
  const s = await original();
  const first = await readOrderRemediationSummary(s.env, TEST_ORDER_ID);
  expect(first).toMatchObject({ state: 'pending_original_delivery', reason: 'original_delivery_recoverable', inventory_complete: false });
  expect(first?.first_seen_at).not.toBeUndefined();
  const key = [...s.bucket.values.keys()].find(key => key.endsWith('/manifest.json'))!, artifact = s.bucket.values.get(key)!;
  s.bucket.values.delete(key);
  const second = await readOrderRemediationSummary(s.env, TEST_ORDER_ID);
  expect(second).toMatchObject({ state: 'needs_intervention', reason: 'original_evidence_unverified', episode_id: first!.episode_id, first_seen_at: first!.first_seen_at });
  const get = s.bucket.get.bind(s.bucket);
  s.bucket.get = async key => { if (key.endsWith('/manifest.json')) throw new Error('unavailable'); return get(key); };
  expect(await readOrderRemediationSummary(s.env, TEST_ORDER_ID)).toMatchObject({ state: 'unknown', episode_id: first!.episode_id, first_seen_at: first!.first_seen_at });
  s.bucket.get = get; s.bucket.values.set(key, artifact);
  expect((await app.fetch(statusRequest({ recover: true }), s.env)).status).toBe(200);
  expect(await readOrderRemediationSummary(s.env, TEST_ORDER_ID)).toBeNull(); noWork(s);
});
