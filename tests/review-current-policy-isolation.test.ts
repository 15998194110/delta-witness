import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { sha256, stableJson } from '../src/crypto';
import { MemoryBucket, orderRuntime, orderRequest, mockOrderNetwork } from './helpers/order-runtime';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const policy = { schema:'delta-retention-policy/v1',policy_id:'original-valid-fixture',classes:{
  raw_artifacts:{start_event:'settlement_confirmed',retain_seconds:3600,deletion_window_seconds:60},
  minimal_metadata:{start_event:'settlement_confirmed',retain_seconds:7200,deletion_window_seconds:60},
  transaction_audit:{start_event:'settlement_confirmed',retain_seconds:10800,deletion_window_seconds:60},
},export_rights:{raw_artifacts:'authenticated_until_raw_expiry',minimal_metadata:'authenticated_until_metadata_expiry'}};
const cases = ['capture','preflight'].flatMap(product => ['complete','draft'].flatMap(stage => [false,true].map(headerless => ({product,stage,headerless}))));
describe('original signed replay is isolated from a malformed new retention proposal', () => {
  it.each(cases)('preserves $product $stage original delivery with invalid current policy (headerless=$headerless)', async ({product,stage,headerless}) => {
    const bucket=new MemoryBucket(), env=orderRuntime(bucket), network=mockOrderNetwork();
    env.RETENTION_POLICY_JSON=JSON.stringify(policy); vi.stubGlobal('fetch',network);
    const body=product==='preflight'?{url:'https://example.com/',expected:{contains:['missing fixture phrase']}}:{url:'https://example.com/'};
    const request=async(legacy=false)=>{const req=orderRequest({product,body,legacy});if(!legacy)req.headers.set('x-delta-retention-policy-hash',await sha256(stableJson(policy)));return req;};
    const put=bucket.put.bind(bucket);let interrupted=false;
    bucket.put=async(key,value,options)=>{
      if(stage==='draft'&&!interrupted&&key.startsWith('fulfillments/')&&JSON.parse(String(value)).state==='complete'){
        interrupted=true;throw new Error('synthetic-final-write-loss');
      }
      return put(key,value,options);
    };
    expect((await app.fetch(await request(),env)).status).toBe(stage==='complete'?200:503);
    const record=JSON.parse([...bucket.values].find(([key])=>key.startsWith('fulfillments/'))![1].text);
    const originals=[...bucket.values].filter(([key])=>!key.startsWith('fulfillments/'));
    env.RETENTION_POLICY_JSON='invalid';network.mockClear();vi.mocked(env.BROWSER.quickAction).mockClear();
    const replay=await app.fetch(await request(headerless),env);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({...record.response,idempotent_replay:true});
    if(product==='preflight')expect(record.response).toMatchObject({safe:false,reason:'expectation_failed'});
    expect(network).not.toHaveBeenCalled();expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
    expect([...bucket.values].filter(([key])=>!key.startsWith('fulfillments/'))).toEqual(originals);
  });
  it('does not use an old-order policy fallback to price or settle a fresh unscoped request',async()=>{
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),network=mockOrderNetwork();env.RETENTION_POLICY_JSON='invalid';vi.stubGlobal('fetch',network);
    const response=await app.fetch(orderRequest({legacy:true}),env);
    expect(response.status).toBe(400);expect(env.BROWSER.quickAction).not.toHaveBeenCalled();expect(network).not.toHaveBeenCalled();expect(bucket.values.size).toBe(0);
  });
  it('an unfinished paid original retains purchased terms and price despite an invalid current proposal',async()=>{
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),network=mockOrderNetwork();vi.stubGlobal('fetch',network);
    env.RETENTION_POLICY_JSON=JSON.stringify(policy);
    vi.mocked(env.BROWSER.quickAction).mockResolvedValueOnce(new Response('',{status:503}));
    const first=orderRequest();first.headers.set('x-delta-retention-policy-hash',await sha256(stableJson(policy)));
    expect((await app.fetch(first,env)).status).toBe(502);
    const originalAuthority=[...bucket.values].filter(([key])=>key.startsWith('orders/')||key.startsWith('settlements/'));
    Object.assign(env,{RETENTION_POLICY_JSON:'invalid',CAPTURE_BASE_PRICE_USD:'9'});
    const result=await app.fetch(orderRequest({legacy:true}),env);
    expect(result.status).toBe(200);
    const manifest=JSON.parse([...bucket.values].find(([key])=>key.endsWith('/manifest.json'))![1].text);
    expect(manifest.payment.listed_price_usd).toBe(1);
    expect(manifest.execution.cost_model).toMatchObject({storageDurationSource:'purchased_policy_maximum',storagePolicyId:policy.policy_id});
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(2);expect(network.mock.calls.filter(([url])=>String(url).endsWith('/settle'))).toHaveLength(1);
    expect([...bucket.values].filter(([key])=>key.startsWith('orders/')||key.startsWith('settlements/'))).toEqual(originalAuthority);
  });
  it('malformed current policy does not weaken original request binding or legacy completed replay',async()=>{
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),network=mockOrderNetwork();vi.stubGlobal('fetch',network);
    const original=await (await app.fetch(orderRequest({legacy:true}),env)).json<Record<string,unknown>>();
    const before=[...bucket.values];env.RETENTION_POLICY_JSON='invalid';network.mockClear();vi.mocked(env.BROWSER.quickAction).mockClear();
    const changed=await app.fetch(orderRequest({legacy:true,body:{url:'https://example.com/different'}}),env);
    expect(changed.status).toBe(409);
    expect(await (await app.fetch(orderRequest({legacy:true}),env)).json()).toEqual({...original,idempotent_replay:true});
    expect(network).not.toHaveBeenCalled();expect(env.BROWSER.quickAction).not.toHaveBeenCalled();expect([...bucket.values]).toEqual(before);
  });
  it.each(['capture','preflight'])('preserves the observed historical %s complete-record shape without inventing receipts or repricing',async product=>{
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),network=mockOrderNetwork();vi.stubGlobal('fetch',network);
    const request=()=>orderRequest({legacy:true,product});
    const original=await (await app.fetch(request(),env)).json<Record<string,unknown>>();
    // Synthetic reconstruction of the two shape-only live readbacks. No customer
    // payload/payment signature is imported and no real storage is changed.
    const [key,value]=[...bucket.values].find(([name])=>name.startsWith('fulfillments/'))!;
    const historical=JSON.parse(value.text);delete historical.response_hash;delete historical.payment_response_header;
    if(product==='preflight')delete historical.paid_price_usd;else historical.paid_price_usd=0.03;
    await bucket.put(key,JSON.stringify(historical));
    for(const name of [...bucket.values.keys()])if(name.startsWith('settlements/'))bucket.values.delete(name);
    const before=[...bucket.values];network.mockClear();vi.mocked(env.BROWSER.quickAction).mockClear();
    const replay=await app.fetch(request(),env);expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({...original,idempotent_replay:true});
    expect(replay.headers.has('payment-response')).toBe(false);
    expect(network).not.toHaveBeenCalled();expect(env.BROWSER.quickAction).not.toHaveBeenCalled();expect([...bucket.values]).toEqual(before);
  });
});
