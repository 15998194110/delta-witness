// Public readback only. No credentials, paid requests, internal routes or raw artifacts.
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORE_ORIGIN = 'https://delta-witness-api.ruphussten.workers.dev';
export const PROOF_ID = '56347db8-1aa5-447f-a0e4-3bb052d7aa89';
export const NETWORK = 'eip155:8453';
export const MAX_RESPONSE_BYTES = 262144;
export const TARGETS = Object.freeze([
  { id: 'core_health', url: `${CORE_ORIGIN}/health` },
  { id: 'gateway_health', url: 'https://delta-witness-partner-gateway.ruphussten.workers.dev/health' },
  { id: 'original_proof_metadata', url: `${CORE_ORIGIN}/v1/proofs/${PROOF_ID}` },
  { id: 'openapi', url: `${CORE_ORIGIN}/openapi.json` },
].map(Object.freeze));

// Original public demo hashes, independently retained before the 2026-11-05 release.
// This checks metadata continuity; it does not download artifacts or authenticate
// the legacy bundle root, which the public verifier explicitly cannot establish.
export const ORIGINAL_PROOF_HASHES = Object.freeze({
  html: 'sha256:7b6cd9a1d881c4a69bf70b9babb5a4a90e38aa6f9933785508a38f665d4d4aab',
  markdown: 'sha256:023b6213a29b065efb0f3648d00aa5c8bc4e22c71eeac735d9afed0d6b612e0f',
  screenshot_png: 'sha256:c7151a9c7a80942cc95704027d36135c55aeb9526e198088bd08fb7259262865',
});
const proofFields = new Set(['schema', 'proof_id', 'product', 'requested_url', 'requested_url_sha256',
  'capture_started_at', 'capture_completed_at', 'observed_http_status', 'observed_title',
  'observed_final_url', 'redirects', 'hashes', 'artifact_sizes', 'execution', 'payment',
  'attestation', 'disclaimer', 'integrity']);
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const version = x => typeof x === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(x);
const isoTime = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(x) && Number.isFinite(Date.parse(x));
class ReadbackError extends Error {
  constructor(code, status = 'FAIL') { super(code); this.code = code; this.status = status; }
}
function requireCondition(condition, code) { if (!condition) throw new ReadbackError(code); }

function validate(id, value, headers, expectedCoreVersion, now) {
  requireCondition(record(value), 'invalid_object');
  if (id === 'core_health') {
    requireCondition(value.ok === true && value.version === expectedCoreVersion && value.network === NETWORK, 'core_identity_mismatch');
    requireCondition(isoTime(value.ts), 'invalid_core_clock');
    if (Math.abs(Date.parse(value.ts) - now()) > 300000) throw new ReadbackError('stale_core_clock', 'UNKNOWN');
    return { version: value.version, network: value.network, server_observed_at: value.ts };
  }
  if (id === 'gateway_health') {
    requireCondition(value.ok === true && version(value.version) && value.channel === 'partner-gateway' && value.core === 'service-binding', 'gateway_contract_mismatch');
    return { version: value.version, channel: value.channel, core: value.core, version_pinned: false };
  }
  if (id === 'original_proof_metadata') {
    requireCondition(Object.keys(value).every(k => proofFields.has(k)), 'unexpected_proof_fields');
    requireCondition(value.proof_id === PROOF_ID && value.schema === 'delta-proof-bundle/v0.2', 'original_proof_identity_mismatch');
    requireCondition(value.integrity === 'legacy_unverifiable', 'original_proof_integrity_status_mismatch');
    requireCondition(isoTime(value.capture_completed_at) && record(value.hashes), 'invalid_proof_metadata');
    for (const [name, hash] of Object.entries(ORIGINAL_PROOF_HASHES)) requireCondition(value.hashes[name] === hash, 'original_proof_hash_mismatch');
    const robots = (headers.get('x-robots-tag') ?? '').toLowerCase().split(',').map(s => s.trim());
    requireCondition(['noindex', 'nofollow', 'noarchive'].every(x => robots.includes(x)), 'proof_indexing_policy_mismatch');
    return { proof_id: value.proof_id, schema: value.schema, public_verifier_status: value.integrity,
      cryptographic_bundle_integrity: 'UNKNOWN', original_artifact_hashes_match: true,
      capture_completed_at: value.capture_completed_at, raw_artifacts_requested: false };
  }
  requireCondition(value.openapi === '3.1.0' && value.info?.version === expectedCoreVersion, 'openapi_version_mismatch');
  requireCondition(Array.isArray(value.servers) && value.servers.length === 1 && value.servers[0]?.url === CORE_ORIGIN, 'openapi_origin_mismatch');
  requireCondition(record(value.paths) && record(value.paths['/health']?.get) && record(value.paths['/v1/proofs/{proof_id}']?.get), 'openapi_public_routes_missing');
  const products = { capture: '1', preflight: '5', 'guarded-action-pilot': '10' };
  for (const [product, amount] of Object.entries(products)) {
    const path = value.paths[`/v1/${product}`], payment = path?.post?.['x-payment-info'];
    requireCondition(record(path?.post) && !Object.hasOwn(path, 'get'), 'openapi_paid_method_mismatch');
    requireCondition(payment?.network === NETWORK && payment.price?.mode === 'fixed'
      && payment.price?.currency === 'USD' && payment.price?.amount === amount
      && Array.isArray(payment.protocols) && payment.protocols.some(p => record(p?.x402)), 'openapi_payment_metadata_mismatch');
  }
  return { version: value.info.version, origin: CORE_ORIGIN, paid_methods: 'POST', network: NETWORK, formal_prices_usdc: products };
}

async function probe(target, { fetchImpl, expectedCoreVersion, now, timeoutMs }) {
  const started = now(), controller = new AbortController();
  const evidence = { id: target.id, url: target.url, method: 'GET', requested_at: new Date(started).toISOString(), http_status: null };
  let reader, response, timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new ReadbackError('deadline_exceeded', 'UNKNOWN'));
  }, timeoutMs); });
  try {
    const work = (async () => {
      response = await fetchImpl(target.url, { method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: { accept: 'application/json', 'cache-control': 'no-cache', 'x-delta-channel': 'internal-ci', 'user-agent': 'DELTA-Public-Release-Readback/1.0' } });
      evidence.http_status = response.status;
      if (response.status !== 200) throw new ReadbackError(`http_${response.status}`, response.status === 429 || response.status >= 500 ? 'UNKNOWN' : 'FAIL');
      requireCondition(!response.redirected, 'unexpected_redirect');
      requireCondition(/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''), 'unexpected_content_type');
      const length = response.headers.get('content-length');
      requireCondition(length === null || /^\d+$/.test(length), 'invalid_content_length');
      requireCondition(length === null || Number(length) <= MAX_RESPONSE_BYTES, 'response_too_large');
      requireCondition(response.body !== null, 'missing_response_body');
      reader = response.body.getReader();
      const chunks = []; let bytes = 0;
      while (true) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        requireCondition(bytes <= MAX_RESPONSE_BYTES, 'response_too_large');
        chunks.push(next.value);
      }
      const buffer = Buffer.concat(chunks); evidence.body_bytes = bytes;
      evidence.body_sha256 = createHash('sha256').update(buffer).digest('hex');
      let value;
      try { value = JSON.parse(buffer.toString('utf8')); } catch { throw new ReadbackError('invalid_json'); }
      return validate(target.id, value, response.headers, expectedCoreVersion, now);
    })();
    const details = await Promise.race([work, deadline]);
    return { ...evidence, observed_at: new Date(now()).toISOString(), duration_ms: Math.max(0, now() - started), status: 'PASS', details };
  } catch (error) {
    // Never copy provider response bodies, URLs from errors, cookies or credential text.
    return { ...evidence, observed_at: new Date(now()).toISOString(), duration_ms: Math.max(0, now() - started),
      status: error instanceof ReadbackError ? error.status : 'UNKNOWN',
      reason: error instanceof ReadbackError ? error.code : controller.signal.aborted ? 'deadline_exceeded' : 'transport_unavailable' };
  } finally {
    clearTimeout(timer); controller.abort();
    if (reader) void reader.cancel().catch(() => {});
    else if (response?.body) void response.body.cancel().catch(() => {});
  }
}

export async function runPublicReleaseReadback({ expectedCoreVersion, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15000 } = {}) {
  requireCondition(version(expectedCoreVersion), 'invalid_expected_core_version');
  requireCondition(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 15000, 'invalid_timeout');
  const checks = await Promise.all(TARGETS.map(target => probe(target, { fetchImpl, expectedCoreVersion, now, timeoutMs })));
  return { schema: 'delta-public-release-readback/v1', checked_at: new Date(now()).toISOString(), expected_core_version: expectedCoreVersion,
    ok: checks.every(x => x.status === 'PASS'), checks, max_response_bytes: MAX_RESPONSE_BYTES, request_deadline_ms: timeoutMs,
    raw_artifacts_requested: false, payment_authorization_sent: false, credentials_used: false,
    request_telemetry: 'Public proof GET can record an internal-ci proof_opened event; no customer/order/proof mutation is requested.',
    treasury_check: 'Treasury is not exposed by these GET contracts. The separate public-pricing.json 402 report verifies Treasury and canonical USDC.',
    acceptance_scope: 'Public endpoint availability, candidate Core version, declared methods/prices and original public metadata continuity only.',
    not_validated: ['legacy cryptographic bundle integrity', 'raw artifact integrity', 'new paid fulfillment', 'settlement', 'customer revenue', 'provider notification delivery', '48-hour unattended operations'] };
}

async function main() {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const report = await runPublicReleaseReadback({ expectedCoreVersion: config.vars?.APP_VERSION });
  const output = process.env.PUBLIC_READBACK_OUTPUT;
  if (output) { await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error(JSON.stringify({ schema: 'delta-public-release-readback/v1', ok: false, status: 'UNKNOWN', reason: 'local_readback_preparation_failed' })); process.exitCode = 1; });
}
