import test from 'node:test';
import assert from 'node:assert/strict';
import { DeltaWitness } from '../src/index.js';

const origin = 'https://delta.test';
const id = '11111111-1111-4111-8111-111111111111';
const proofId = '56347db8-1aa5-447f-a0e4-3bb052d7aa89';
const input = {url: 'https://example.com/'};
const proof = (product = 'capture') => ({ok: true, product, proof_id: proofId,
  manifest_url: `${origin}/v1/proofs/${proofId}`, public_proof_url: `${origin}/p/${proofId}`,
  bundle_root: `sha256:${'a'.repeat(64)}`, observed_at: '2026-10-29T00:00:00Z',
  ...(product === 'preflight' ? {safe: false, changed: true, reason: 'expectations_not_met'} : {})});
function envelope(product = 'capture', complete = true) {
  return {ok: true, order_id: id, product, state: complete ? 'complete' : 'recovery_available',
    payment: {state: 'settlement_confirmed', treasury_received: null},
    fulfillment: {state: complete ? 'complete' : 'recovery_available'},
    recovery: {expires_at: '2026-10-30T00:00:00Z', can_recover: !complete},
    ...(complete ? {delivery: proof(product)} : {reconciliation_required: true})};
}
function store() {
  const values = new Map();
  return {values,
    async load(key) { return values.has(key) ? structuredClone(values.get(key)) : null; },
    async compareAndSet(key, revision, next) {
      if ((values.get(key)?.revision ?? null) !== revision) return false;
      values.set(key, structuredClone(next));
      return true;
    },
  };
}
function client(orderStore, fetchImpl = async () => Response.json(envelope())) {
  return new DeltaWitness({baseUrl: origin, orderStore, fetchImpl, requestTimeoutMs: 1000});
}
async function prepared(orderStore = store(), product = 'capture', fetchImpl) {
  const delta = client(orderStore, fetchImpl);
  await delta.prepareOrder(product, input, {orderId: id});
  return {delta, orderStore};
}

test('durably prepares before the one automatic preauthorized paid call and returns no capability', async () => {
  const {delta, orderStore} = await prepared();
  const saved = await orderStore.load(id);
  assert.equal(saved.phase, 'prepared');
  assert.match(saved.recovery_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(saved.recovery_token, 'base64url').byteLength, 32);
  let calls = 0;
  const result = await delta.executeOrder(id, async (url, init) => {
    calls++;
    assert.equal((await orderStore.load(id)).phase, 'signing_started');
    assert.equal(url, `${origin}/v1/capture`);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['x-delta-order-id'], id);
    assert.equal(init.headers['x-delta-recovery-token'], saved.recovery_token);
    assert.deepEqual(JSON.parse(init.body), input);
    return Response.json({...proof(), recovery_token: saved.recovery_token});
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, {order_id: id, product: 'capture', state: 'complete', delivery: proof()});
  assert.ok(!JSON.stringify(result).includes(saved.recovery_token));
});

test('two clients sharing CAS create one capability and allow only one paid invocation', async () => {
  const state = store();
  const a = client(state), b = client(state);
  const preparedResults = await Promise.all([a.prepareOrder('capture', input, {orderId: id}), b.prepareOrder('capture', input, {orderId: id})]);
  assert.deepEqual(preparedResults[0], preparedResults[1]);
  let calls = 0;
  const pay = async () => { calls++; return Response.json(proof()); };
  const results = await Promise.all([a.executeOrder(id, pay), b.executeOrder(id, pay)]);
  assert.equal(calls, 1);
  assert.ok(results.every(result => result.state === 'complete'));
});

test('a restarted client always verifies completed orders with Core without calling its signer', async () => {
  const {delta, orderStore} = await prepared();
  await delta.executeOrder(id, async () => Response.json(proof()));
  let reads = 0;
  const reloaded = client(orderStore, async (url, init) => {
    reads++;
    assert.equal(url, `${origin}/v1/orders/${id}`);
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).has('payment-signature'), false);
    return Response.json(envelope());
  });
  const result = await reloaded.executeOrder(id, () => { throw new Error('signer_must_not_be_called'); });
  assert.equal(result.state, 'complete');
  assert.equal(reads, 1);
});

test('CAS persistence failure prevents the signer and is redacted even after the store committed', async () => {
  const {delta, orderStore} = await prepared();
  const original = orderStore.compareAndSet;
  orderStore.compareAndSet = async (...args) => { await original(...args); throw new Error('private-store-detail'); };
  let calls = 0;
  await assert.rejects(delta.executeOrder(id, () => { calls++; }), error => error.code === 'order_store_unavailable' && !error.message.includes('private-store-detail'));
  assert.equal(calls, 0);
  orderStore.compareAndSet = original;
  await client(orderStore).executeOrder(id, () => { calls++; });
  assert.equal(calls, 0);
});

test('failed initial storage, missing records, and corrupt records never invoke payment', async () => {
  const state = store();
  state.compareAndSet = async () => { throw new Error('private-token-detail'); };
  await assert.rejects(client(state).prepareOrder('capture', input, {orderId: id}), error => error.code === 'order_store_unavailable' && !error.message.includes('private-token-detail'));
  let calls = 0;
  const pay = () => { calls++; };
  await assert.rejects(client(state).executeOrder(id, pay), error => error.code === 'order_not_prepared');
  state.values.set(id, {schema: 'unexpected'});
  await assert.rejects(client(state).executeOrder(id, pay), error => error.code === 'order_store_invalid');
  assert.equal(calls, 0);
});

test('the same ID cannot change request, product, or original Core origin', async () => {
  const {delta, orderStore} = await prepared();
  const original = await orderStore.load(id);
  await assert.rejects(delta.prepareOrder('capture', {url: 'https://example.com/changed'}, {orderId: id}), error => error.code === 'order_identity_conflict');
  await assert.rejects(delta.prepareOrder('preflight', input, {orderId: id}), error => error.code === 'order_identity_conflict');
  const other = new DeltaWitness({baseUrl: 'https://other.test', orderStore, fetchImpl: () => { throw new Error('must_not_contact_other_origin'); }});
  await assert.rejects(other.recoverOrder(id), error => error.code === 'order_identity_conflict');
  assert.deepEqual(await orderStore.load(id), original);
});

test('interrupted negative Preflight recovers with one ordinary GET and POST and no payment', async () => {
  const {delta, orderStore} = await prepared(store(), 'preflight');
  let paidCalls = 0;
  await assert.rejects(delta.executeOrder(id, async () => { paidCalls++; throw new Error('lost_after_settlement'); }), error => error.code === 'payment_outcome_unconfirmed');
  const requests = [];
  const reloaded = client(orderStore, async (url, init) => {
    requests.push({url, init});
    return Response.json(envelope('preflight', init.method === 'POST'), {status: init.method === 'POST' ? 200 : 202});
  });
  const result = await reloaded.executeOrder(id, () => { paidCalls++; });
  assert.equal(result.delivery.safe, false);
  assert.equal(result.delivery.changed, true);
  assert.equal(paidCalls, 1);
  assert.deepEqual(requests.map(({init}) => init.method), ['GET', 'POST']);
  assert.equal(requests[1].url, `${origin}/v1/orders/${id}/recover`);
  for (const {init} of requests) {
    assert.equal(init.body, undefined);
    assert.equal(new Headers(init.headers).has('payment-signature'), false);
    assert.equal(new Headers(init.headers).has('x-payment'), false);
  }
});

for (const status of [404, 410, 503]) test(`recovery HTTP ${status} retains the original order and never authorizes another payment`, async () => {
  const {delta, orderStore} = await prepared();
  let calls = 0;
  await assert.rejects(delta.executeOrder(id, async () => { calls++; throw new Error('uncertain'); }));
  const saved = await orderStore.load(id);
  const reloaded = client(orderStore, async () => Response.json({ok: false, state: 'order_unknown', error: 'order_unavailable'}, {status}));
  for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(reloaded.executeOrder(id, () => { calls++; }), error => error.code === 'order_recovery_unconfirmed' && error.status === status && error.order_id === id && !error.message.includes(saved.recovery_token));
  }
  assert.equal(calls, 1);
  assert.deepEqual(await orderStore.load(id), saved);
});

test('a recovery attempt on a prepared order cannot use 404 as subsequent payment permission', async () => {
  const {delta, orderStore} = await prepared(store(), 'capture', async () => Response.json({ok: false}, {status: 404}));
  await assert.rejects(delta.recoverOrder(id));
  let paidCalls = 0;
  await assert.rejects(client(orderStore, async () => Response.json({ok: false}, {status: 404})).executeOrder(id, () => { paidCalls++; }));
  assert.equal(paidCalls, 0);
});

test('corrupt remote evidence is rechecked after an initially completed delivery', async () => {
  const {delta, orderStore} = await prepared();
  await delta.executeOrder(id, async () => Response.json(proof()));
  const reloaded = client(orderStore, async () => Response.json({ok: false, error: 'order_evidence_inconsistent'}, {status: 503}));
  await assert.rejects(reloaded.executeOrder(id, () => { throw new Error('must_not_sign'); }), error => error.code === 'order_recovery_unconfirmed' && error.status === 503);
  assert.equal((await orderStore.load(id)).phase, 'complete');
});

for (const changed of ['order', 'product', 'proof', 'payment', 'fulfillment', 'token']) test(`rejects mismatched recovered ${changed} without a fresh payment`, async () => {
  const {orderStore} = await prepared();
  const body = envelope();
  if (changed === 'order') body.order_id = '22222222-2222-4222-8222-222222222222';
  if (changed === 'product') body.product = 'preflight';
  if (changed === 'proof') body.delivery.manifest_url = 'https://other.test/proof';
  if (changed === 'payment') body.payment.state = 'settlement_unknown';
  if (changed === 'fulfillment') body.fulfillment.state = 'processing';
  if (changed === 'token') body.delivery.reason = (await orderStore.load(id)).recovery_token;
  await assert.rejects(client(orderStore, async () => Response.json(body)).recoverOrder(id), error => error.code === 'order_recovery_unconfirmed');
});

test('capability requests disable redirects and redirect errors cannot trigger paid retries', async () => {
  const {delta, orderStore} = await prepared();
  let calls = 0;
  await assert.rejects(delta.executeOrder(id, async (_url, init) => {
    calls++; assert.equal(init.redirect, 'error'); throw new Error('redirect_not_allowed');
  }));
  await assert.rejects(client(orderStore, async (_url, init) => {
    assert.equal(init.redirect, 'error'); throw new Error('redirect_not_allowed');
  }).executeOrder(id, () => { calls++; }));
  assert.equal(calls, 1);
});

test('an intentional new order receives a different identity and private capability', async () => {
  const state = store(), delta = client(state);
  const a = await delta.prepareOrder('capture', input);
  const b = await delta.prepareOrder('capture', input);
  assert.notEqual(a.order_id, b.order_id);
  assert.notEqual((await state.load(a.order_id)).recovery_token, (await state.load(b.order_id)).recovery_token);
  assert.ok(Object.keys(a).every(key => ['order_id', 'product', 'state'].includes(key)));
});
