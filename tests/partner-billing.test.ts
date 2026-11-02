import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import vm from 'node:vm';
import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { app as core } from '../src/index';
import { app as gateway } from '../channels/partner-gateway/src/index';
import { coordinatePartnerBilling,partnerBusinessIdentity } from '../src/partner-billing';
import { MemoryBucket,orderRuntime,mockOrderNetwork } from './helpers/order-runtime';

const actorSource=readFileSync(new NodeURL('../channels/apify/main.mjs',import.meta.url),'utf8').replace('import { Actor } from "apify";','const Actor=mockActor;');
const request={url:'https://example.com/'};
const firstAttempt='11111111-1111-4111-8111-111111111111',secondAttempt='22222222-2222-4222-8222-222222222222';
beforeEach(()=>{
  const original=crypto,subtle=new Proxy(original.subtle,{get(target,name){
    if(name==='timingSafeEqual')return(a:ArrayBuffer,b:ArrayBuffer)=>Buffer.from(a).equals(Buffer.from(b));
    const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value;
  }});
  vi.stubGlobal('crypto',{subtle,getRandomValues:original.getRandomValues.bind(original),randomUUID:original.randomUUID.bind(original)});
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
function fixture(){
  const bucket=new MemoryBucket(),env=Object.assign(orderRuntime(bucket),{PARTNER_GATEWAY_SECRET:'synthetic-core-secret',PARTNER_BILLING_COORDINATION_ENABLED:'true',PUBLIC_ORIGIN:'https://delta-witness-api.ruphussten.workers.dev'});
  const network=mockOrderNetwork(async()=>{throw new Error('no x402 settlement on platform rail');});vi.stubGlobal('fetch',network);
  const gatewayEnv={APP_VERSION:'0.7.1',PARTNER_ID:'apify',PARTNER_SECRET:'synthetic-proxy-secret',CORE_SERVICE_SECRET:'synthetic-core-secret',
    PARTNER_NET_CAPTURE_USD:'1',PARTNER_NET_PREFLIGHT_USD:'1',PARTNER_NET_WATCH_CHECK_USD:'1',
    PARTNER_RATE_LIMITER:{limit:async()=>({success:true})},CORE:{fetch:(req:Request)=>core.fetch(req,env)}};
  const call=(operation:string,attemptId?:string,body:Record<string,unknown>=request,userId='user-A',product:'capture'|'preflight'='capture')=>coordinatePartnerBilling(env,
    {partner:'apify',userId,businessOrderId:'business-001',product,request:body,operation:operation as any,attemptId});
  const capture=async(product='capture',body:Record<string,unknown>=request,user='user-A')=>gateway.request(`https://gateway.test/business/business-001/${product}`,{
    method:'POST',headers:{'content-type':'application/json','x-delta-partner-secret':'synthetic-proxy-secret','x-delta-partner-user':user},body:JSON.stringify(body)},gatewayEnv as any);
  return {bucket,env,network,gatewayEnv,call,capture};
}
async function actorRun(state:ReturnType<typeof fixture>,options:{user?:string;runId?:string;input?:Record<string,unknown>;chargeError?:boolean;lostAck?:string;values?:Map<string,unknown>;platform?:Record<string,()=>Promise<unknown>>}={}){
  const values=options.values??new Map();
  const actor={init:vi.fn(),exit:vi.fn(),isAtHome:()=>true,getEnv:()=>({actorRunId:options.runId??crypto.randomUUID()}),
    getInput:async()=>({product:'capture',business_order_id:'business-001',...request,...options.input}),
    getValue:async(key:string)=>values.get(key)??null,setValue:async(key:string,value:unknown)=>{values.set(key,value);},
    getChargingManager:()=>({getPricingInfo:()=>({isPayPerEvent:true,perEventPrices:{'proof-created':1}}),calculateMaxEventChargeCountWithinLimit:()=>1}),
    charge:vi.fn(async()=>{if(options.chargeError)throw new Error('synthetic lost platform ACK');return {chargedCount:1};}),pushData:vi.fn()};
  for(const [name,implementation] of Object.entries(options.platform??{}))(actor as any)[name]=vi.fn(implementation);
  const transport=vi.fn(async(url:string,init:RequestInit)=>{
    const response=await gateway.request(url,init,state.gatewayEnv as any);
    if(options.lostAck&&url.endsWith('/billing')&&JSON.parse(String(init.body)).operation===options.lostAck&&response.status===200)throw new Error('synthetic gateway ACK loss');
    return response;
  });
  let error:unknown;
  try{await vm.runInNewContext(`(async()=>{${actorSource}})()`,{mockActor:actor,fetch:transport,URL,Response,AbortController,setTimeout,clearTimeout,crypto,
    process:{env:{DELTA_PARTNER_GATEWAY_URL:'https://gateway.test',DELTA_PARTNER_SECRET:'synthetic-proxy-secret',APIFY_USER_ID:options.user??'user-A'}},console:{log:vi.fn()}});}catch(e){error=e;}
  return {actor,transport,error,values};
}

describe('original fulfillment CAS for partner billing, real Core/Gateway and isolated Actor',()=>{
  it('feature negotiation denies old/disabled coordinators before any Browser or platform charge',async()=>{
    const state=fixture();state.env.PARTNER_BILLING_COORDINATION_ENABLED='false';
    const run=await actorRun(state);expect(run.error).toBeDefined();expect(run.actor.charge).not.toHaveBeenCalled();
    expect(state.env.BROWSER.quickAction).not.toHaveBeenCalled();expect(state.bucket.values.size).toBe(0);
  });
  it('one automatic Actor purchase and a new run reuse the same original proof without charging or capturing again',async()=>{
    const state=fixture(),first=await actorRun(state,{runId:'run-1'}),second=await actorRun(state,{runId:'run-2'});
    expect(first.error).toBeUndefined();expect(second.error).toBeUndefined();expect(first.actor.charge).toHaveBeenCalledTimes(1);expect(second.actor.charge).not.toHaveBeenCalled();
    expect(second.values.get('OUTPUT')).toEqual(first.values.get('OUTPUT'));expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
    expect((await state.call('status')).body).toMatchObject({may_charge:false,billing:{state:'platform_charged',platform_charged:true,settlement_confirmed:null,treasury_received:null,net_payout_usd:null,revenue_usd:null}});
    expect(state.network.mock.calls.some(([url])=>String(url).endsWith('/settle'))).toBe(false);
    expect([...state.bucket.values.keys()].every(key=>key.startsWith('fulfillments/')||/^[a-f0-9-]{36}\//.test(key))).toBe(true);
  });
  it('two independent Actor runs share one Core capture and at most one charge callback',async()=>{
    const state=fixture(),runs=await Promise.all([actorRun(state,{runId:'run-A'}),actorRun(state,{runId:'run-B'})]);
    expect(runs.reduce((n,run)=>n+run.actor.charge.mock.calls.length,0)).toBe(1);expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
    const recovery=await actorRun(state,{runId:'run-C'});expect(recovery.error).toBeUndefined();expect(recovery.actor.charge).not.toHaveBeenCalled();
  });
  it('concurrent direct reserve calls grant exactly one ephemeral charge permission and never regrant its attempt',async()=>{
    const state=fixture();expect((await state.capture()).status).toBe(200);
    const results=await Promise.all(Array.from({length:12},()=>state.call('reserve_charge',crypto.randomUUID())));
    const winner=results.find(result=>result.body.may_charge===true)!;expect(results.filter(result=>result.body.may_charge===true)).toHaveLength(1);
    expect((await state.call('reserve_charge',String(winner.body.attempt_id))).body.may_charge).toBe(false);
    expect((await state.call('confirm_charge',secondAttempt)).status).toBe(409);
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });
  it('same user/order with a different payload conflicts; another user cannot query its proof',async()=>{
    const state=fixture();await state.capture();const original=[...state.bucket.values].map(([key,value])=>[key,value.text]);
    expect((await state.call('status',undefined,{url:'https://different.test/'})).status).toBe(409);
    const other=await state.call('status',undefined,request,'user-B');expect(other.status).toBe(404);expect(other.body.delivery).toBeUndefined();
    expect([...state.bucket.values].map(([key,value])=>[key,value.text])).toEqual(original);
    const second=await state.capture('capture',request,'user-B');expect(second.status).toBe(200);expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(2);
  });
  it.each(['reserve_charge','confirm_charge'])('lost %s acknowledgement cannot cause a second SDK charge on a fresh run',async operation=>{
    const state=fixture(),first=await actorRun(state,{lostAck:operation}),second=await actorRun(state,{runId:'restarted'});
    expect(first.error).toBeDefined();expect(first.actor.charge).toHaveBeenCalledTimes(operation==='reserve_charge'?0:1);expect(second.actor.charge).not.toHaveBeenCalled();
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
    expect(Boolean(second.error)).toBe(operation==='reserve_charge');
  });
  it('lost platform charge ACK preserves unknown with original proof available, never a new permission',async()=>{
    const state=fixture(),first=await actorRun(state,{chargeError:true}),second=await actorRun(state,{runId:'restarted'});
    expect(first.actor.charge).toHaveBeenCalledTimes(1);expect(second.actor.charge).not.toHaveBeenCalled();expect(second.error).toBeDefined();
    expect((await state.call('status')).body).toMatchObject({state:'complete',may_charge:false,billing:{state:'charge_unknown'}});
    expect(second.values.get('OUTPUT')).toEqual(first.values.get('OUTPUT'));expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });
  it('lost reservation storage ACK retains its marker on the original record without granting permission',async()=>{
    const state=fixture();await state.capture();const put=state.bucket.put.bind(state.bucket);let lost=false;
    state.bucket.put=async(key,value,options)=>{const result=await put(key,value,options);if(!lost&&String(value).includes('charge_unknown')){lost=true;throw new Error('synthetic put ACK loss');}return result;};
    expect((await state.call('reserve_charge',firstAttempt)).status).toBe(503);
    expect((await state.call('reserve_charge',secondAttempt)).body).toMatchObject({may_charge:false,billing:{state:'charge_unknown'}});
  });
  it('negative Guard is delivered and billed once without changing its decision or proof bytes',async()=>{
    const state=fixture(),input={product:'preflight',expected:{contains:['absent promise']}};
    const first=await actorRun(state,{input});expect(first.error).toBeUndefined();expect(first.values.get('OUTPUT')).toMatchObject({safe:false,changed:null});
    const artifacts=[...state.bucket.values].filter(([key])=>!key.startsWith('fulfillments/'));
    const second=await actorRun(state,{input});expect(second.error).toBeUndefined();expect(second.actor.charge).not.toHaveBeenCalled();
    expect([...state.bucket.values].filter(([key])=>!key.startsWith('fulfillments/'))).toEqual(artifacts);
  });
  it('missing original digest or corrupt billing evidence cannot become a new charging entitlement',async()=>{
    const state=fixture();await state.capture();const identity=await partnerBusinessIdentity('apify','user-A','business-001'),row=JSON.parse(state.bucket.values.get(identity.key)!.text);
    delete row.response_hash;await state.bucket.put(identity.key,JSON.stringify(row));
    expect((await state.call('reserve_charge',firstAttempt)).status).toBe(503);expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });
  it('stalled charge times out with original reservation unknown; late acknowledgement never confirms or appends',async()=>{
    vi.useFakeTimers();const state=fixture();let release!:(value:unknown)=>void;
    const charge=vi.fn(()=>new Promise(resolve=>{release=resolve;}));const pending=actorRun(state,{platform:{charge}});
    await vi.waitFor(()=>expect(charge).toHaveBeenCalledOnce());await vi.advanceTimersByTimeAsync(30_001);
    const first=await pending;expect(first.error).toBeDefined();release({chargedCount:1});await vi.advanceTimersByTimeAsync(1);
    expect(first.transport.mock.calls.some(([url,init])=>url.endsWith('/billing')&&JSON.parse(String(init.body)).operation==='confirm_charge')).toBe(false);
    expect(first.actor.pushData).not.toHaveBeenCalled();const next=await actorRun(state,{runId:'after-timeout'});
    expect(next.actor.charge).not.toHaveBeenCalled();expect((await state.call('status')).body).toMatchObject({billing:{state:'charge_unknown'}});
  });
  it('stalled OUTPUT storage never reserves or charges; its late response cannot resume the failed Actor',async()=>{
    vi.useFakeTimers();const state=fixture();let release!:(value:unknown)=>void;
    const setValue=vi.fn(()=>new Promise(resolve=>{release=resolve;}));const pending=actorRun(state,{platform:{setValue}});
    await vi.waitFor(()=>expect(setValue).toHaveBeenCalledOnce());await vi.advanceTimersByTimeAsync(30_001);const first=await pending;
    expect(first.error).toBeDefined();expect(first.actor.charge).not.toHaveBeenCalled();expect((await state.call('status')).body).toMatchObject({billing:{state:'unreserved'}});
    release(undefined);await vi.advanceTimersByTimeAsync(1);expect(first.actor.charge).not.toHaveBeenCalled();
    const next=await actorRun(state,{runId:'after-storage-timeout'});expect(next.error).toBeUndefined();expect(next.actor.charge).toHaveBeenCalledTimes(1);
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });
  it('late reservation put cannot return a charge permit after its coordinator deadline',async()=>{
    vi.useFakeTimers();const state=fixture();await state.capture();const put=state.bucket.put.bind(state.bucket);let release!:()=>void,seen=false;
    state.bucket.put=async(key,value,options)=>{
      if(String(value).includes('charge_unknown')){seen=true;return new Promise(resolve=>{release=()=>{void put(key,value,options).then(resolve);};});}
      return put(key,value,options);
    };
    const pending=state.call('reserve_charge',firstAttempt);await vi.waitFor(()=>expect(seen).toBe(true));await vi.advanceTimersByTimeAsync(15_001);
    const result=await pending;expect(result.status).toBe(503);expect(result.body).toMatchObject({may_charge:false,billing:{state:'unknown',platform_charged:null}});
    release();await vi.advanceTimersByTimeAsync(1);state.bucket.put=put;
    expect((await state.call('reserve_charge',secondAttempt)).body).toMatchObject({may_charge:false,billing:{state:'charge_unknown'}});
  });
});
