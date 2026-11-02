import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, open, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FileOrderStore, saveOrderExport } from '../src/order-store.js';
import { DeltaWitness } from '../../js-client/src/index.js';
import { createServer } from '../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const id = '2dc6fc8a-bd23-42b4-8ccc-c42c27cef22f';
const origin = 'https://delta-witness-api.ruphussten.workers.dev';
const proof = '56347db8-1aa5-447f-a0e4-3bb052d7aa89';
const delivery = { ok: true, product: 'capture', proof_id: proof, manifest_url: `${origin}/v1/proofs/${proof}`,
  public_proof_url: `${origin}/p/${proof}`, bundle_root: `sha256:${'a'.repeat(64)}`, observed_at: '2026-11-02T00:00:00Z' };
async function call(name: string, args: Record<string, unknown>) {
  const server = createServer(), client = new Client({ name: 'isolated-order-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try { await server.connect(b); await client.connect(a); return await client.callTool({ name, arguments: args }); }
  finally { await client.close(); await server.close(); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('shared order SDK and private append-only MCP store', () => {
  it('has a single compare-and-set winner across independent store instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'delta-mcp-cas-'));
    const stores = [new FileOrderStore(dir), new FileOrderStore(dir)];
    const record = { order_id: id, revision: 0 };
    expect((await Promise.all(stores.map(s => s.compareAndSet(id, null, record)))).filter(Boolean)).toHaveLength(1);
    expect(await stores[1].load(id)).toEqual(record);
    expect(await stores[1].compareAndSet(id, null, record)).toBe(false);
  });
  it('keeps partial revision evidence and refuses another paid attempt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'delta-mcp-partial-'));
    const store = new FileOrderStore(dir);
    const client = new DeltaWitness({ orderStore: store });
    await client.prepareOrder('capture', { url: 'https://example.com' }, { orderId: id });
    await writeFile(join(dir, id, '000001.json'), '{', { flag: 'wx' });
    const paid = vi.fn();
    await expect(client.executeOrder(id, paid)).rejects.toMatchObject({ code: 'order_store_unavailable' });
    expect(paid).not.toHaveBeenCalled();
    expect(await readFile(join(dir, id, '000001.json'), 'utf8')).toBe('{');
  });
  it('recovers after a new client/store instance with one original payment call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'delta-mcp-restart-'));
    const first = new DeltaWitness({ orderStore: new FileOrderStore(dir) });
    await first.prepareOrder('capture', { url: 'https://example.com' }, { orderId: id });
    const paid = vi.fn(async () => { throw new Error('lost response'); });
    await expect(first.executeOrder(id, paid)).rejects.toMatchObject({ code: 'payment_outcome_unconfirmed' });
    const read = vi.fn(async () => Response.json({ ok: true, order_id: id, product: 'capture', state: 'complete',
      payment: { state: 'settlement_confirmed', treasury_received: null }, fulfillment: { state: 'complete' },
      recovery: { can_recover: false, expires_at: '2026-11-03T00:00:00Z' }, delivery }));
    const restarted = new DeltaWitness({ orderStore: new FileOrderStore(dir), fetchImpl: read });
    expect(await restarted.executeOrder(id, paid)).toMatchObject({ order_id: id, state: 'complete', delivery });
    expect(paid).toHaveBeenCalledTimes(1);
    expect(String(read.mock.calls[0][0])).toBe(`${origin}/v1/orders/${id}`);
  });
  it('preparation is free and capability stays out of MCP output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'delta-mcp-tool-'));
    vi.stubEnv('DELTA_ORDER_STORE_DIR', dir);
    const network = vi.fn(); vi.stubGlobal('fetch', network);
    const result = await call('delta_prepare_order', { order_id: id, product: 'capture', url: 'https://example.com' });
    expect(result.structuredContent).toEqual({ order_id: id, product: 'capture', state: 'prepared' });
    const record = await new FileOrderStore(dir).load(id);
    expect(JSON.stringify(result)).not.toContain(record.recovery_token);
    expect(network).not.toHaveBeenCalled();
  });
  it('restart lookup without signer never treats 404 as a new purchase', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'delta-mcp-404-'));
    vi.stubEnv('DELTA_ORDER_STORE_DIR', dir); vi.stubEnv('EVM_PRIVATE_KEY', '');
    const network = vi.fn(async () => Response.json({}, { status: 404 })); vi.stubGlobal('fetch', network);
    await call('delta_prepare_order', { order_id: id, product: 'capture', url: 'https://example.com' });
    expect((await call('delta_recover_order', { order_id: id })).isError).toBe(true);
    expect((await call('delta_execute_order', { order_id: id })).isError).toBe(true);
    expect(network.mock.calls).toHaveLength(2);
    expect(network.mock.calls.every(([url, init]) => String(url).includes('/v1/orders/') && init.method === 'GET')).toBe(true);
  });
  it('exports opaque data once without exposing bytes or capability and preserves conflicting files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'delta-mcp-export-'));
    vi.stubEnv('DELTA_ORDER_STORE_DIR', dir);
    const raw = '<script>synthetic captured data</script>';
    const hash = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, { headers: {
      'content-disposition': 'attachment; filename="ignored-by-client.html"',
      'content-length': String(Buffer.byteLength(raw)), 'x-delta-content-sha256': hash,
    } })));
    await call('delta_prepare_order', { order_id: id, product: 'capture', url: 'https://example.com' });
    const exported = await call('delta_export_order_artifact', { order_id: id, artifact: 'html' });
    expect(exported.isError).not.toBe(true);
    expect(exported.structuredContent).toMatchObject({ order_id: id, artifact: 'html', content_sha256: hash });
    expect(JSON.stringify(exported)).not.toContain(raw);
    expect(JSON.stringify(exported)).not.toContain((await new FileOrderStore(dir).load(id)).recovery_token);
    const path = String(exported.structuredContent!.path);
    expect(await readFile(path,'utf8')).toBe(raw);
    expect((await call('delta_export_order_artifact', { order_id: id, artifact: 'html' })).isError).not.toBe(true);
    await writeFile(path, 'fixture conflicting file');
    expect((await call('delta_export_order_artifact', { order_id: id, artifact: 'html' })).isError).toBe(true);
    expect(await readFile(path,'utf8')).toBe('fixture conflicting file');
  });
  it('bounds verification when an existing export grows during reads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'delta-mcp-export-growth-'));
    const bytes = new Uint8Array(131072);
    const path = await saveOrderExport(dir,id,`delta-${id}-page.html`,bytes);
    const handle = await open(path,'r');
    const prototype = Object.getPrototypeOf(handle);
    const original = prototype.read;
    await handle.close();
    let reads = 0;
    const spy = vi.spyOn(prototype,'read').mockImplementation(async function(this: any,...args: any[]) {
      reads++;
      await appendFile(path, Buffer.alloc(65536));
      return original.apply(this,args);
    });
    try {
      await expect(saveOrderExport(dir,id,`delta-${id}-page.html`,bytes)).rejects.toThrow('export_conflict');
      expect(reads).toBe(2);
    } finally { spy.mockRestore(); }
  });
});
