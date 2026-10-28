import test from "node:test";
import assert from "node:assert/strict";
import { DeltaWitness } from "../src/index.js";

test('an unsigned challenge rejection does not expose the upstream body', async () => {
  const client = new DeltaWitness({fetchImpl: async () => new Response('Bearer fixture-secret', {status: 503})});
  await assert.rejects(client.paymentChallenge('https://example.com'), error => !error.message.includes('fixture-secret'));
});

test("preflight challenge targets Guard with attribution", async () => {
  let request;
  const client = new DeltaWitness({ fetchImpl: async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ error: "payment_required" }), { status: 402, headers: { "content-type": "application/json" } });
  } });
  const challenge = await client.preflightChallenge({ url: "https://example.com", expected: { contains: ["Example"] } });
  assert.equal(challenge.status, 402);
  assert.equal(request.url, "https://delta-witness-api.ruphussten.workers.dev/v1/preflight");
  assert.equal(request.init.headers["x-delta-channel"], "npm");
});

for (const [status, body] of [[202, { ok: false, state: 'processing' }], [200, { ok: false }], [200, { ok: true }], [503, { error: 'Bearer fixture-secret' }]]) {
  test(`paid HTTP ${status} with incomplete delivery stays unresolved without exposing provider text`, async () => {
    let calls = 0;
    const client = new DeltaWitness();
    await assert.rejects(client.captureWithPaidFetch('https://example.com', async () => {
      calls++;
      return Response.json(body, { status });
    }), (error) => {
      assert.equal(error.code, 'payment_outcome_unconfirmed');
      assert.equal(error.status, status);
      assert.equal(error.retryable, false);
      assert.ok(!error.message.includes('fixture-secret'));
      return true;
    });
    assert.equal(calls, 1);
  });
}

test('paid transport exceptions stay unresolved without leaking details or retrying', async () => {
  let calls = 0;
  await assert.rejects(new DeltaWitness().captureWithPaidFetch('https://example.com', async () => {
    calls++;
    throw new Error('Bearer fixture-secret');
  }), error => {
    assert.equal(error.code, 'payment_outcome_unconfirmed');
    assert.equal(error.retryable, false);
    assert.ok(!error.message.includes('fixture-secret'));
    return true;
  });
  assert.equal(calls, 1);
});

test('paid completed proof is returned unchanged', async () => {
  const proofId = '56347db8-1aa5-447f-a0e4-3bb052d7aa89';
  const body = { ok: true, product: 'capture', proof_id: proofId,
    public_proof_url: `https://delta-witness-api.ruphussten.workers.dev/p/${proofId}`,
    manifest_url: `https://delta-witness-api.ruphussten.workers.dev/v1/proofs/${proofId}`,
    bundle_root: 'sha256:' + 'a'.repeat(64), observed_at: '2026-10-03T12:00:00Z' };
  const result = await new DeltaWitness().captureWithPaidFetch('https://example.com', async () => Response.json(body));
  assert.deepEqual(result, body);
});

test('a stalled paid adapter has a finite deadline without a second submission', async () => {
  let calls = 0;
  const operation = new DeltaWitness({ requestTimeoutMs: 10 }).captureWithPaidFetch('https://example.com', async () => {
    calls++;
    return new Promise(() => {});
  }).catch(error => error);
  let timer;
  const result = await Promise.race([operation, new Promise(resolve => { timer = setTimeout(() => resolve({ code: 'test_deadline_exceeded' }), 100); })]);
  clearTimeout(timer);
  assert.equal(result.code, 'payment_outcome_unconfirmed');
  assert.equal(result.retryable, false);
  assert.equal(calls, 1);
});

test('a stalled paid response body also has a finite deadline', async () => {
  let timer;
  let cancelled = 0;
  const operation = new DeltaWitness({ requestTimeoutMs: 10 }).captureWithPaidFetch('https://example.com', async () => new Response(new ReadableStream({ start() {}, cancel() { cancelled++; } }))).catch(error => error);
  const result = await Promise.race([operation, new Promise(resolve => { timer = setTimeout(() => resolve({ code: 'test_deadline_exceeded' }), 100); })]);
  clearTimeout(timer);
  assert.equal(result.code, 'payment_outcome_unconfirmed');
  assert.equal(result.status, 200);
  assert.equal(cancelled, 1);
});

test('an oversized paid response is cancelled and never resubmitted', async () => {
  let calls = 0, cancelled = 0;
  await assert.rejects(new DeltaWitness().captureWithPaidFetch('https://example.com', async () => {
    calls++;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1_048_577)); }, cancel() { cancelled++; },
    }));
  }), error => error.code === 'payment_outcome_unconfirmed' && error.status === 200 && !error.retryable);
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
});

test('a paid response arriving after the deadline is cancelled', async () => {
  let resolve, cancelled = 0, calls = 0;
  await assert.rejects(new DeltaWitness({requestTimeoutMs: 10}).captureWithPaidFetch('https://example.com', () => {
    calls++;
    return new Promise(done => { resolve = done; });
  }), error => error.code === 'payment_outcome_unconfirmed');
  resolve(new Response(new ReadableStream({start() {}, cancel() { cancelled++; }})));
  await new Promise(done => setImmediate(done));
  assert.equal(cancelled, 1);
  assert.equal(calls, 1);
});

test('free quote bodies share cancellation and size limits', async () => {
  let cancelled = 0;
  const quote = new DeltaWitness({fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1_048_577)); }, cancel() { cancelled++; },
  }))});
  await assert.rejects(quote.quote(), /response_too_large/);
  const stalled = new DeltaWitness({requestTimeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({
    start() {}, cancel() { cancelled++; },
  }))});
  await assert.rejects(stalled.quote(), /request_deadline_exceeded/);
  assert.equal(cancelled, 2);
});

test('the default paid deadline accepts a legitimate 35-second delivery', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const id = '56347db8-1aa5-447f-a0e4-3bb052d7aa89';
  const body = {ok: true, product: 'capture', proof_id: id, manifest_url: `https://delta-witness-api.ruphussten.workers.dev/v1/proofs/${id}`, public_proof_url: `https://delta-witness-api.ruphussten.workers.dev/p/${id}`, bundle_root: 'sha256:' + 'a'.repeat(64), observed_at: '2026-10-04T00:00:00Z'};
  const operation = new DeltaWitness().captureWithPaidFetch('https://example.com', () => new Promise(resolve => setTimeout(() => resolve(Response.json(body)), 35000)));
  context.mock.timers.tick(35000);
  assert.deepEqual(await operation, body);
});
