import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { orderAuthorityDigest, orderRecordKey, type OrderBinding } from '../src/orders';
import { EXPORT_AUTHORIZATION_TIMEOUT_MS } from '../src/order-export-authorization';
import { sha256, stableJson } from '../src/crypto';
import { DeltaWitness, type OrderRecord, type Product } from '../packages/js-client/src/index.js';
import { MemoryBucket, orderRuntime, orderRequest, orderPayment, statusRequest, mockOrderNetwork, TEST_ORDER_ID, TEST_RECOVERY_TOKEN } from './helpers/order-runtime';

const started = Date.parse('2026-11-02T15:00:00.000Z');
const root = TEST_RECOVERY_TOKEN;
const child = Buffer.alloc(32, 31).toString('base64url');
const child2 = Buffer.alloc(32, 32).toString('base64url');
const operation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const operation2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const key = orderRecordKey(TEST_ORDER_ID);
const policy = { schema: 'delta-retention-policy/v1', policy_id: 'authorization-fixture', classes: {
  raw_artifacts: { start_event: 'settlement_confirmed', retain_seconds: 120, deletion_window_seconds: 60 },
  minimal_metadata: { start_event: 'settlement_confirmed', retain_seconds: 240, deletion_window_seconds: 60 },
  transaction_audit: { start_event: 'settlement_confirmed', retain_seconds: 480, deletion_window_seconds: 60 },
}, export_rights: { raw_artifacts: 'authenticated_until_raw_expiry', minimal_metadata: 'authenticated_until_metadata_expiry' } };

function request(body?: unknown, token = root, suffix = '', extras: Record<string, string> = {}) {
  return new Request(`https://delta.test/v1/orders/${TEST_ORDER_ID}/export-authorization${suffix}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'x-delta-recovery-token': token, ...(body === undefined ? {} : {'content-type':'application/json'}), ...extras },
    ...(body === undefined ? {} : {body: typeof body === 'string' ? body : JSON.stringify(body)}),
  });
}
function input(overrides: Record<string, unknown> = {}) { return {operation_id:operation, token:child, ttl_seconds:60, expected_generation:0, ...overrides}; }
function artifact(token = child, type = 'html') { return new Request(`https://delta.test/v1/orders/${TEST_ORDER_ID}/artifacts/${type}`, {headers:{'x-delta-recovery-token':token}}); }
function read(bucket: MemoryBucket): OrderBinding { return JSON.parse(bucket.values.get(key)!.text); }
async function fixture(options: {product?:string; ttl?:string; retention?:boolean; unknown?:boolean} = {}) {
  vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(started);
  const bucket = new MemoryBucket(), env = orderRuntime(bucket), network = mockOrderNetwork(options.unknown ? async()=>{throw new Error('synthetic_settlement_unknown');} : undefined);
  env.ORDER_RECOVERY_TTL_SECONDS = options.ttl ?? '3600';
  if (options.retention) env.RETENTION_POLICY_JSON = JSON.stringify(policy);
  vi.stubGlobal('fetch',network);
  const req = orderRequest({product:options.product});
  if (options.retention) req.headers.set('x-delta-retention-policy-hash',await sha256(stableJson(policy)));
  expect((await app.fetch(req,env)).status).toBe(options.unknown ? 503 : 200);
  network.mockClear(); vi.mocked(env.BROWSER.quickAction).mockClear();
  const untouched = () => [...bucket.values].filter(([path]) => path !== key);
  return {bucket,env,network,before:structuredClone(untouched()),untouched};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('D06 original-root-authorized export credential updates, isolated only',()=>{
  it.each(['capture','preflight'] as Product[])('actual JS SDK to Core %s renewal and restart export reuse one original payment',async product=>{
    vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(started);
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),network=mockOrderNetwork();vi.stubGlobal('fetch',network);
    const values=new Map<string,OrderRecord>(),store={
      async load(id:string){return values.has(id)?structuredClone(values.get(id)):null;},
      async compareAndSet(id:string,revision:number|null,next:OrderRecord){if((values.get(id)?.revision??null)!==revision)return false;values.set(id,structuredClone(next));return true;},
    };
    const requests:Array<{method:string;path:string}>=[];
    const transport=async(url:string,init:RequestInit)=>{const req=new Request(url,init);requests.push({method:req.method,path:new URL(url).pathname});return app.fetch(req,env);};
    const client=()=>new DeltaWitness({baseUrl:'https://delta.test',fetchImpl:transport,orderStore:store});
    const delta=client();await delta.prepareOrder(product,{url:'https://example.com/',...(product==='preflight'?{expected:{contains:['missing promise']}}:{})},{orderId:TEST_ORDER_ID});
    const paid=vi.fn(async(url:string,init:RequestInit)=>{const headers=new Headers(init.headers);headers.set('payment-signature',Buffer.from(JSON.stringify(orderPayment(product))).toString('base64'));return transport(url,{...init,headers});});
    const delivered=await delta.executeOrder(TEST_ORDER_ID,paid);expect(delivered.state).toBe('complete');
    if(product==='preflight')expect(delivered.delivery).toMatchObject({safe:false,reason:'expectation_failed'});
    const original=read(bucket),authority=await orderAuthorityDigest(original),proofObjects=structuredClone([...bucket.values].filter(([path])=>path!==key));
    const initialExport=await delta.exportArtifact(TEST_ORDER_ID,'html');network.mockClear();vi.mocked(env.BROWSER.quickAction).mockClear();requests.length=0;
    const first=await delta.renewExportAuthorization(TEST_ORDER_ID,{ttlSeconds:60});
    expect(first.authorization).toMatchObject({generation:1,scope:['export'],state:'active',expires_at:new Date(started+60_000).toISOString()});
    const privateFirst=structuredClone(values.get(TEST_ORDER_ID)!.export_authorization!);
    expect(privateFirst.phase).toBe('confirmed');expect(JSON.stringify(first)).not.toContain(privateFirst.token);
    const restarted=client();expect(await restarted.recoverExportAuthorization(TEST_ORDER_ID)).toEqual(first);
    const afterRestart=await restarted.exportArtifact(TEST_ORDER_ID,'html',{authorization:'derived'});
    expect(afterRestart.bytes).toEqual(initialExport.bytes);expect(afterRestart.content_sha256).toBe(initialExport.content_sha256);
    vi.setSystemTime(started+60_001);
    expect((await restarted.recoverExportAuthorization(TEST_ORDER_ID)).authorization?.state).toBe('expired');
    expect((await restarted.renewExportAuthorization(TEST_ORDER_ID,{ttlSeconds:120})).authorization?.generation).toBe(2);
    expect((await app.fetch(artifact(privateFirst.token),env)).status).toBe(404);
    expect((await restarted.exportArtifact(TEST_ORDER_ID,'html',{authorization:'derived'})).bytes).toEqual(initialExport.bytes);
    expect((await restarted.recoverOrder(TEST_ORDER_ID)).state).toBe('complete');
    expect(paid).toHaveBeenCalledTimes(1);expect(network).not.toHaveBeenCalled();expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
    expect(requests.filter(r=>r.method==='POST')).toEqual(Array(2).fill({method:'POST',path:`/v1/orders/${TEST_ORDER_ID}/export-authorization`}));
    expect(await orderAuthorityDigest(read(bucket))).toBe(authority);expect([...bucket.values].filter(([path])=>path!==key)).toEqual(proofObjects);
  });
  it('actual JS SDK lost Core response resumes the persisted operation with GET only and no second charge',async()=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(started);
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),network=mockOrderNetwork();vi.stubGlobal('fetch',network);
    const values=new Map<string,OrderRecord>(),store={
      async load(id:string){return values.has(id)?structuredClone(values.get(id)):null;},
      async compareAndSet(id:string,revision:number|null,next:OrderRecord){if((values.get(id)?.revision??null)!==revision)return false;values.set(id,structuredClone(next));return true;},
    };
    let loseAck=true;const methods:string[]=[];
    const transport=async(url:string,init:RequestInit)=>{const req=new Request(url,init),response=await app.fetch(req,env);
      if(url.endsWith('/export-authorization')){methods.push(req.method);if(req.method==='POST'&&loseAck){loseAck=false;throw new Error('synthetic-lost-response-after-Core-commit');}}return response;};
    const client=()=>new DeltaWitness({baseUrl:'https://delta.test',fetchImpl:transport,orderStore:store});
    const delta=client();await delta.prepareOrder('capture',{url:'https://example.com/'},{orderId:TEST_ORDER_ID});
    const paid=vi.fn(async(url:string,init:RequestInit)=>{const headers=new Headers(init.headers);headers.set('payment-signature',Buffer.from(JSON.stringify(orderPayment())).toString('base64'));return transport(url,{...init,headers});});
    await delta.executeOrder(TEST_ORDER_ID,paid);network.mockClear();vi.mocked(env.BROWSER.quickAction).mockClear();
    const proofObjects=structuredClone([...bucket.values].filter(([path])=>path!==key));
    await expect(delta.renewExportAuthorization(TEST_ORDER_ID)).rejects.toMatchObject({code:'order_export_authorization_unconfirmed'});
    const pending=structuredClone(values.get(TEST_ORDER_ID)!.export_authorization!);expect(pending.phase).toBe('pending');
    expect(read(bucket).export_authorization?.operation_id).toBe(pending.operation_id);
    const resumed=await client().renewExportAuthorization(TEST_ORDER_ID);expect(resumed.authorization?.operation_id).toBe(pending.operation_id);
    expect(methods).toEqual(['GET','POST','GET']);expect(values.get(TEST_ORDER_ID)!.export_authorization?.phase).toBe('confirmed');
    expect((await client().exportArtifact(TEST_ORDER_ID,'html',{authorization:'derived'})).bytes.byteLength).toBeGreaterThan(0);
    expect(paid).toHaveBeenCalledTimes(1);expect(network).not.toHaveBeenCalled();expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
    expect([...bucket.values].filter(([path])=>path!==key)).toEqual(proofObjects);
  });
  it.each(['capture','preflight'])('issues and rotates %s export credentials without changing the original paid order or proof',async product=>{
    const f=await fixture({product}), original=read(f.bucket), authority=await orderAuthorityDigest(original);
    expect(await (await app.fetch(request(),f.env)).json()).toEqual({ok:true,order_id:TEST_ORDER_ID,authorization:null});
    const initial = await app.fetch(request(input()),f.env); expect(initial.status).toBe(201);
    const first = await initial.json();
    expect(first).toEqual({ok:true,order_id:TEST_ORDER_ID,authorization:{operation_id:operation,generation:1,expires_at:new Date(started+60_000).toISOString(),scope:['export'],state:'active'}});
    const digest = read(f.bucket).export_authorization!.token_digest;
    expect(JSON.stringify(first)).not.toContain(child); expect(JSON.stringify(first)).not.toContain(digest);
    for(const type of ['html','markdown','screenshot','manifest']) {
      const before=await app.fetch(artifact(root,type),f.env), after=await app.fetch(artifact(child,type),f.env);
      expect(after.status).toBe(200); expect(new Uint8Array(await after.arrayBuffer())).toEqual(new Uint8Array(await before.arrayBuffer()));
      expect(after.headers.get('x-delta-content-sha256')).toBe(before.headers.get('x-delta-content-sha256'));
    }
    expect((await app.fetch(request(input({operation_id:operation2,token:child2,expected_generation:1})),f.env)).status).toBe(201);
    expect((await app.fetch(artifact(child),f.env)).status).toBe(404); expect((await app.fetch(artifact(child2),f.env)).status).toBe(200);
    const updated = read(f.bucket); const {export_authorization,...sameOriginal}=updated;
    expect(sameOriginal).toEqual(original); expect(await orderAuthorityDigest(updated)).toBe(authority);
    expect(f.untouched()).toEqual(f.before); expect(f.network).not.toHaveBeenCalled(); expect(f.env.BROWSER.quickAction).not.toHaveBeenCalled();
    expect((await app.fetch(statusRequest(),f.env)).status).toBe(200);
    expect((await app.fetch(statusRequest({recover:true}),f.env)).status).toBe(200);
  });
  it('expired child can be replaced by a valid root without extending root or retaining the old child',async()=>{
    const f=await fixture(); await app.fetch(request(input()),f.env); vi.setSystemTime(started+60_001);
    expect((await app.fetch(artifact(),f.env)).status).toBe(410);
    expect(await (await app.fetch(request(),f.env)).json()).toMatchObject({authorization:{state:'expired',generation:1}});
    expect((await app.fetch(request(input()),f.env)).status).toBe(200);
    expect(read(f.bucket).export_authorization!.expires_at).toBe(new Date(started+60_000).toISOString());
    expect((await app.fetch(request(input({operation_id:operation2,token:child2,expected_generation:1})),f.env)).status).toBe(201);
    expect((await app.fetch(artifact(child2),f.env)).status).toBe(200);
    expect(f.network).not.toHaveBeenCalled(); expect(f.env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it.each(['ttl','raw'])('child expiry is capped by original %s expiry',async kind=>{
    const f=await fixture(kind==='ttl'?{ttl:'120'}:{retention:true});
    const response=await app.fetch(request(input({ttl_seconds:3600})),f.env); expect(response.status).toBe(201);
    expect((await response.json() as any).authorization.expires_at).toBe(new Date(started+120_000).toISOString());
    vi.setSystemTime(started+120_000); expect((await app.fetch(artifact(),f.env)).status).toBe(410);
    expect((await app.fetch(request(input({operation_id:operation2,token:child2,expected_generation:1})),f.env)).status).toBe(410);
    expect(f.network).not.toHaveBeenCalled(); expect(f.untouched()).toEqual(f.before);
  });
  it('same operation is immutable and a stale operation cannot roll a later generation back',async()=>{
    const f=await fixture(); const put=vi.spyOn(f.bucket,'put');
    expect((await app.fetch(request(input()),f.env)).status).toBe(201); const original = f.bucket.values.get(key)!.text;
    vi.setSystemTime(started+1_000);
    expect((await app.fetch(request(input()),f.env)).status).toBe(200); expect(put).toHaveBeenCalledTimes(1); expect(f.bucket.values.get(key)!.text).toBe(original);
    expect((await app.fetch(request(input({ttl_seconds:120})),f.env)).status).toBe(409);
    expect((await app.fetch(request(input({operation_id:operation2,token:child2,expected_generation:1})),f.env)).status).toBe(201);
    expect((await app.fetch(request(input()),f.env)).status).toBe(409); expect(read(f.bucket).export_authorization!.generation).toBe(2);
  });
  it('concurrent distinct operations with one expected generation cannot both grant authority',async()=>{
    const f=await fixture(); const responses=await Promise.all([
      app.fetch(request(input()),f.env),app.fetch(request(input({operation_id:operation2,token:child2})),f.env),
    ]);
    expect(responses.map(r=>r.status).sort()).toEqual([201,409]);
    expect(read(f.bucket).export_authorization!.generation).toBe(1);
    const exports=await Promise.all([app.fetch(artifact(child),f.env),app.fetch(artifact(child2),f.env)]);
    expect(exports.map(r=>r.status).sort()).toEqual([200,404]); expect(f.untouched()).toEqual(f.before);
  });
  it('child and unrelated credentials cannot manage grants, recover status, enroll, or purchase',async()=>{
    const f=await fixture(); await app.fetch(request(input()),f.env); const before=structuredClone([...f.bucket.values]);
    for(const token of [child,child2]) {
      expect((await app.fetch(request(undefined,token),f.env)).status).toBe(404);
      expect((await app.fetch(request(input({operation_id:operation2,token:child2,expected_generation:1}),token),f.env)).status).toBe(404);
      expect((await app.fetch(statusRequest({token}),f.env)).status).toBe(404);
      expect((await app.fetch(statusRequest({token,recover:true}),f.env)).status).toBe(404);
      expect((await app.fetch(orderRequest({token}),f.env)).status).toBe(404);
    }
    expect([...f.bucket.values]).toEqual(before); expect(f.network).not.toHaveBeenCalled(); expect(f.env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it.each(['expired','revoked','scope'])('original root %s prevents child export and management',async kind=>{
    const f=await fixture(); await app.fetch(request(input({ttl_seconds:3600})),f.env);
    if(kind==='expired')vi.setSystemTime(started+3600_001);
    else { const row=read(f.bucket); if(kind==='revoked')row.revoked_at=new Date().toISOString(); else row.scope=['status','recover']; await f.bucket.put(key,JSON.stringify(row)); }
    expect((await app.fetch(request(input({operation_id:operation2,token:child2,expected_generation:1})),f.env)).status).toBe(kind==='expired'?410:kind==='scope'?403:404);
    expect((await app.fetch(artifact(),f.env)).status).toBe(kind==='expired'?410:kind==='scope'?403:404);
    expect(f.network).not.toHaveBeenCalled();
  });
  it.each([
    {ttl_seconds:59},{ttl_seconds:3601},{ttl_seconds:1.5},{expected_generation:-1},{expected_generation:1.5},
    {token:root},{token:'invalid'},{operation_id:'not-a-uuid'},{scope:['status']},{unknown:'synthetic-secret'},
  ])('rejects malformed or expanded grant request %j before changing records',async overrides=>{
    const f=await fixture(), before=structuredClone([...f.bucket.values]);
    const response=await app.fetch(request(input(overrides)),f.env); expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('synthetic-secret'); expect([...f.bucket.values]).toEqual(before);
  });
  it.each(['query','payment','origin','oversized','invalid-json'])('rejects %s input privately without side effects',async kind=>{
    const f=await fixture(), before=structuredClone([...f.bucket.values]);
    const req=request(kind==='oversized'?' '.repeat(2049):kind==='invalid-json'?'{':input(),root,kind==='query'?'?token=not-authority':'',
      kind==='payment'?{'payment-signature':'synthetic-signature'}:kind==='origin'?{origin:'https://foreign.test'}:{});
    const response=await app.fetch(req,f.env); expect([400,404]).toContain(response.status); expect(response.headers.get('cache-control')).toContain('no-store');
    expect([...f.bucket.values]).toEqual(before); expect(f.network).not.toHaveBeenCalled();
  });
  it('unknown original settlement cannot issue new export authorization or settle again',async()=>{
    const f=await fixture({unknown:true}); expect((await app.fetch(request(input()),f.env)).status).toBe(409);
    expect(read(f.bucket).export_authorization).toBeUndefined(); expect(f.network).not.toHaveBeenCalled(); expect(f.env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it.each(['get','body','put'])('bounded %s failure retains uncertainty and late completion cannot continue authorization',async stage=>{
    const f=await fixture(); vi.useFakeTimers(); vi.setSystemTime(started);
    const get=f.bucket.get.bind(f.bucket), put=f.bucket.put.bind(f.bucket); let enter!:()=>void,release!:()=>void;
    const entered=new Promise<void>(resolve=>{enter=resolve;}); let held=false, result:Response|undefined;
    if(stage==='put')f.bucket.put=async(k,v,o)=>{ if(k===key&&!held){held=true;enter();await new Promise<void>(resolve=>{release=resolve;});}return put(k,v,o); };
    else f.bucket.get=async k=>{
      if(k!==key||held)return get(k); held=true; enter();
      if(stage==='get'){await new Promise<void>(resolve=>{release=resolve;});return get(k);}
      const original=await get(k); return {...original!,body:new ReadableStream<Uint8Array>({start(){},cancel(){}})};
    };
    const running=Promise.resolve(app.fetch(request(input()),f.env)).then(r=>{result=r;return r;});
    await entered; await vi.advanceTimersByTimeAsync(EXPORT_AUTHORIZATION_TIMEOUT_MS+1);
    expect(result?.status).toBe(503); release?.(); await running; await vi.advanceTimersByTimeAsync(1);
    f.bucket.get=get; f.bucket.put=put;
    if(stage==='put') {
      expect(read(f.bucket).export_authorization?.generation).toBe(1);
      expect(await (await app.fetch(request(),f.env)).json()).toMatchObject({authorization:{operation_id:operation,generation:1}});
    } else expect(read(f.bucket).export_authorization).toBeUndefined();
    expect(f.network).not.toHaveBeenCalled();expect(f.env.BROWSER.quickAction).not.toHaveBeenCalled();expect(f.untouched()).toEqual(f.before);
  });
  it('request body stream has one total deadline and no later write',async()=>{
    const f=await fixture(); vi.useFakeTimers(); vi.setSystemTime(started); const cancel=vi.fn(); let entered!:()=>void;
    const startedRead=new Promise<void>(resolve=>{entered=resolve;});
    const body=new ReadableStream<Uint8Array>({pull(){entered();return new Promise(()=>{});},cancel});
    const req=new Request(`https://delta.test/v1/orders/${TEST_ORDER_ID}/export-authorization`,{method:'POST',headers:{'content-type':'application/json','x-delta-recovery-token':root},body,duplex:'half'} as RequestInit);
    let result:Response|undefined; const running=Promise.resolve(app.fetch(req,f.env)).then(r=>{result=r;});
    await startedRead; await vi.advanceTimersByTimeAsync(EXPORT_AUTHORIZATION_TIMEOUT_MS+1); await running;
    expect(result?.status).toBe(503);expect(cancel).toHaveBeenCalled();expect(read(f.bucket).export_authorization).toBeUndefined();expect(f.network).not.toHaveBeenCalled();
  });
  it('rotation during a slow export refuses the old child before emitting artifact bytes',async()=>{
    const f=await fixture(); await app.fetch(request(input()),f.env); const get=f.bucket.get.bind(f.bucket); let entered!:()=>void,release!:()=>void,held=false;
    const waiting=new Promise<void>(resolve=>{entered=resolve;});
    f.bucket.get=async k=>{if(k.endsWith('/page.html')&&!held){held=true;entered();await new Promise<void>(resolve=>{release=resolve;});}return get(k);};
    const oldExport=app.fetch(artifact(),f.env); await waiting;
    expect((await app.fetch(request(input({operation_id:operation2,token:child2,expected_generation:1})),f.env)).status).toBe(201);
    release(); expect((await oldExport).status).toBe(404); f.bucket.get=get;
    expect((await app.fetch(artifact(child2),f.env)).status).toBe(200); expect(f.untouched()).toEqual(f.before);
  });
  it('lost write acknowledgement is queried by original operation and does not rewrite on retry',async()=>{
    const f=await fixture(), put=f.bucket.put.bind(f.bucket); let puts=0;
    f.bucket.put=async(k,v,o)=>{puts++;const result=await put(k,v,o);throw new Error('synthetic-provider-secret-after-commit');};
    const response=await app.fetch(request(input()),f.env);expect(response.status).toBe(503);expect(await response.text()).not.toContain('synthetic-provider-secret');
    f.bucket.put=async(k,v,o)=>{puts++;return put(k,v,o);};
    expect(await (await app.fetch(request(),f.env)).json()).toMatchObject({authorization:{operation_id:operation,generation:1}});
    expect((await app.fetch(request(input()),f.env)).status).toBe(200);expect(puts).toBe(1);expect(f.untouched()).toEqual(f.before);
  });
});
