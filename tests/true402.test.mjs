import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

// The same regressions run with node --test locally and with the existing Vitest CI.
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
const sourceUrl = process.env.TRUE402_SOURCE
  ? pathToFileURL(process.env.TRUE402_SOURCE)
  : new URL('../scripts/register-true402.mjs', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const legacy = !source.includes('export async function runTrue402');
const module = legacy ? null : await import(sourceUrl.href);
const origin = 'https://delta-witness-api.ruphussten.workers.dev';
const entry = (id = 'capture-1', price = '1.00') => ({
  id, url: `${origin}/v1/capture`,
  manifest: { name: 'DELTA Witness Capture', endpoint: `${origin}/v1/capture`, pricing: { base: price, currency: 'USDC' } },
});
const json = (body, status = 200) => Response.json(body, { status });

async function run(handler, options = {}) {
  const calls = [];
  const logs = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', signal: init.signal });
    return handler(new URL(url), init, calls.length);
  };
  if (!legacy) {
    const result = await module.runTrue402({ fetchImpl, sleep: async () => {}, log: (value) => logs.push(value), ...options });
    return { result, calls, logs };
  }
  // The historical CLI is executed with ALL I/O substituted. No real gates, fetch,
  // child processes, timers, process exit, or external writes are possible.
  let result;
  const exit = new Error('fixture_process_exit');
  const context = vm.createContext({
    fetch: fetchImpl, AbortSignal, URL, JSON, Number, String,
    setTimeout: (callback) => { callback(); return 0; },
    spawnSync: () => ({ status: 0 }),
    process: { execPath: 'fixture', exit: () => { throw exit; } },
    console: {
      log: (line) => { if (line.startsWith('TRUE402_RESULT ')) result = JSON.parse(line.slice(15)); },
      error: (line) => logs.push(line),
    },
  });
  try {
    await new vm.Script(`(async () => {${source.replace(/^import[^\n]+\n/, '')}\n})()`).runInContext(context, { timeout: 1000 });
  } catch (error) {
    if (error !== exit) throw error;
  }
  return { result, calls, logs };
}

const noWrites = ({ calls }) => assert.equal(calls.filter((call) => call.method !== 'GET').length, 0);

test('server-capped short pages advance by returned count, including has_more=true', async () => {
  const observed = await run((url) => {
    const offset = Number(url.searchParams.get('offset'));
    return offset === 0
      ? json({ services: [{ id: 'a' }, { id: 'b' }], total: 3, has_more: true })
      : json({ services: [entry()], total: 3, has_more: false });
  });
  assert.equal(observed.result.discovery_status, 'present');
  assert.deepEqual(observed.calls.map((call) => Number(new URL(call.url).searchParams.get('offset'))), [0, 2]);
  noWrites(observed);
});

test('a short page without terminal metadata does not establish absence', async () => {
  const observed = await run((url) => {
    const offset = Number(url.searchParams.get('offset'));
    return json(offset === 0 ? [{ id: 'other' }] : offset === 1 ? [entry()] : []);
  });
  assert.equal(observed.result.discovery_status, 'present');
  assert.equal(observed.result.scan_complete, true);
  noWrites(observed);
});

test('an unknown successful payload is not an empty directory', async () => {
  const observed = await run(() => json({ message: 'upstream unavailable' }));
  assert.equal(observed.result.discovery_status, 'unknown');
  assert.equal(observed.result.scan_complete, false);
  assert.equal(observed.result.error.classification, 'malformed_response');
  noWrites(observed);
});

test('page budget exhaustion cannot declare absence or register', async () => {
  const observed = await run((url) => json({ services: Array.from({ length: 100 }, (_, index) => ({ id: `${url.searchParams.get('offset')}-${index}` })), has_more: true }), { maxPages: 2 });
  noWrites(observed);
  assert.equal(observed.result.scan_complete, false);
  assert.equal(observed.result.error.classification, 'scan_incomplete');
  assert.equal(observed.result.discovery_status, 'unknown');
});

test('unknown prior write outcome remains pending; timeout can never cause resubmission', async () => {
  const observed = await run((_url, init) => {
    if (init.method === 'POST') throw new DOMException('fixture timeout', 'TimeoutError');
    return json([]);
  }, { priorWriteUnknown: true });
  noWrites(observed);
  assert.equal(observed.result.listing_status, 'write_outcome_unknown');
  assert.equal(observed.result.write_outcome, 'pending_verification');
});

test('historical registrations prohibit re-registering even across independent runs', async () => {
  for (let index = 0; index < 2; index += 1) {
    const observed = await run(() => json([]));
    noWrites(observed);
    assert.equal(observed.result.listing_status, 'historical_identity_unverified');
    assert.equal(observed.result.historical_identity, 'present_in_repository');
  }
});

test('distinct duplicate listings and stale prices are reported without rewriting them', async () => {
  const observed = await run(() => json({ services: [entry('old', '0.03'), entry('new')], has_more: false }));
  assert.equal(observed.result.catalog_refresh_pending, true);
  assert.equal(observed.result.duplicate_entries, 1);
  assert.equal(observed.result.stale_price_entries, 1);
  assert.equal(observed.result.listing_status, 'catalog_review_required');
  noWrites(observed);
});

for (const status of [401, 403]) {
  test(`HTTP ${status} is a provider permission failure with no automatic retry`, async () => {
    const observed = await run(() => json({ error: 'denied' }, status));
    assert.equal(observed.calls.length, 1);
    assert.equal(observed.result.error.classification, status === 401 ? 'authentication_required' : 'http_forbidden');
    assert.equal(observed.result.error.status, status);
  });
}

test('explicit safety denial is classified separately and never retried even with HTTP 503', async () => {
  const observed = await run(() => json({ code: 'SAFETY_DENIED', message: 'platform safety policy blocked action' }, 503));
  assert.equal(observed.calls.length, 1);
  assert.equal(observed.result.error.classification, 'platform_safety_denied');
});

test('a listing description mentioning safety_denied is data, not a platform refusal', async () => {
  const row = entry();
  row.manifest.description = 'Shows safety_denied diagnostics for a protected action';
  const observed = await run(() => json({ services: [row], has_more: false }));
  assert.equal(observed.result.discovery_status, 'present');
  assert.equal(observed.calls.length, 1);
});

test('transient HTTP failures have a bounded read retry and finite timeout', async () => {
  const observed = await run(() => json({ error: 'temporary' }, 503));
  assert.equal(observed.calls.length, 3);
  assert.ok(observed.calls.every((call) => call.signal instanceof AbortSignal));
  assert.equal(observed.result.error.classification, 'http_transient');
  noWrites(observed);
});

test('transient read failures can recover without producing a new identity', async () => {
  const observed = await run((_url, _init, attempt) => attempt < 3 ? json({}, 429) : json({ services: [entry()], has_more: false }));
  assert.equal(observed.calls.length, 3);
  assert.equal(observed.result.discovery_status, 'present');
  noWrites(observed);
});

test('response data is allowlisted; unexpected secret fields never enter diagnostics', async () => {
  const row = { ...entry(), api_key: 'fixture-secret-123', customer_email: 'fixture@example.test' };
  const observed = await run(() => json({ services: [row], has_more: false }));
  assert.ok(!JSON.stringify(observed.result).includes('fixture-secret-123'));
  assert.ok(!JSON.stringify(observed.result).includes('fixture@example.test'));
  assert.equal(observed.result.matches[0].expected_price_usdc, '1.00');
});

test('transport error detail is redacted and an unclassified failure is not retried', async () => {
  const observed = await run(() => { throw new Error('unknown key=fixture-secret-123 https://host.test/?token=fixture-secret-123 Bearer fixture-secret-123'); });
  assert.equal(observed.calls.length, 1);
  assert.ok(!JSON.stringify([observed.result, observed.logs]).includes('fixture-secret-123'));
  assert.equal(observed.result.error.classification, 'unknown');
});

test('invalid JSON is a malformed response, not a retryable outage or absence', async () => {
  const observed = await run(() => new Response('{invalid', { status: 200 }));
  assert.equal(observed.calls.length, 1);
  assert.equal(observed.result.error.classification, 'malformed_response');
  assert.equal(observed.result.scan_complete, false);
});

test('contradictory total and continuation metadata leave the scan incomplete', async () => {
  const observed = await run(() => json({ services: [], has_more: true, total: 0 }));
  noWrites(observed);
  assert.equal(observed.result.scan_complete, false);
  assert.equal(observed.result.error.classification, 'malformed_pagination');
});

test('a repeated page without progress cannot establish absence', async () => {
  const observed = await run(() => json({ services: [{ id: 'same' }], has_more: true }));
  noWrites(observed);
  assert.equal(observed.result.scan_complete, false);
  assert.equal(observed.result.error.classification, 'scan_incomplete');
});

test('match before a later failure remains observed, with incomplete scan explicit', async () => {
  const observed = await run((_url, _init, attempt) => attempt === 1
    ? json({ services: [entry()], has_more: true }) : json({ error: 'denied' }, 401));
  assert.equal(observed.result.discovery_status, 'present');
  assert.equal(observed.result.scan_complete, false);
  assert.equal(observed.result.listing_status, 'catalog_verification_incomplete');
  noWrites(observed);
});

test('same-name and same-wallet unrelated resources do not establish callable DELTA products', async () => {
  const unrelated = { id: 'other', manifest: { name: 'DELTA Witness', endpoint: 'https://unrelated.test/tool', payment: { address: '0x1990e21bc219696ff7fbc26527dbaed335ac6367' } } };
  const observed = await run(() => json({ services: [unrelated], has_more: false }));
  assert.equal(observed.result.matches[0].endpoint, null);
  assert.equal(observed.result.matches[0].callable_verified, false);
  assert.equal(observed.result.listing_status, 'catalog_review_required');
  noWrites(observed);
});

test('current price without correct method payment and input schema remains unverified', async () => {
  const row = entry();
  row.manifest.method = 'GET';
  const observed = await run(() => json({ services: [row], has_more: false }));
  assert.equal(observed.result.matches[0].price_status, 'current');
  assert.equal(observed.result.matches[0].contract_status, 'unverified_or_mismatched');
  assert.equal(observed.result.matches[0].callable_verified, false);
  assert.equal(observed.result.listing_status, 'catalog_review_required');
});

test('a hanging registry body is bounded and never triggers registration', async () => {
  const observed = await run(() => new Response(new ReadableStream({})), { timeoutMs: 15, attempts: 1 });
  assert.equal(observed.result.scan_complete, false);
  assert.equal(observed.result.error.classification, 'network_timeout');
  noWrites(observed);
});
