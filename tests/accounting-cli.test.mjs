import { describe, it, expect, vi, afterEach } from 'vitest';
import { evaluateLocalAccounting } from '../scripts/query-order-accounting.mjs';
afterEach(() => vi.unstubAllGlobals());
describe('offline accounting query', () => {
  it('imports and evaluates missing local evidence without contacting a provider or inferring zero', async () => {
    const network = vi.fn(() => { throw new Error('network forbidden'); }); vi.stubGlobal('fetch', network);
    const result = await evaluateLocalAccounting({ schema: 'delta-local-accounting-input/v1', as_of: '2026-11-02T00:00:00.000Z', order_ids: ['11111111-1111-4111-8111-111111111111'], objects: [], treasury_checkpoint: null });
    expect(result.state).toBe('partial'); expect(result.recognized_customer_revenue_raw).toBeNull(); expect(network).not.toHaveBeenCalled();
  });
  it.each(['../../private.key', 'wallet/seed.txt', 'proofs/anything'])('rejects out-of-contract local object key %s', async key => {
    await expect(evaluateLocalAccounting({ schema: 'delta-local-accounting-input/v1', order_ids: ['x'], objects: [{ key, base64: '' }] })).rejects.toThrow('invalid_accounting_object');
  });
});
