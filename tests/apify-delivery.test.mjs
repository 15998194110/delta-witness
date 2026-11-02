import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, describe, it, expect, vi } from 'vitest';

const source = readFileSync(new URL('../channels/apify/main.mjs',import.meta.url),'utf8').replace('import { Actor } from "apify";','const Actor = mockActor;');
const proof={ok:true,product:'capture',proof_id:'56347db8-1aa5-447f-a0e4-3bb052d7aa89',
  public_proof_url:'https://delta-witness-api.ruphussten.workers.dev/p/56347db8-1aa5-447f-a0e4-3bb052d7aa89',
  manifest_url:'https://delta-witness-api.ruphussten.workers.dev/v1/proofs/56347db8-1aa5-447f-a0e4-3bb052d7aa89',
  bundle_root:'sha256:'+'a'.repeat(64),observed_at:'2026-10-03T12:00:00Z'};
const capabilities={schema:'delta-partner-billing/v1',enabled:true,business_order_id_required:true,trusted_user_id_required:true,
  charge_permission:'one_winning_original_fulfillment_cas',platform_settlement_verified:false};
function envelope(business,product,record,extra={}) {
  const state=record?.state??'unreserved';
  return {ok:!!record,schema:'delta-partner-billing/v1',business_order_id:business,product,state:record?'complete':'order_not_found',may_charge:false,
    billing:{state,event_name:'proof-created',platform_charged:state==='platform_charged'?true:state==='charge_unknown'?null:false,
      assurance:'partner_adapter_assertion_only',settlement_confirmed:null,treasury_received:null,net_payout_usd:null,revenue_usd:null},
    ...(record?{delivery:record.delivery}:{}),...extra};
}
async function simulate(status=200,result=proof,options={}) {
  const state=options.state??new Map(),gateway=options.gateway??new Map();
  const actor={init:vi.fn(),exit:vi.fn(),isAtHome:()=>options.atHome??true,
    getInput:async()=>({url:'https://example.com',product:'capture',business_order_id:'business-001',...options.input}),
    getChargingManager:()=>({getPricingInfo:()=>({isPayPerEvent:true,perEventPrices:{'proof-created':options.eventPrice??2,'apify-default-dataset-item':options.datasetPrice??0}}),
      calculateMaxEventChargeCountWithinLimit:()=>options.budget??1}),getEnv:()=>({actorRunId:options.runId??'offline-run-001'}),
    getValue:vi.fn(async key=>{if(options.stateError)throw new Error('fixture-secret KVS error');return state.get(key)??null;}),
    setValue:vi.fn(async(key,value)=>{state.set(key,structuredClone(value));}),
    charge:vi.fn(async()=>{if(options.chargeError)throw new Error('fixture-secret charge ACK lost');return {chargedCount:options.chargedCount??1};}),
    pushData:vi.fn(async()=>{if(options.pushError)throw new Error('fixture-secret dataset ACK lost');})};
  for(const [name,implementation] of Object.entries(options.platform??{}))actor[name]=vi.fn(implementation);
  let captures=0;
  const fetchMock=vi.fn(async(url,init={})=>{
    if(options.fetchError)throw new Error('fixture-secret upstream URL token');
    if(url.endsWith('/capabilities')) return Response.json(options.capabilities??capabilities,{status:options.capabilityStatus??200});
    const match=/\/business\/([^/]+)\/(capture|preflight)(\/billing)?$/.exec(url);
    if(!match)throw new Error('Unexpected mock endpoint');
    const [,business,product,billing]=match, key=init.headers['x-delta-partner-user']+'/'+business;
    const raw=JSON.parse(init.body),requestIdentity=JSON.stringify(billing?raw.request:raw);
    let record=gateway.get(key);
    if(record&&record.requestIdentity!==requestIdentity)return Response.json({error:'identity_conflict'},{status:409});
    if(!billing){
      captures++;
      if(options.fetchImpl)return options.fetchImpl(url,init);
      if(status===200)gateway.set(key,{state:'unreserved',delivery:result,requestIdentity});
      return Response.json(result,{status});
    }
    if(raw.operation==='status')return Response.json(envelope(business,product,record),{status:record?200:404});
    // An intercepted slow capture still creates this synthetic original result.
    if(!record){record={state:'unreserved',delivery:result,requestIdentity};gateway.set(key,record);}
    if(raw.operation==='reserve_charge'){
      if(record.state!=='unreserved')return Response.json(envelope(business,product,record));
      record.state='charge_unknown';record.attempt_id=raw.attempt_id;
      if(options.reserveAckLost)throw new Error('fixture-secret reservation ACK lost');
      return Response.json(envelope(business,product,record,{may_charge:true,attempt_id:raw.attempt_id}));
    }
    if(raw.operation==='confirm_charge'){
      if(record.attempt_id!==raw.attempt_id)return Response.json({},{status:409});
      record.state='platform_charged';
      if(options.confirmAckLost)throw new Error('fixture-secret confirmation ACK lost');
      return Response.json(envelope(business,product,record));
    }
    throw new Error('Unexpected mock operation');
  });
  let error;const log=vi.fn();
  try{await vm.runInNewContext(`(async()=>{${source}})()`,{mockActor:actor,fetch:fetchMock,URL,Response,AbortController,setTimeout,clearTimeout,crypto,
    process:{env:{DELTA_PARTNER_GATEWAY_URL:'https://gateway.test',DELTA_PARTNER_SECRET:'fixture-secret',APIFY_USER_ID:'fixture-user',...options.env}},console:{log}});}catch(e){error=e;}
  return {actor,fetchMock,error,state,gateway,captures,log};
}
afterEach(()=>vi.useRealTimers());

describe('Apify original-business billing coordination',()=>{
  it('charges one permitted proof with exact SDK count after Core reservation and keeps settlement unknown',async()=>{
    const run=await simulate();expect(run.error).toBeUndefined();expect(run.actor.charge).toHaveBeenCalledWith({eventName:'proof-created',count:1});
    expect(run.actor.pushData).toHaveBeenCalledWith(proof);expect(run.captures).toBe(1);expect(run.state.get('OUTPUT')).toEqual(proof);
    expect(run.fetchMock.mock.calls.map(([url])=>url)).toEqual(['https://gateway.test/business/capabilities','https://gateway.test/business/business-001/capture/billing',
      'https://gateway.test/business/business-001/capture','https://gateway.test/business/business-001/capture/billing','https://gateway.test/business/business-001/capture/billing']);
  });
  it('a new run with the same user and business ID reads completed proof without charge or capture',async()=>{
    const gateway=new Map();const first=await simulate(200,proof,{gateway,runId:'first-run'});
    const next=await simulate(200,proof,{gateway,runId:'second-run'});
    expect(first.error).toBeUndefined();expect(next.error).toBeUndefined();expect(next.actor.charge).not.toHaveBeenCalled();
    expect(next.actor.pushData).not.toHaveBeenCalled();expect(next.captures).toBe(0);expect(next.state.get('OUTPUT')).toEqual(proof);
  });
  it.each(['chargeError','reserveAckLost'])('%s never permits a new charge in a later run',async failure=>{
    const gateway=new Map();const first=await simulate(200,proof,{gateway,[failure]:true});
    const next=await simulate(200,proof,{gateway,runId:'new-run'});
    expect(first.error).toBeDefined();expect(next.error?.message).toContain('reconciliation');expect(next.captures).toBe(0);expect(next.actor.charge).not.toHaveBeenCalled();
    expect(first.actor.charge).toHaveBeenCalledTimes(failure==='chargeError'?1:0);
  });
  it.each(['confirmAckLost','pushError'])('%s recovers OUTPUT without repeating a successful charge or dataset append',async failure=>{
    const gateway=new Map();const first=await simulate(200,proof,{gateway,[failure]:true});const next=await simulate(200,proof,{gateway,runId:'new-run'});
    expect(first.actor.charge).toHaveBeenCalledTimes(1);expect(first.error).toBeDefined();expect(next.error).toBeUndefined();
    expect(next.actor.charge).not.toHaveBeenCalled();expect(next.actor.pushData).not.toHaveBeenCalled();expect(next.state.get('OUTPUT')).toEqual(proof);
  });
  it('two runs using one original business order can invoke the charge callback only once',async()=>{
    const gateway=new Map();const runs=await Promise.all([simulate(200,proof,{gateway,runId:'a-run'}),simulate(200,proof,{gateway,runId:'b-run'})]);
    expect(runs.reduce((n,r)=>n+r.actor.charge.mock.calls.length,0)).toBe(1);
  });
  it('changed payload for the same business ID cannot capture or bill again',async()=>{
    const gateway=new Map();await simulate(200,proof,{gateway});const next=await simulate(200,proof,{gateway,input:{url:'https://different.test'}});
    expect(next.error).toBeDefined();expect(next.captures).toBe(0);expect(next.actor.charge).not.toHaveBeenCalled();
  });
  it.each([{capabilityStatus:404},{capabilities:{...capabilities,enabled:false}}])('old/disabled Core fails before capture and charge',async options=>{
    const run=await simulate(200,proof,options);expect(run.captures).toBe(0);expect(run.actor.charge).not.toHaveBeenCalled();expect(run.error?.message).toContain('billing_coordination_unavailable');
  });
  it.each([{input:{business_order_id:undefined}},{env:{APIFY_USER_ID:undefined}},{input:{product:'guarded-action-pilot'}},{env:{DELTA_PARTNER_GATEWAY_URL:'http://gateway.test'}}])('invalid identity/config never calls Core',async options=>{
    const run=await simulate(200,proof,options);expect(run.fetchMock).not.toHaveBeenCalled();expect(run.actor.charge).not.toHaveBeenCalled();
  });
  it.each([{eventPrice:0.04},{budget:0},{budget:NaN},{datasetPrice:0.01},{atHome:false}])('unapproved price/budget/implicit dataset charge prevents capture',async options=>{
    const run=await simulate(200,proof,options);expect(run.captures).toBe(0);expect(run.actor.charge).not.toHaveBeenCalled();expect(run.error?.message).toContain('pricing_not_authorized');
  });
  it('negative Preflight remains completed and charged once',async()=>{
    const decision={...proof,product:'preflight',safe:false,changed:true};const run=await simulate(200,decision,{input:{product:undefined}});
    expect(run.error).toBeUndefined();expect(run.actor.pushData).toHaveBeenCalledWith(decision);expect(run.actor.charge).toHaveBeenCalledOnce();
  });
  it('partial charge ACK does not confirm or permit recovery charge',async()=>{
    const gateway=new Map();await simulate(200,proof,{gateway,chargedCount:0});const next=await simulate(200,proof,{gateway});
    expect(next.actor.charge).not.toHaveBeenCalled();expect(next.error?.message).toContain('charge_outcome_unconfirmed');
  });
  it.each(['fetchError','chargeError','pushError','stateError'])('redacts %s',async failure=>{
    const run=await simulate(200,proof,{[failure]:true});expect(run.error?.message).not.toContain('fixture-secret');expect(run.actor.exit).toHaveBeenCalledWith({exitCode:1});
  });
  it.each([[202,{ok:false,state:'processing'}],[200,{ok:true}],[503,{}],[200,{...proof,manifest_url:'https://attacker.test'}],[200,{...proof,reason:{secret:'fixture-secret'}}],[200,{...proof,idempotent_replay:'yes'}]])('does not charge malformed/incomplete capture HTTP%s',async(status,result)=>{
    const run=await simulate(status,result);expect(run.actor.charge).not.toHaveBeenCalled();expect(run.actor.pushData).not.toHaveBeenCalled();expect(run.error?.message).toContain('delivery_unconfirmed');
  });
  it('allowlists valid complete metadata before OUTPUT, dataset and logs, including nested diff fields',async()=>{
    const upstream={...proof,provider_secret:'fixture-sensitive-extra',diff:{missing_text:[],excluded_text_found:[],hash_changes:[],provider_secret:'fixture-sensitive-extra'}};
    const gateway=new Map(),first=await simulate(200,upstream,{gateway}),next=await simulate(200,upstream,{gateway,runId:'different-run'});
    expect(first.error).toBeUndefined();expect(next.error).toBeUndefined();
    for(const run of [first,next]) {
      expect(JSON.stringify(run.state.get('OUTPUT'))).not.toContain('fixture-sensitive-extra');
      expect(JSON.stringify(run.actor.pushData.mock.calls)).not.toContain('fixture-sensitive-extra');
      expect(JSON.stringify(run.log.mock.calls)).not.toContain('fixture-sensitive-extra');
      expect(run.state.get('OUTPUT')).toEqual({...proof,diff:{missing_text:[],excluded_text_found:[],hash_changes:[]}});
    }
  });
  it('keeps a historical uncertain marker and refuses to create a replacement business order',async()=>{
    const state=new Map([['DELTA-PROOF-CHARGE-offline-run-001',{state:'charge_unknown'}]]);const run=await simulate(200,proof,{state});
    expect(run.fetchMock).not.toHaveBeenCalled();expect(run.actor.charge).not.toHaveBeenCalled();expect(state.get('DELTA-PROOF-CHARGE-offline-run-001')).toEqual({state:'charge_unknown'});
  });
  it('preserves completed historical same-run result without adding business identity or charge',async()=>{
    const requestIdentity=JSON.stringify({payload:{external_request_id:'offline-run-001',url:'https://example.com'},product:'capture'});
    const state=new Map([['DELTA-PROOF-CHARGE-offline-run-001',{state:'complete',requestIdentity,result:proof}]]);
    const run=await simulate(200,proof,{state,input:{business_order_id:undefined}});expect(run.error).toBeUndefined();expect(run.fetchMock).not.toHaveBeenCalled();expect(run.actor.charge).not.toHaveBeenCalled();
  });
  it('accepts a 35-second original capture within its deadline',async()=>{
    vi.useFakeTimers();const fetchImpl=vi.fn(()=>new Promise(resolve=>setTimeout(()=>resolve(Response.json(proof)),35_000)));
    const pending=simulate(200,proof,{fetchImpl});await vi.waitFor(()=>expect(fetchImpl).toHaveBeenCalledOnce());await vi.advanceTimersByTimeAsync(35_000);
    expect((await pending).error).toBeUndefined();
  });
  it('bounds a noncooperative capture and never bills its late result',async()=>{
    vi.useFakeTimers();let release;const fetchImpl=vi.fn(()=>new Promise(resolve=>{release=resolve;}));const pending=simulate(200,proof,{fetchImpl});
    await vi.waitFor(()=>expect(fetchImpl).toHaveBeenCalledOnce());await vi.advanceTimersByTimeAsync(120_001);const run=await pending;
    expect(run.error?.message).toContain('delivery_unconfirmed');expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    release(Response.json(proof));await vi.advanceTimersByTimeAsync(1);expect(run.actor.charge).not.toHaveBeenCalled();
  });
  it('bounds stalled or oversized response bodies without charging',async()=>{
    const oversized=await simulate(200,proof,{fetchImpl:async()=>new Response('x'.repeat(1_048_577))});expect(oversized.actor.charge).not.toHaveBeenCalled();
    vi.useFakeTimers();const cancel=vi.fn(),fetchImpl=vi.fn(async()=>new Response(new ReadableStream({cancel})));const pending=simulate(200,proof,{fetchImpl});
    await vi.waitFor(()=>expect(fetchImpl).toHaveBeenCalledOnce());await vi.advanceTimersByTimeAsync(120_001);const stalled=await pending;
    expect(cancel).toHaveBeenCalledOnce();expect(stalled.actor.charge).not.toHaveBeenCalled();
  });
  it.each(['init','getInput','getValue','setValue','pushData','exit'])('bounds an uncooperative platform %s without repeating it',async method=>{
    vi.useFakeTimers();let release;
    const operation=vi.fn(()=>new Promise(resolve=>{release=resolve;}));
    const pending=simulate(200,proof,{platform:{[method]:operation}});
    await vi.waitFor(()=>expect(operation).toHaveBeenCalledOnce());await vi.advanceTimersByTimeAsync(30_001);
    const run=await pending;expect(run.error).toBeDefined();expect(operation).toHaveBeenCalledOnce();
    const calls=run.actor.charge.mock.calls.length;release();await vi.advanceTimersByTimeAsync(1);
    expect(run.actor.charge).toHaveBeenCalledTimes(calls);
    if(['init','getInput','getValue','setValue'].includes(method))expect(calls).toBe(0);
  });
});
