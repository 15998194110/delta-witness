import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const { createServer } = await import(pathToFileURL(resolve(process.argv[2], 'dist/index.js')));
const seen = [];
globalThis.fetch = async (url, options) => { seen.push({ url, options }); return Response.json({ fixture: true, price: 1 }); };
const server = createServer();
const client = new Client({ name: 'offline-packed-smoke', version: '1' });
const [a,b] = InMemoryTransport.createLinkedPair();
try {
  await server.connect(b); await client.connect(a);
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['delta_capture','delta_execute_order','delta_export_order_artifact','delta_preflight','delta_prepare_order','delta_quote','delta_recover_order','delta_verify_proof']);
  assert.deepEqual((await client.callTool({ name: 'delta_quote', arguments: { product: 'capture' } })).structuredContent, { fixture: true, price: 1 });
  assert.equal(seen.length,1);
  assert.equal(seen[0].options.method, undefined);
  console.log(JSON.stringify({ tools: names, package_start: 'pass', unpaid_quote: 'mock pass', payment_calls: 0 }));
} finally { await client.close(); await server.close(); }
