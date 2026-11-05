import { describe, expect, it, vi } from 'vitest';
import { CORE_ORIGIN, MAX_RESPONSE_BYTES, NETWORK, ORIGINAL_PROOF_HASHES, PROOF_ID,
  TARGETS, runPublicReleaseReadback } from '../scripts/verify-public-release-readback.mjs';

const now = () => Date.parse('2026-11-04T17:30:00.000Z');
function fixtures(): Record<string, any> {
  const paths: Record<string, any> = { '/health': { get: {} }, '/v1/proofs/{proof_id}': { get: {} } };
  for (const [product, price] of [['capture', '1'], ['preflight', '5'], ['guarded-action-pilot', '10']]) {
    paths[`/v1/${product}`] = { post: { 'x-payment-info': { network: NETWORK,
      price: { mode: 'fixed', currency: 'USD', amount: price }, protocols: [{ x402: {} }] } } };
  }
  return {
    core_health: { ok: true, version: '0.7.1', network: NETWORK, ts: new Date(now()).toISOString() },
    gateway_health: { ok: true, version: '0.6.1', channel: 'partner-gateway', core: 'service-binding' },
    original_proof_metadata: { schema: 'delta-proof-bundle/v0.2', proof_id: PROOF_ID,
      capture_completed_at: '2026-08-31T00:00:00.000Z', hashes: { ...ORIGINAL_PROOF_HASHES },
      integrity: 'legacy_unverifiable', requested_url: 'https://example.com/private-looking-but-public-metadata' },
    openapi: { openapi: '3.1.0', info: { version: '0.7.1' }, servers: [{ url: CORE_ORIGIN }], paths },
  };
}
function fetcher(data = fixtures(), replace?: (id: string) => Response | undefined) {
  return vi.fn(async (url: string) => {
    const target = TARGETS.find((x: { url: string }) => x.url === url);
    if (!target) throw Error('unexpected request');
    return replace?.(target.id) ?? Response.json(data[target.id], { headers: { 'x-robots-tag': 'noindex, nofollow, noarchive' } });
  });
}
const run = (fetchImpl: any, extra: Record<string, unknown> = {}) => runPublicReleaseReadback({ expectedCoreVersion: '0.7.1', fetchImpl, now, ...extra });

describe('independent public release readback with isolated transports', () => {
  it('uses exactly four fixed credential-free GETs and keeps legacy proof integrity UNKNOWN', async () => {
    const fetch = fetcher(); const report = await run(fetch);
    expect(report.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(4);
    for (const [url, init] of fetch.mock.calls as any) {
      expect(TARGETS.some((x: { url: string }) => x.url === url)).toBe(true);
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' });
      expect(Object.keys(init.headers)).toEqual(['accept', 'cache-control', 'x-delta-channel', 'user-agent']);
      expect(init.headers['x-delta-channel']).toBe('internal-ci');
      expect(init.body).toBeUndefined();
    }
    expect(report.checks.find(x => x.id === 'original_proof_metadata')?.details).toMatchObject({
      original_artifact_hashes_match: true, public_verifier_status: 'legacy_unverifiable',
      cryptographic_bundle_integrity: 'UNKNOWN', raw_artifacts_requested: false,
    });
    expect(report.checks.find(x => x.id === 'gateway_health')?.details).toMatchObject({ version: '0.6.1', version_pinned: false });
    expect(JSON.stringify(report)).not.toContain('private-looking-but-public-metadata');
    expect(report).toMatchObject({ credentials_used: false, payment_authorization_sent: false, raw_artifacts_requested: false });
  });

  it.each(['version', 'network'])('fails the actual Core %s mismatch while retaining other endpoint evidence', async field => {
    const data = fixtures(); data.core_health[field] = 'wrong'; const report = await run(fetcher(data));
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ status: 'FAIL', reason: 'core_identity_mismatch' });
    expect(report.checks.slice(1).every((x: any) => x.status === 'PASS')).toBe(true);
  });

  it('reports stale health as UNKNOWN, not healthy zero or an accepted new deployment', async () => {
    const data = fixtures(); data.core_health.ts = '2026-11-04T16:00:00Z';
    const report = await run(fetcher(data));
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ status: 'UNKNOWN', reason: 'stale_core_clock' });
  });

  it.each(['hash', 'raw', 'integrity', 'identity', 'robots'])('rejects original proof %s drift without saving its body', async fault => {
    const data = fixtures();
    if (fault === 'hash') data.original_proof_metadata.hashes.html = `sha256:${'f'.repeat(64)}`;
    if (fault === 'raw') data.original_proof_metadata.html = 'PRIVATE-RAW-ARTIFACT-MUST-NOT-BE-LOGGED';
    if (fault === 'integrity') data.original_proof_metadata.integrity = 'verified';
    if (fault === 'identity') data.original_proof_metadata.proof_id = 'another';
    const report = await run(fetcher(data, id => fault === 'robots' && id === 'original_proof_metadata'
      ? Response.json(data[id]) : undefined));
    expect(report.ok).toBe(false);
    expect(report.checks[2].status).toBe('FAIL');
    expect(JSON.stringify(report)).not.toContain('PRIVATE-RAW');
  });

  it.each([429, 503])('isolates HTTP %i as UNKNOWN without copying provider error text', async status => {
    const report = await run(fetcher(fixtures(), id => id === 'core_health'
      ? new Response('provider-private-error-detail', { status }) : undefined));
    expect(report.checks[0]).toMatchObject({ status: 'UNKNOWN', reason: `http_${status}` });
    expect(report.checks.slice(1).every((x: any) => x.status === 'PASS')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('provider-private-error-detail');
  });

  it('retains a missing public proof as an explicit failure rather than success', async () => {
    const report = await run(fetcher(fixtures(), id => id === 'original_proof_metadata' ? new Response('', { status: 404 }) : undefined));
    expect(report.checks[2]).toMatchObject({ status: 'FAIL', reason: 'http_404' });
  });

  it('redacts transport error details and never follows a failed redirect with another request', async () => {
    const fetch = vi.fn(async () => { throw Error('credential=private-network-error'); });
    const report = await run(fetch);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(report.checks.every((x: any) => x.status === 'UNKNOWN' && x.reason === 'transport_unavailable')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('credential=');
  });

  it.each(['json', 'content_type', 'redirect'])('rejects malformed or redirected %s responses', async fault => {
    const report = await run(fetcher(fixtures(), id => {
      if (id !== 'core_health') return;
      const r = new Response(fault === 'json' ? '{bad json' : '{}', { headers: { 'content-type': fault === 'content_type' ? 'text/html' : 'application/json' } });
      if (fault === 'redirect') Object.defineProperty(r, 'redirected', { value: true });
      return r;
    }));
    expect(report.checks[0].status).toBe('FAIL');
  });

  it('rejects declared oversized responses before consuming body bytes', async () => {
    let reads = 0, cancelled = false;
    const report = await run(fetcher(fixtures(), id => id === 'core_health' ? new Response(new ReadableStream({
      pull() { reads++; }, cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json', 'content-length': String(MAX_RESPONSE_BYTES + 1) } }) : undefined));
    expect(report.checks[0]).toMatchObject({ status: 'FAIL', reason: 'response_too_large' });
    expect(reads).toBe(0); expect(cancelled).toBe(true);
  });

  it('caps chunked responses even when content-length understates the body and cancels the stream', async () => {
    let reads = 0, cancelled = false;
    const report = await run(fetcher(fixtures(), id => id === 'core_health' ? new Response(new ReadableStream({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES / 2)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json', 'content-length': '1' } }) : undefined));
    expect(report.checks[0]).toMatchObject({ status: 'FAIL', reason: 'response_too_large' });
    expect(reads).toBe(3); expect(cancelled).toBe(true);
  });

  it('bounds stalled body reads and preserves successful sibling responses', async () => {
    let cancelled = false;
    const report = await run(fetcher(fixtures(), id => id === 'core_health' ? new Response(new ReadableStream({
      pull() {}, cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/json' } }) : undefined), { timeoutMs: 20 });
    expect(report.checks[0]).toMatchObject({ status: 'UNKNOWN', reason: 'deadline_exceeded' });
    expect(cancelled).toBe(true);
    expect(report.checks.slice(1).every((x: any) => x.status === 'PASS')).toBe(true);
  });

  it('bounds a transport which never resolves or honors abort', async () => {
    const report = await run(vi.fn(() => new Promise(() => {})), { timeoutMs: 20 });
    expect(report.ok).toBe(false);
    expect(report.checks.every((x: any) => x.reason === 'deadline_exceeded')).toBe(true);
  });

  it.each(['method', 'network', 'price'])('fails OpenAPI %s drift without making paid requests', async fault => {
    const data = fixtures(), path = data.openapi.paths['/v1/capture'];
    if (fault === 'method') path.get = {};
    if (fault === 'network') path.post['x-payment-info'].network = 'eip155:84532';
    if (fault === 'price') path.post['x-payment-info'].price.amount = '0.01';
    const report = await run(fetcher(data));
    expect(report.checks[3].status).toBe('FAIL');
  });
});
