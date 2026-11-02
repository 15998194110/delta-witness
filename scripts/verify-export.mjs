#!/usr/bin/env node
// Explicit local files only; never a URL, payment, provider call or mutation.
import { open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
async function readBounded(path, limit) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > limit) throw new Error();
    const bytes = new Uint8Array(limit + 1); let used = 0;
    while (used < bytes.length) { const { bytesRead } = await file.read(bytes, used, bytes.length - used, used); if (!bytesRead) break; used += bytesRead; }
    if (used > limit) throw new Error(); return bytes.slice(0, used);
  } finally { await file.close(); }
}
export async function main(args = process.argv.slice(2)) {
  const expectedFlags = ['--manifest', '--html', '--markdown', '--screenshot', '--expected-bundle-root'];
  if (args.length !== 10 || expectedFlags.some((flag, i) => args[i * 2] !== flag || !args[i * 2 + 1])) throw new Error();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const compiled = await build({ entryPoints: [resolve(root, 'src/export-verification.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node24', write: false, logLevel: 'silent' });
  const module = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  const [manifest, html, markdown, screenshot] = await Promise.all([1_048_576, 2_000_000, 1_000_000, 6_000_000].map((limit, i) => readBounded(resolve(args[i * 2 + 1]), limit)));
  return module.verifyExportedBundle({ manifest, html, markdown, screenshot }, args[9]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await main(); console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1; }
  catch { console.error(JSON.stringify({ ok: false, error: 'export_verification_failed' })); process.exitCode = 1; }
}
