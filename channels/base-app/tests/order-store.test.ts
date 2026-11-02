// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { DeltaWitness } from '../../../packages/js-client/src/index.js';
import { createBrowserOrderStore, ORDER_STORE_KEY } from '../src/order-store';

// Explicit serial Web Lock fixture; no browser/provider network or signing.
function locks() {
  let tail: Promise<unknown> = Promise.resolve();
  return { request: (_name: string, _options: unknown, callback: () => unknown) => {
    const next = tail.then(callback); tail = next.catch(() => {}); return next;
  } } as unknown as LockManager;
}
beforeEach(() => window.localStorage.clear());
it('two stores share atomic creation and preserve the losing attempt without creating another identity', async () => {
  const lock = locks();
  const stores = [createBrowserOrderStore(window.localStorage, lock), createBrowserOrderStore(window.localStorage, lock)];
  const clients = stores.map(orderStore => new DeltaWitness({ orderStore }));
  const results = await Promise.allSettled(clients.map(client => client.prepareOrder('capture', { url: 'https://example.org/' })));
  expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
  const saved = JSON.parse(window.localStorage.getItem(ORDER_STORE_KEY)!);
  expect(Object.keys(saved.orders)).toHaveLength(1); expect(saved.active).toBe(Object.keys(saved.orders)[0]);
  await expect(stores[0].finish(saved.active)).rejects.toThrow();
});
it('two stores cannot advance the same revision twice or clear an unknown original', async () => {
  const lock = locks(); const one = createBrowserOrderStore(window.localStorage, lock), two = createBrowserOrderStore(window.localStorage, lock);
  const client = new DeltaWitness({ orderStore: one });
  const order = await client.prepareOrder('capture', { url: 'https://example.org/' });
  const record: any = await one.load(order.order_id);
  const next = { ...record, revision: 1, phase: 'signing_started' };
  const results = await Promise.all([one.compareAndSet(order.order_id, 0, next), two.compareAndSet(order.order_id, 0, next)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  await expect(two.finish(order.order_id)).rejects.toThrow();
  expect((await two.active())?.order_id).toBe(order.order_id);
});
it('corrupt storage and unavailable cross-tab locks fail without deleting any evidence', async () => {
  window.localStorage.setItem(ORDER_STORE_KEY, '{broken');
  const store = createBrowserOrderStore(window.localStorage, locks());
  await expect(store.active()).rejects.toThrow();
  expect(window.localStorage.getItem(ORDER_STORE_KEY)).toBe('{broken');
  window.localStorage.clear();
  await expect(new DeltaWitness({ orderStore: createBrowserOrderStore(window.localStorage, undefined) }).prepareOrder('capture', { url: 'https://example.org/' })).rejects.toThrow();
  expect(window.localStorage.getItem(ORDER_STORE_KEY)).toBeNull();
});
