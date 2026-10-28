import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('preload denies fetch, CJS/ESM HTTP, raw TCP and TLS before application imports', () => {
  const guard = fileURLToPath(new URL('./offline-guard.cjs', import.meta.url));
  const code = `
    import assert from 'node:assert/strict';
    import { request } from 'node:https';
    import { connect, Socket } from 'node:net';
    import { connect as tls } from 'node:tls';
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const blocked = /DELTA_OFFLINE_NETWORK_BLOCKED/;
    await assert.rejects(fetch('https://example.invalid'), blocked);
    assert.throws(() => request('https://example.invalid'), blocked);
    assert.throws(() => require('node:http').get('http://example.invalid'), blocked);
    assert.throws(() => connect(443, 'example.invalid'), blocked);
    assert.throws(() => new Socket().connect(443, 'example.invalid'), blocked);
    assert.throws(() => tls(443, 'example.invalid'), blocked);
    globalThis.fetch = async () => new Response('mock');
    assert.equal(await (await fetch('https://example.invalid')).text(), 'mock');
    console.log('isolated transports verified');
  `;
  const result = spawnSync(process.execPath, ['--require', guard, '--input-type=module', '-e', code], {
    encoding: 'utf8', timeout: 5000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('isolated transports verified');
});
