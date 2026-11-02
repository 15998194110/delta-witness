import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { sha256, stableJson } from '../src/crypto';
import { MemoryBucket, mockOrderNetwork, orderRequest, orderRuntime } from './helpers/order-runtime';

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function responseHash(record: any) {
  return sha256(`delta-pilot-response/v1\n${stableJson({request_hash: record.request_hash,
    payment_fingerprint: record.payment_fingerprint, response: record.response})}`);
}
async function fixture(draft = false) {
  const bucket = new MemoryBucket(), env = orderRuntime(bucket), network = mockOrderNetwork();
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) =>
    String(url).startsWith('https://example.com/') ? new Response('', {status:200}) : network(url)));
  const browser = vi.mocked(env.BROWSER.quickAction), original = browser.getMockImplementation()!;
  browser.mockImplementation(async (...args) => {
    const response = await original(...args), data = await response.json() as any;
    data.meta.finalUrl = (args[1] as any).url;
    return Response.json(data, {headers:{'x-browser-ms-used':'1'}});
  });
  const body = {urls:['https://example.com/page1','https://example.com/page2'],
    preflight:{url_index:0,expected:{contains:['unmet original condition']}}};
  const request = () => orderRequest({product:'guarded-action-pilot',legacy:true,body});
  expect((await app.fetch(request(),env)).status).toBe(200);
  const key = [...bucket.values.keys()].find(value=>value.startsWith('guarded-pilot/'))!;
  const record = JSON.parse(bucket.values.get(key)!.text);
  expect(record.response.economics.basis).toBe('sum_of_proof_cost_models_not_actual_total');
  // Exact d85 aggregate wire shape (git show d85b367:src/guarded-pilot.ts):
  // proofs/preflight/cost/margin plus the original response digest, no basis.
  // The separate mixed-runtime suite exercises the immutable old artifact.
  delete record.response.economics.basis;
  record.response_hash = await responseHash(record);
  if (draft) record.state = 'processing';
  await bucket.put(key,JSON.stringify(record));
  const snapshot = () => [...bucket.values.entries()].filter(([path])=>path!==key).map(([path,value])=>[path,structuredClone(value)]);
  const originals = snapshot();
  const deny = vi.fn(async()=>{throw new Error('recovery must not make a new observation or payment');});
  vi.stubGlobal('fetch',deny); browser.mockClear(); browser.mockImplementation(deny);
  return {bucket,env,browser,request,key,record,originals,snapshot,deny};
}

describe('legacy Pilot aggregate response compatibility, isolated original evidence',()=>{
  it.each([false,true])('preserves the exact original legacy response for completed/draft=%s without adding economics fields',async draft=>{
    const s=await fixture(draft), rawBefore=s.bucket.values.get(s.key)!;
    const response=await app.fetch(s.request(),s.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({...s.record.response,idempotent_replay:true});
    const persisted=JSON.parse(s.bucket.values.get(s.key)!.text);
    expect(persisted.response).toEqual(s.record.response);expect(persisted.response_hash).toBe(s.record.response_hash);
    expect(persisted.response.economics).not.toHaveProperty('basis');expect(persisted.state).toBe('complete');
    if(!draft)expect(s.bucket.values.get(s.key)).toEqual(rawBefore);
    expect(s.snapshot()).toEqual(s.originals);expect(s.browser).not.toHaveBeenCalled();expect(s.deny).not.toHaveBeenCalled();
  });
  it.each(['basis','null-basis','hash','amount','cost','proof','unknown-field','artifact'] as const)
  ('rejects tampered legacy %s without publication, capture or changed original evidence',async kind=>{
    const s=await fixture(true), record=s.record;
    if(kind==='basis')record.response.economics.basis='actual_verified_cost';
    if(kind==='null-basis')record.response.economics.basis=null;
    if(kind==='hash')record.response_hash='sha256:'+'0'.repeat(64);
    if(kind==='amount')record.response.price_usd=1;
    if(kind==='cost'){record.response.economics.variable_cost_usd=0;record.response.economics.contribution_margin_usd=10;}
    if(kind==='proof')record.response.proofs[0].bundle_root='sha256:'+'0'.repeat(64);
    if(kind==='unknown-field')record.response.economics.source='provider-confirmed';
    if(kind==='artifact'){
      const artifact=[...s.bucket.values.keys()].find(value=>value.endsWith('/page.md'))!;
      await s.bucket.put(artifact,'modified original artifact');
    }
    if(kind!=='hash')record.response_hash=await responseHash(record);
    await s.bucket.put(s.key,JSON.stringify(record));
    const before=structuredClone([...s.bucket.values.entries()]);
    const response=await app.fetch(s.request(),s.env);
    expect(response.status).toBe(503);expect(await response.json()).toMatchObject({ok:false,state:'fulfillment_unknown'});
    expect([...s.bucket.values.entries()]).toEqual(before);expect(s.browser).not.toHaveBeenCalled();expect(s.deny).not.toHaveBeenCalled();
  });
});
