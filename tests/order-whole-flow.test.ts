import { afterEach, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { DeltaWitness } from '../packages/js-client/src/index.js';
import { verifyExportedBundle } from '../src/export-verification';
import { readCoreAccountingEvidence, deriveOrderAccounting, type AuditAttestation } from '../src/accounting';
import { MemoryBucket, orderRuntime, mockOrderNetwork, orderPayment, TEST_ORDER_ID, TEST_PAYER } from './helpers/order-runtime';
// @ts-expect-error shared receipt parser, no provider invocation on import
import { normalizeLogs, NETWORK, USDC, TREASURY, TRANSFER_TOPIC, TO_TOPIC } from '../scripts/treasury-reconciliation.mjs';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('one synthetic order: quote, automatic authorization, lost response, restart, original export, offline verification, receipt and cost reconciliation', async () => {
  const now = '2026-11-02T00:00:00.000Z'; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  const bucket = new MemoryBucket(), env = orderRuntime(bucket), network = mockOrderNetwork(); vi.stubGlobal('fetch', network);
  const records = new Map<string, any>();
  const store = { load: async (id: string) => structuredClone(records.get(id) ?? null), compareAndSet: async (id: string, revision: number | null, record: any) => {
    if ((records.get(id)?.revision ?? null) !== revision) return false; records.set(id, structuredClone(record)); return true;
  } };
  const transport = (url: string, init?: RequestInit) => app.fetch(new Request(url, init), env);
  const client = new DeltaWitness({ baseUrl: 'https://delta.test', orderStore: store, fetchImpl: transport });
  const quote: any = await client.quote('capture'); expect(quote.price).toBe('$1'); expect(quote.order_recovery.enabled).toBe(true);
  await client.prepareOrder('capture', { url: 'https://example.com/' }, { orderId: TEST_ORDER_ID });
  let signingCalls = 0;
  await expect(client.executeOrder(TEST_ORDER_ID, async (url, init) => {
    signingCalls++;
    const headers = new Headers(init.headers); headers.set('payment-signature', Buffer.from(JSON.stringify(orderPayment())).toString('base64'));
    const response = await transport(url, { ...init, headers }); expect(response.status).toBe(200);
    throw new Error('synthetic-response-lost-after-Core-commit');
  })).rejects.toThrow('payment_outcome_unconfirmed');
  const originalObjects = new Map([...bucket.values].filter(([key]) => !key.startsWith('orders/')).map(([key, value]) => [key, structuredClone(value)]));
  const restarted = new DeltaWitness({ baseUrl: 'https://delta.test', orderStore: store, fetchImpl: transport });
  const result = await restarted.executeOrder(TEST_ORDER_ID, () => { signingCalls++; throw new Error('must-not-sign'); });
  expect(result.state).toBe('complete'); expect(signingCalls).toBe(1);
  const files: any = {};
  for (const name of ['html', 'markdown', 'screenshot', 'manifest'] as const) files[name] = (await restarted.exportArtifact(TEST_ORDER_ID, name)).bytes;
  expect(await verifyExportedBundle(files, result.delivery!.bundle_root)).toMatchObject({ ok: true, proof_id: result.delivery!.proof_id });
  const hash = `0x${'ab'.repeat(32)}`;
  const checkpoint = { schema: 'delta-treasury-checkpoint/v1', network: NETWORK, asset: USDC, treasury: TREASURY, origin_block: 90,
    checked_through_block: 110, confirmation_depth: 1, checked_at: now, checked_through_hash: hash, reorg_anchor: { number: 100, hash }, corrections: [],
    transfers: normalizeLogs([{ removed: false, address: USDC, transactionHash: `0x${'12'.repeat(32)}`, blockHash: hash, blockNumber: '0x64', logIndex: '0x0',
      topics: [TRANSFER_TOPIC, `0x${TEST_PAYER.slice(2).padStart(64, '0')}`, TO_TOPIC], data: `0x${(1000000n).toString(16).padStart(64, '0')}` }], 90, 110),
  };
  const audit: AuditAttestation = { order_id: TEST_ORDER_ID, buyer: 'independent_customer', evidence_ref: 'fixture-only-not-real-customer',
    refunds: { coverage: 'complete', raw_amount: '0', evidence_ref: 'fixture-refund-audit' },
    costs: Object.fromEntries(['browser','storage','compute','reads_downloads','settlement','failed_attempts','platform','support','acquisition'].map(key => [key, { raw_usdc: '100', evidence_ref: `fixture-${key}` }])),
  };
  const evidence = await readCoreAccountingEvidence(env, TEST_ORDER_ID);
  const report = await deriveOrderAccounting({ as_of: now, orders: [evidence], treasury_checkpoint: checkpoint, attestations: [audit] });
  expect(report.rows[0]).toMatchObject({ order_id: TEST_ORDER_ID, proof_id: result.delivery!.proof_id,
    treasury_received: 'confirmed', recognized_customer_revenue_raw: '1000000', actual_contribution_margin_raw: '999300' });
  expect((await deriveOrderAccounting({ as_of: now, orders: [evidence], treasury_checkpoint: null })).recognized_customer_revenue_raw).toBeNull();
  expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  expect(network.mock.calls.filter(([url]) => String(url).endsWith('/settle'))).toHaveLength(1);
  expect(new Map([...bucket.values].filter(([key]) => !key.startsWith('orders/')).map(([key, value]) => [key, structuredClone(value)]))).toEqual(originalObjects);
});
