#!/usr/bin/env node
// Offline only. Reuses Core original-record checks and the canonical Treasury
// validator. No cloud client, secret loading, payment, refund or mutation path.
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readLocalInventory } from './retention-dry-run.mjs';
import { NETWORK, TREASURY } from './treasury-reconciliation.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function evaluateLocalAccounting(input) {
  if (!input || input.schema !== 'delta-local-accounting-input/v1' || !Array.isArray(input.order_ids) || input.order_ids.length > 100 ||
      (input.watch_ids !== undefined && !Array.isArray(input.watch_ids)) ||
      (input.pilot_orders !== undefined && (!Array.isArray(input.pilot_orders) || input.pilot_orders.length > 100)) ||
      input.order_ids.length + (input.watch_ids?.length ?? 0) + (input.pilot_orders?.length ?? 0) < 1 ||
      !Array.isArray(input.objects) || input.objects.length > 1000) throw new Error('invalid_accounting_inventory');
  const values = new Map();
  for (const object of input.objects) {
    if (!object || typeof object.key !== 'string' || !/^(?:(?:orders|watches)\/[0-9a-f-]{36}\.json|(?:settlements|fulfillments|guarded-pilot)\/[0-9a-f]{64}\.json|[0-9a-f-]{36}\/(?:page\.html|page\.md|screenshot\.png|manifest\.json))$/.test(object.key) ||
        typeof object.base64 !== 'string' || values.has(object.key)) throw new Error('invalid_accounting_object');
    const bytes = Buffer.from(object.base64, 'base64');
    if (bytes.toString('base64') !== object.base64) throw new Error('invalid_accounting_object');
    values.set(object.key, bytes);
  }
  const result = await build({ entryPoints: [resolve(root, 'src/accounting.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node24', write: false, logLevel: 'silent' });
  const { readCoreAccountingEvidence, readPilotAccountingEvidence, deriveOrderAccounting, readPrepaidWatchAccounting } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  const env = { NETWORK, PAY_TO: TREASURY, PROOFS: {
    get: async key => { const bytes = values.get(key); return bytes ? { size: bytes.length, etag: 'offline-snapshot', body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) } : null; },
    put: async () => { throw new Error('accounting_must_not_write'); },
  } };
  const orders = [];
  // Sequential bounded reads, no network and no unbounded fanout. Local input
  // is capped at 2MB by the existing fixed-buffer reader before decoding.
  for (const id of new Set(input.order_ids)) orders.push(await readCoreAccountingEvidence(env, id));
  const pilots = new Map();
  for (const identity of input.pilot_orders ?? []) {
    if (!identity || typeof identity.payment_fingerprint !== 'string' || typeof identity.settlement_key !== 'string') throw new Error('invalid_pilot_accounting_identity');
    const prior = pilots.get(identity.payment_fingerprint);
    if (prior && prior.settlement_key !== identity.settlement_key) throw new Error('conflicting_pilot_accounting_identity');
    pilots.set(identity.payment_fingerprint, identity);
  }
  for (const identity of pilots.values()) orders.push(await readPilotAccountingEvidence(env, identity));
  const direct = await deriveOrderAccounting({ as_of: input.as_of, orders, treasury_checkpoint: input.treasury_checkpoint, attestations: input.attestations });
  const report = { ...direct, prepaid_watch: await readPrepaidWatchAccounting(env, input.watch_ids ?? []),
    local_inventory_sha256: `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}` };
  return { ...report, report_hash: `sha256:${createHash('sha256').update(JSON.stringify(report)).digest('hex')}` };
}
export async function main(args = process.argv.slice(2)) {
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output' || !args[1] || !args[3]) throw new Error('invalid_arguments');
  const input = resolve(args[1]), output = resolve(args[3]);
  if (input === output) throw new Error('output_must_be_new');
  const bytes = await readLocalInventory(input);
  const report = await evaluateLocalAccounting(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ok: true, scope: 'local_supplied_evidence_only', state: report.state, orders: report.rows.length, report_hash: report.report_hash };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main())); }
  catch { console.error(JSON.stringify({ ok: false, state: 'unknown', error: 'local_accounting_failed' })); process.exitCode = 1; }
}
