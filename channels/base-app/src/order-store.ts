import type { OrderRecord, OrderStore } from '../../../packages/js-client/src/index.js';
import { BuyerMessageError, type PaymentStorage } from './domain';

// Private same-origin capability store. Never place this value in a URL, DOM,
// analytics, error, or public handoff. The existing non-secret v1 marker remains.
export const ORDER_STORE_KEY = 'delta-witness:private-orders:v1';
const STORE_LOCK = 'delta-witness:private-orders:write:v1';
const MAX_BYTES = 1_048_576;
const MAX_ORDERS = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type SavedOrder = { record: OrderRecord; legacyAttemptId?: string };
type SavedStore = { schema: 'delta-browser-orders/v1'; active: string | null; last_completed?: string; orders: Record<string, SavedOrder> };
export type BrowserOrderStore = OrderStore & {
  active(): Promise<{ order_id: string; product: OrderRecord['product']; legacyAttemptId?: string } | null>;
  lastCompleted(): Promise<string | null>;
  bindAttempt(id: string, attemptId: string): Promise<void>;
  finish(id: string): Promise<void>;
};

function unavailable(): Error {
  return new BuyerMessageError('Saved order storage is unavailable or inconsistent. Keep the original order; no new payment was started.');
}

export function createBrowserOrderStore(storage: PaymentStorage, locks: LockManager | undefined): BrowserOrderStore {
  function read(): SavedStore {
    try {
      const raw = storage.getItem(ORDER_STORE_KEY);
      if (raw === null) return { schema: 'delta-browser-orders/v1', active: null, orders: {} };
      if (new TextEncoder().encode(raw).length > MAX_BYTES) throw unavailable();
      const value = JSON.parse(raw) as SavedStore;
      if (!value || value.schema !== 'delta-browser-orders/v1' || !value.orders || Array.isArray(value.orders) ||
          Object.keys(value).some(k => !['schema', 'active', 'orders', 'last_completed'].includes(k)) ||
          Object.keys(value.orders).length > MAX_ORDERS ||
          (value.active !== null && (!UUID.test(value.active) || !Object.hasOwn(value.orders, value.active))) ||
          (value.last_completed !== undefined && (!UUID.test(value.last_completed) || value.orders[value.last_completed]?.record.phase !== 'complete'))) throw unavailable();
      for (const [id, item] of Object.entries(value.orders)) {
        if (!UUID.test(id) || !item || !item.record || item.record.order_id !== id ||
            !['capture', 'preflight'].includes(item.record.product) ||
            !Number.isSafeInteger(item.record.revision) || item.record.revision < 0 ||
            Object.keys(item).some(k => !['record', 'legacyAttemptId'].includes(k)) ||
            (item.legacyAttemptId !== undefined && !/^sha256:[0-9a-f]{64}$/.test(item.legacyAttemptId))) throw unavailable();
      }
      return value;
    } catch { throw unavailable(); }
  }
  function write(value: SavedStore): void {
    const raw = JSON.stringify(value);
    if (new TextEncoder().encode(raw).length > MAX_BYTES || Object.keys(value.orders).length > MAX_ORDERS) {
      throw new BuyerMessageError('The local order archive is full. Existing records are retained. New orders are blocked; do not clear unresolved order data.');
    }
    storage.setItem(ORDER_STORE_KEY, raw);
    if (storage.getItem(ORDER_STORE_KEY) !== raw) throw unavailable();
  }
  async function mutate<T>(fn: (store: SavedStore) => T): Promise<T> {
    if (!locks) throw unavailable();
    // One atomic localStorage cell under a distinct cross-tab Web Lock. Payment's
    // existing Web Lock is retained; this lock protects record + active pointer.
    return locks.request(STORE_LOCK, { mode: 'exclusive' }, () => {
      const store = read();
      const result = fn(store);
      write(store);
      return result;
    });
  }
  return {
    async load(id) { if (!UUID.test(id)) throw unavailable(); return read().orders[id]?.record ?? null; },
    async compareAndSet(id, revision, next) {
      if (!UUID.test(id) || next.order_id !== id || next.revision !== (revision === null ? 0 : revision + 1)) throw unavailable();
      return mutate(store => {
        const old = store.orders[id];
        if (revision === null) {
          if (old || store.active !== null) return false;
          store.active = id;
        } else if (!old || old.record.revision !== revision) return false;
        store.orders[id] = { ...old, record: structuredClone(next) };
        return true;
      });
    },
    async active() {
      const store = read();
      if (!store.active) return null;
      const item = store.orders[store.active];
      return { order_id: store.active, product: item.record.product, ...(item.legacyAttemptId ? { legacyAttemptId: item.legacyAttemptId } : {}) };
    },
    async lastCompleted() { return read().last_completed ?? null; },
    async bindAttempt(id, attemptId) {
      if (!/^sha256:[0-9a-f]{64}$/.test(attemptId)) throw unavailable();
      await mutate(store => {
        const old = store.orders[id];
        if (store.active !== id || !old || (old.legacyAttemptId && old.legacyAttemptId !== attemptId)) throw unavailable();
        old.legacyAttemptId = attemptId;
      });
    },
    async finish(id) {
      await mutate(store => {
        if ((store.active !== id && store.active !== null) || store.orders[id]?.record.phase !== 'complete') throw unavailable();
        // Keep the record/capability for later retrieval. Never erase an unknown
        // order, old marker, or expired credential to make a new purchase work.
        store.active = null;
        store.last_completed = id;
      });
    },
  };
}
