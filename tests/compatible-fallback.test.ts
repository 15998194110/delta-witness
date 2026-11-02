import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { app } from '../src/index';
import { sha256, stableJson } from '../src/crypto';
import { bundleRootMaterial } from '../src/capture';
import { deliveryDigest } from '../src/fulfillment';
import { MemoryBucket, orderRuntime, orderRequest, statusRequest, mockOrderNetwork, TEST_ORDER_ID, TEST_RECOVERY_TOKEN } from './helpers/order-runtime';

// Opt-in exact prior source build, never an arbitrary unverified module path.
const evidencePath = process.env.DELTA_FALLBACK_BUILD_EVIDENCE;
const reviewedCommit = process.env.DELTA_FALLBACK_REVIEWED_COMMIT ?? 'd85b36705c413f2e3c2579dc0bc6f9210d064875';
let fallback: typeof app;
if (evidencePath) {
  const evidence = JSON.parse(await readFile(evidencePath,'utf8'));
  // This binds the local test to the audited generator record, not to an
  // independently signed provenance claim. The caller reviews the exact commit.
  if (!/^[a-f0-9]{40}$/.test(reviewedCommit) || evidence.commit !== reviewedCommit ||
      evidence.schema !== 'delta-isolated-fallback-build/v1' || evidence.platform !== 'node' ||
      !Array.isArray(evidence.source_files) || evidence.source_files.length < 1 || evidence.source_files.length > 500 ||
      !evidence.source_files.some((file: {path?: string}) => file.path === 'src/index.ts') ||
      createHash('sha256').update(await readFile(evidence.artifact)).digest('hex') !== evidence.artifact_sha256) throw new Error('unverified_fallback_artifact');
  fallback = (await import(/* @vite-ignore */ pathToFileURL(evidence.artifact).href)).app;
}
const suite = evidencePath ? describe : describe.skip;
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function artifacts(bucket: MemoryBucket) {
  return [...bucket.values.entries()].filter(([key]) => /^[0-9a-f-]{36}\//.test(key)).map(([key, value]) =>
    [key,createHash('sha256').update(value.bytes ?? Buffer.from(value.text)).digest('hex')]);
}

suite('exact reviewed Core fallback, isolated shared original storage', () => {
  it.each(['capture', 'preflight'])('fallback preserves original %s access and rejects the unsupported child credential without changing the authorization', async product => {
    const bucket = new MemoryBucket(), env = orderRuntime(bucket), network = mockOrderNetwork(); vi.stubGlobal('fetch', network);
    const body = product === 'preflight' ? { url: 'https://example.com/', expected: { contains: ['missing fixture'] } } : undefined;
    expect((await app.fetch(orderRequest({ product, body }), env)).status).toBe(200);
    const child = Buffer.alloc(32, 63).toString('base64url');
    const created = await app.fetch(new Request(`https://delta.test/v1/orders/${TEST_ORDER_ID}/export-authorization`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-delta-recovery-token': TEST_RECOVERY_TOKEN },
      body: JSON.stringify({ operation_id: '33333333-3333-4333-8333-333333333333', token: child, ttl_seconds: 60, expected_generation: 0 }),
    }), env);
    expect(created.status).toBe(201);
    const originals = structuredClone([...bucket.values]);
    network.mockClear(); vi.mocked(env.BROWSER.quickAction).mockClear();
    const download = (token: string) => new Request(`https://delta.test/v1/orders/${TEST_ORDER_ID}/artifacts/html`, { headers: { 'x-delta-recovery-token': token } });
    expect((await fallback.fetch(statusRequest(), env)).status).toBe(200);
    expect((await fallback.fetch(statusRequest({ token: child }), env)).status).toBe(404);
    const prior = await fallback.fetch(download(TEST_RECOVERY_TOKEN), env);
    expect(prior.status).toBe(200);
    expect((await fallback.fetch(download(child), env)).status).toBe(404);
    const resumed = await app.fetch(download(child), env);
    expect(resumed.status).toBe(200);
    expect(new Uint8Array(await resumed.arrayBuffer())).toEqual(new Uint8Array(await prior.arrayBuffer()));
    expect([...bucket.values]).toEqual(originals);
    expect(network).not.toHaveBeenCalled(); expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it.each(['capture','preflight'].flatMap(product=>['html','markdown'].map(blank=>({product,blank}))))
  ('fallback rejects a new blank $blank $product snapshot; current preserves the blocked original without recapture',async({product,blank})=>{
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),network=mockOrderNetwork();vi.stubGlobal('fetch',network);
    const browser=vi.mocked(env.BROWSER.quickAction).getMockImplementation()!;
    vi.mocked(env.BROWSER.quickAction).mockImplementationOnce(async(...args)=>{
      const response=await browser(...args),snapshot=await response.json() as any;snapshot.result[blank==='html'?'content':'markdown']=' \n\t';
      return Response.json(snapshot,{headers:response.headers});
    });
    const failed=await fallback.fetch(orderRequest({product}),env);expect(failed.status).toBe(502);expect(await failed.json()).toMatchObject({reason:'capture_incomplete'});
    expect([...bucket.values.keys()].some(key=>key.endsWith('/manifest.json'))).toBe(false);
    expect([...bucket.values].filter(([key])=>key.startsWith('fulfillments/')).some(([,value])=>JSON.parse(value.text).state==='complete')).toBe(false);
    const originals=[...bucket.values];
    expect((await app.fetch(orderRequest({product}),env)).status).toBe(503);
    expect([...bucket.values]).toEqual(originals);
    expect(network.mock.calls.filter(([url])=>String(url).endsWith('/settle'))).toHaveLength(1);expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });
  it('fallback and current preserve the original zero-byte historical markdown export without rewriting it',async()=>{
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),network=mockOrderNetwork();vi.stubGlobal('fetch',network);
    expect((await app.fetch(orderRequest(),env)).status).toBe(200);
    // Assemble a self-consistent synthetic historical fixture before the
    // compatibility boundary. No real or previously recorded evidence is used.
    const manifestKey=[...bucket.values.keys()].find(key=>key.endsWith('/manifest.json'))!;
    const manifest=JSON.parse(bucket.values.get(manifestKey)!.text),fulfillmentKey=[...bucket.values.keys()].find(key=>key.startsWith('fulfillments/'))!;
    const fulfillment=JSON.parse(bucket.values.get(fulfillmentKey)!.text);
    await bucket.put(manifest.storage.markdown,new Uint8Array(0));manifest.hashes.markdown=await sha256('');
    manifest.artifact_sizes.total_bytes-=manifest.artifact_sizes.markdown_bytes;manifest.artifact_sizes.markdown_bytes=0;
    const {bundle_root:_previousRoot,...artifactHashes}=manifest.hashes;
    manifest.hashes.bundle_root=await sha256(stableJson(bundleRootMaterial({...manifest,hashes:artifactHashes})));fulfillment.response.bundle_root=manifest.hashes.bundle_root;
    fulfillment.response_hash=await deliveryDigest(fulfillment,fulfillment.response);
    await bucket.put(manifestKey,JSON.stringify(manifest));await bucket.put(fulfillmentKey,JSON.stringify(fulfillment));
    const originals=[...bucket.values];network.mockClear();vi.mocked(env.BROWSER.quickAction).mockClear();
    for(const runtime of [fallback,app]) {
      const response=await runtime.fetch(new Request(`https://delta.test/v1/orders/${TEST_ORDER_ID}/artifacts/markdown`,{headers:{'x-delta-recovery-token':TEST_RECOVERY_TOKEN}}),env);
      expect(response.status).toBe(200);expect((await response.arrayBuffer()).byteLength).toBe(0);
      expect(response.headers.get('x-delta-content-sha256')).toBe(await sha256(''));
    }
    expect([...bucket.values]).toEqual(originals);expect(network).not.toHaveBeenCalled();expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it.each(['capture','preflight'].flatMap(product=>[false,true].map(headerless=>({product,headerless}))))
  ('preserves expired $product signed retries through fallback and resume (headerless=$headerless)',async({product,headerless})=>{
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),network=mockOrderNetwork();vi.stubGlobal('fetch',network);
    const policy={schema:'delta-retention-policy/v1',policy_id:'fallback-expired-original',classes:{
      raw_artifacts:{start_event:'settlement_confirmed',retain_seconds:60,deletion_window_seconds:60},
      minimal_metadata:{start_event:'settlement_confirmed',retain_seconds:120,deletion_window_seconds:60},
      transaction_audit:{start_event:'settlement_confirmed',retain_seconds:240,deletion_window_seconds:60}},
      export_rights:{raw_artifacts:'authenticated_until_raw_expiry',minimal_metadata:'authenticated_until_metadata_expiry'}};
    env.RETENTION_POLICY_JSON=JSON.stringify(policy);
    const request=async()=>{const req=orderRequest({product});req.headers.set('x-delta-retention-policy-hash',await sha256(stableJson(policy)));return req;};
    vi.mocked(env.BROWSER.quickAction).mockResolvedValueOnce(new Response('',{status:503}));
    expect((await app.fetch(await request(),env)).status).toBe(502);
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.now()+61_000);
    const originals=[...bucket.values];network.mockClear();vi.mocked(env.BROWSER.quickAction).mockClear();
    for(const runtime of [fallback,app]) {
      const replay=await request();
      if(headerless)for(const key of ['x-delta-order-id','x-delta-recovery-token','x-delta-retention-policy-hash'])replay.headers.delete(key);
      expect((await runtime.fetch(replay,env)).status).toBe(410);
      expect(await (await runtime.fetch(statusRequest(),env)).json()).toMatchObject({state:'raw_artifacts_expired'});
    }
    expect([...bucket.values]).toEqual(originals);expect(network).not.toHaveBeenCalled();expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it.each(['capture','preflight'].flatMap(product=>[false,true].map(draft=>({product,draft}))))
  ('disabled enrollment TTL cannot revoke an existing $product order across fallback (draft=$draft)',async({product,draft})=>{
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),network=mockOrderNetwork();vi.stubGlobal('fetch',network);
    const body=product==='preflight'?{url:'https://example.com/',expected:{contains:['missing fixture']}}:undefined;
    const put=bucket.put.bind(bucket);let failed=false;
    bucket.put=async(key,value,options)=>{
      if(draft&&!failed&&key.startsWith('fulfillments/')&&JSON.parse(String(value)).state==='complete'){failed=true;throw new Error('synthetic final CAS loss');}
      return put(key,value,options);
    };
    expect((await app.fetch(orderRequest({product,body}),env)).status).toBe(draft?503:200);
    const record=JSON.parse([...bucket.values].find(([key])=>key.startsWith('fulfillments/'))![1].text);
    const originalAuthority=[...bucket.values].filter(([key])=>key.startsWith('orders/')||key.startsWith('settlements/'));
    const hashes=artifacts(bucket);Object.assign(env,{ORDER_RECOVERY_TTL_SECONDS:undefined});network.mockClear();vi.mocked(env.BROWSER.quickAction).mockClear();
    for(const runtime of [fallback,app]) {
      const replay=await runtime.fetch(orderRequest({product,body}),env);
      expect(replay.status).toBe(200);expect(await replay.json()).toEqual({...record.response,idempotent_replay:true});
    }
    expect(artifacts(bucket)).toEqual(hashes);expect([...bucket.values].filter(([key])=>key.startsWith('orders/')||key.startsWith('settlements/'))).toEqual(originalAuthority);
    expect(network).not.toHaveBeenCalled();expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it.each(['get','body'])('bounds fallback stalled enrollment %s and ignores late responses before current resume',async stage=>{
    vi.useFakeTimers();const bucket=new MemoryBucket(),env=orderRuntime(bucket),network=mockOrderNetwork();vi.stubGlobal('fetch',network);
    const read=bucket.get.bind(bucket),cancel=vi.fn();let observed=false,release:(()=>void)|undefined;
    const object={size:1,etag:'synthetic',body:new ReadableStream<Uint8Array>({cancel}),json:async()=>new Promise(()=>{})};
    bucket.get=async key=>{
      if(!key.startsWith('orders/'))return null;observed=true;
      if(stage==='get')return new Promise(resolve=>{release=()=>resolve(object as never);});
      return object as never;
    };
    const pending=fallback.fetch(orderRequest({unpaid:true}),env);await vi.waitFor(()=>expect(observed).toBe(true));await vi.advanceTimersByTimeAsync(15_001);
    expect((await pending).status).toBe(503);release?.();await vi.advanceTimersByTimeAsync(1);
    expect(cancel).toHaveBeenCalledOnce();expect(bucket.values.size).toBe(0);expect(network).not.toHaveBeenCalled();expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
    bucket.get=read;vi.useRealTimers();expect((await app.fetch(orderRequest({unpaid:true}),env)).status).toBe(402);
    expect(network.mock.calls.every(([url])=>String(url).endsWith('/supported'))).toBe(true);expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it.each(['capture','preflight'])('original $product delivery survives a malformed current policy in fallback and resume',async product=>{
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),network=mockOrderNetwork();vi.stubGlobal('fetch',network);
    const response=await app.fetch(orderRequest({product}),env);expect(response.status).toBe(200);
    const delivery=await response.json();const originals=[...bucket.values];
    env.RETENTION_POLICY_JSON='invalid';network.mockClear();vi.mocked(env.BROWSER.quickAction).mockClear();
    for(const runtime of [fallback,app]) {
      const replay=await runtime.fetch(orderRequest({product}),env);expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({...delivery as object,idempotent_replay:true});
    }
    expect([...bucket.values]).toEqual(originals);expect(network).not.toHaveBeenCalled();expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it('bounds actual fallback enrollment bytes even if object metadata claims a small size',async()=>{
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),network=mockOrderNetwork();vi.stubGlobal('fetch',network);
    const cancel=vi.fn(),json=vi.fn(async()=>({}));bucket.get=async key=>key.startsWith('orders/')?({size:1,etag:'synthetic',json,
      body:new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(32_001));},cancel})}as never):null;
    expect((await fallback.fetch(orderRequest({unpaid:true}),env)).status).toBe(503);
    expect(json).not.toHaveBeenCalled();expect(cancel).toHaveBeenCalledOnce();expect(bucket.values.size).toBe(0);
    expect(network).not.toHaveBeenCalled();expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it.each(['capture','preflight'].flatMap(product => [false,true].flatMap(interrupt => [false,true].map(missingMetric => ({product,interrupt,missingMetric})))))
  ('reads and recovers new $product (interrupted=$interrupt, unknown browser metric=$missingMetric) without new payment/capture', async ({product,interrupt,missingMetric}) => {
    const bucket = new MemoryBucket(), env = orderRuntime(bucket), network = mockOrderNetwork();
    vi.stubGlobal('fetch',network);
    if (missingMetric) {
      const browser = vi.mocked(env.BROWSER.quickAction).getMockImplementation()!;
      vi.mocked(env.BROWSER.quickAction).mockImplementation(async (...args) => {
        const response = await browser(...args); response.headers.delete('x-browser-ms-used'); return response;
      });
    }
    if (interrupt) {
      const put = bucket.put.bind(bucket); let lost = false;
      bucket.put = async (key,value,options) => {
        if (!lost && key.startsWith('fulfillments/') && JSON.parse(String(value)).state === 'complete') {
          lost = true; throw new Error('synthetic original final-write interruption');
        }
        return put(key,value,options);
      };
    }
    const response = await app.fetch(orderRequest({ product, body: product === 'preflight' ? { url:'https://example.com/',expected:{contains:['missing promise']} } : undefined }),env);
    expect(response.status).toBe(interrupt ? 503 : 200);
    const key = [...bucket.values.keys()].find(key => key.startsWith('fulfillments/'))!;
    const delivery = JSON.parse(bucket.values.get(key)!.text).response;
    expect(delivery).toBeTruthy();
    const hashes = artifacts(bucket);
    network.mockClear(); vi.mocked(env.BROWSER.quickAction).mockClear();
    expect(await (await fallback.fetch(statusRequest(),env)).json()).toMatchObject(interrupt ? {state:'recovery_available'} : {state:'complete',delivery});
    expect(await (await fallback.fetch(statusRequest({recover:true}),env)).json()).toMatchObject({state:'complete',delivery});
    expect(await (await app.fetch(statusRequest(),env)).json()).toMatchObject({state:'complete',delivery});
    if (product === 'preflight') expect(delivery).toMatchObject({safe:false,changed:null,reason:'expectation_failed'});
    expect(artifacts(bucket)).toEqual(hashes);
    expect(network).not.toHaveBeenCalled(); expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it('preserves unknown settlement in both runtimes, with no second settle or observation', async () => {
    const bucket = new MemoryBucket(), env = orderRuntime(bucket), settle = vi.fn(async () => {throw new Error('synthetic lost settlement response');});
    const network = mockOrderNetwork(settle); vi.stubGlobal('fetch',network);
    expect((await app.fetch(orderRequest(),env)).status).toBe(503);
    const records = [...bucket.values]; network.mockClear();
    for (const runtime of [fallback,app]) {
      const response = await runtime.fetch(statusRequest({recover:true}),env);
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({state:'settlement_unknown',payment:{treasury_received:null}});
    }
    expect([...bucket.values]).toEqual(records); expect(settle).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled(); expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it('retains new order policy and expiry across fallback without deleting originals', async () => {
    const bucket = new MemoryBucket(), env = orderRuntime(bucket), network = mockOrderNetwork();
    vi.stubGlobal('fetch',network);
    const policy = { schema:'delta-retention-policy/v1',policy_id:'isolated-fallback-test',classes:{
      raw_artifacts:{start_event:'settlement_confirmed',retain_seconds:60,deletion_window_seconds:60},
      minimal_metadata:{start_event:'settlement_confirmed',retain_seconds:120,deletion_window_seconds:60},
      transaction_audit:{start_event:'settlement_confirmed',retain_seconds:240,deletion_window_seconds:60}},
      export_rights:{raw_artifacts:'authenticated_until_raw_expiry',minimal_metadata:'authenticated_until_metadata_expiry'}};
    env.RETENTION_POLICY_JSON = JSON.stringify(policy);
    const request = orderRequest(); request.headers.set('x-delta-retention-policy-hash',await sha256(stableJson(policy)));
    expect((await app.fetch(request,env)).status).toBe(200);
    const original = await (await app.fetch(statusRequest(),env)).json() as any;
    const hashes = artifacts(bucket); network.mockClear(); vi.mocked(env.BROWSER.quickAction).mockClear();
    vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(Date.parse(original.retention.raw_expires_at));
    for (const runtime of [fallback,app]) {
      expect(await (await runtime.fetch(statusRequest(),env)).json()).toMatchObject({state:'raw_artifacts_expired',retention:{export_allowed:false}});
      const exported = await runtime.fetch(new Request(`https://delta.test/v1/orders/${TEST_ORDER_ID}/artifacts/html`,{headers:{'x-delta-recovery-token':TEST_RECOVERY_TOKEN}}),env);
      expect(exported.status).toBe(410);
    }
    expect(artifacts(bucket)).toEqual(hashes); expect(network).not.toHaveBeenCalled(); expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
});
