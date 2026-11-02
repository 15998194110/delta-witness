import { afterEach, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { verifyExportedBundle } from '../src/export-verification';
import { MemoryBucket, orderRuntime, orderRequest, mockOrderNetwork, TEST_ORDER_ID, TEST_RECOVERY_TOKEN } from './helpers/order-runtime';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error reviewed local-only CLI
import { main } from '../scripts/verify-export.mjs';
afterEach(() => vi.unstubAllGlobals());
async function files() {
  const bucket = new MemoryBucket(), env = orderRuntime(bucket); vi.stubGlobal('fetch', mockOrderNetwork());
  const delivery = await (await app.fetch(orderRequest(), env)).json() as any;
  const result: any = {};
  for (const name of ['manifest', 'html', 'markdown', 'screenshot']) {
    const response = await app.fetch(new Request(`https://delta.test/v1/orders/${TEST_ORDER_ID}/artifacts/${name}`, { headers: { 'x-delta-recovery-token': TEST_RECOVERY_TOKEN } }), env);
    expect(response.status).toBe(200); result[name] = new Uint8Array(await response.arrayBuffer());
  }
  return { result, delivery, bucket, env };
}
it('verifies the exact authorized download against the original paid delivery without network', async () => {
  const { result, delivery } = await files(); vi.stubGlobal('fetch', () => { throw new Error('offline'); });
  expect(await verifyExportedBundle(result, delivery.bundle_root)).toMatchObject({ ok: true, proof_id: delivery.proof_id, source_truth_verified: false });
});
it.each(['html', 'markdown', 'screenshot', 'manifest'])('detects missing, replaced or truncated %s without reading a remote resource', async name => {
  const { result, delivery } = await files(); vi.stubGlobal('fetch', () => { throw new Error('offline'); });
  expect(await verifyExportedBundle({ ...result, [name]: new Uint8Array() }, delivery.bundle_root)).toMatchObject({ ok: false });
  const changed = result[name].slice(); changed[0] ^= 1;
  expect(await verifyExportedBundle({ ...result, [name]: changed }, delivery.bundle_root)).toMatchObject({ ok: false });
});
it('does not trust a self-consistent replacement manifest root instead of the original delivery', async () => {
  const { result } = await files();
  expect(await verifyExportedBundle(result, `sha256:${'0'.repeat(64)}`)).toMatchObject({ ok: false });
});
it('runs the actual local CLI with explicit bounded files and no side effects', async () => {
  const { result, delivery } = await files(); vi.stubGlobal('fetch', () => { throw new Error('offline'); });
  const dir = await mkdtemp(join(tmpdir(), 'delta-synthetic-export-')); const args = [];
  for (const name of ['manifest','html','markdown','screenshot']) {
    const path = join(dir, name); await writeFile(path, result[name], { flag: 'wx' }); args.push(`--${name}`, path);
  }
  args.push('--expected-bundle-root', delivery.bundle_root);
  expect(await main(args)).toMatchObject({ ok: true, proof_id: delivery.proof_id });
  await expect(main([])).rejects.toThrow();
});
