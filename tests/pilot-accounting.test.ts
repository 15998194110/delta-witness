import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { deriveOrderAccounting, readPilotAccountingEvidence, type AuditAttestation } from '../src/accounting';
import { sha256, stableJson } from '../src/crypto';
import { MemoryBucket, mockOrderNetwork, orderRequest, orderRuntime, TEST_PAYER } from './helpers/order-runtime';
// @ts-ignore original read-only checkpoint validator
import { normalizeLogs, NETWORK, USDC, TREASURY, TRANSFER_TOPIC, TO_TOPIC } from '../scripts/treasury-reconciliation.mjs';

const asOf='2026-11-02T00:00:00.000Z',tx='0x'+'12'.repeat(32),blockHash='0x'+'ab'.repeat(32);
function checkpoint() {
  const transfers=normalizeLogs([{removed:false,address:USDC,transactionHash:tx,blockHash,blockNumber:'0x64',logIndex:'0x0',
    topics:[TRANSFER_TOPIC,`0x${TEST_PAYER.slice(2).padStart(64,'0')}`,TO_TOPIC],data:`0x${10000000n.toString(16).padStart(64,'0')}`}],90,110);
  return {schema:'delta-treasury-checkpoint/v1',network:NETWORK,asset:USDC,treasury:TREASURY,origin_block:90,checked_through_block:110,
    confirmation_depth:1,checked_at:asOf,checked_through_hash:blockHash,reorg_anchor:{number:100,hash:blockHash},corrections:[],transfers};
}
beforeEach(()=>{vi.setSystemTime(new Date(asOf));vi.spyOn(console,'error').mockImplementation(()=>undefined);});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
async function fixture(count=2) {
  const bucket=new MemoryBucket(),env=orderRuntime(bucket),network=mockOrderNetwork();
  vi.stubGlobal('fetch',vi.fn(async(url:string|URL|Request)=>String(url).startsWith('https://example.com/')?new Response('',{status:200}):network(url)));
  const browser=vi.mocked(env.BROWSER.quickAction),original=browser.getMockImplementation()!;
  browser.mockImplementation(async(...args)=>{
    const response=await original(...args),data=await response.json() as any;data.meta.finalUrl=(args[1] as any).url;
    return Response.json(data,{headers:{'x-browser-ms-used':'1'}});
  });
  const body={urls:Array.from({length:count},(_,index)=>`https://example.com/page${index}`),preflight:{url_index:0,expected:{contains:['unmet original condition']}}};
  const request=()=>orderRequest({product:'guarded-action-pilot',legacy:true,body});
  const response=await app.fetch(request(),env);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({price_usd:10,preflight:{safe:false}});
  const key=[...bucket.values.keys()].find(value=>value.startsWith('guarded-pilot/'))!,record=JSON.parse(bucket.values.get(key)!.text);
  const settlementKey=[...bucket.values.keys()].find(value=>value.startsWith('settlements/'))!;
  const identity={payment_fingerprint:record.payment_fingerprint,settlement_key:settlementKey};
  const audit:AuditAttestation={order_id:`pilot:${record.payment_fingerprint.slice(7)}`,buyer:'independent_customer',evidence_ref:'fixture-business-purpose',
    refunds:{coverage:'complete',raw_amount:'0',evidence_ref:'fixture-refund-coverage'}};
  return {bucket,env,network,browser,request,key,record,settlementKey,identity,audit};
}
async function view(f:Awaited<ReturnType<typeof fixture>>, overrides:Record<string,unknown>={}) {
  const order=await readPilotAccountingEvidence(f.env,f.identity);
  return deriveOrderAccounting({as_of:asOf,orders:[order],treasury_checkpoint:checkpoint(),attestations:[f.audit],...overrides});
}
async function rehashResponse(record:any) {
  record.response_hash=await sha256(`delta-pilot-response/v1\n${stableJson({request_hash:record.request_hash,payment_fingerprint:record.payment_fingerprint,response:record.response})}`);
}

describe('one original Pilot package in the existing accounting projection, synthetic only',()=>{
  it.each([1,2,3])('%s pages and repeated original delivery recognize at most one 10USDC receipt, never per-page sales',async count=>{
    const f=await fixture(count);expect((await app.fetch(f.request(),f.env)).status).toBe(200);
    const before=structuredClone([...f.bucket.values.entries()]),networkCalls=f.network.mock.calls.length;
    const evidence=await readPilotAccountingEvidence(f.env,f.identity);
    expect(evidence).toMatchObject({state:'verified',product:'guarded_action_pilot',payment_authorized:'confirmed',settlement_confirmed:'confirmed',delivered:'confirmed',amount_raw:'10000000'});
    const report=await view(f,{orders:[evidence,structuredClone(evidence)]});
    expect(report.rows).toHaveLength(1);expect(report.rows[0]).toMatchObject({treasury_received_raw:'10000000',recognized_customer_revenue_raw:'10000000',counted_customer_transactions:1,
      actual_variable_cost_raw:null,actual_contribution_margin_raw:null,proof_id:null});
    expect(report.rows[0].child_proofs).toHaveLength(count);expect(report.recognized_customer_revenue_raw).toBe('10000000');
    expect(f.network.mock.calls.filter(([url])=>String(url).endsWith('/settle'))).toHaveLength(1);expect(f.network.mock.calls).toHaveLength(networkCalls);
    expect(f.browser).toHaveBeenCalledTimes(count);expect([...f.bucket.values.entries()]).toEqual(before);
  });
  it('reads a historical basis-absent negative Pilot aggregate without modifying its response or original digest',async()=>{
    const f=await fixture();delete f.record.response.economics.basis;await rehashResponse(f.record);await f.bucket.put(f.key,JSON.stringify(f.record));
    const before=structuredClone([...f.bucket.values.entries()]);
    expect((await view(f)).rows[0]).toMatchObject({delivered:'confirmed',recognized_customer_revenue_raw:'10000000'});
    expect([...f.bucket.values.entries()]).toEqual(before);
  });
  it.each(['response-hash','amount','basis','proof','observation-cost','artifact'] as const)
  ('a corrupt %s cannot become delivered income even if settlement and Treasury cash exist',async kind=>{
    const f=await fixture();
    if(kind==='response-hash')f.record.response_hash='sha256:'+'0'.repeat(64);
    if(kind==='amount')f.record.response.price_usd=1;
    if(kind==='basis')f.record.response.economics.basis='actual-cost';
    if(kind==='proof')f.record.response.proofs[0].bundle_root='sha256:'+'0'.repeat(64);
    if(kind==='observation-cost'){
      const page=f.record.progress.pages[0];page.observation.variable_cost_usd=0;
      page.observation_hash=await sha256(`delta-pilot-page/v1\n${stableJson({request_hash:f.record.request_hash,payment_fingerprint:f.record.payment_fingerprint,
        index:page.index,url:page.url,fingerprint:page.fingerprint,observation:page.observation})}`);
    }
    if(kind==='artifact')await f.bucket.put([...f.bucket.values.keys()].find(key=>key.endsWith('/page.md'))!,'tampered');
    if(kind!=='response-hash')await rehashResponse(f.record);
    await f.bucket.put(f.key,JSON.stringify(f.record));const before=structuredClone([...f.bucket.values.entries()]);
    expect((await view(f)).rows[0]).toMatchObject({settlement_confirmed:'confirmed',treasury_received:'confirmed',delivered:'unknown',recognized_customer_revenue_raw:null,
      settled_pending_delivery_gross_raw:'10000000',received_pending_delivery_raw:'10000000'});
    expect([...f.bucket.values.entries()]).toEqual(before);
  });
  it('a saved response with no final completion is an original delivery liability, not revenue',async()=>{
    const f=await fixture();f.record.state='processing';await f.bucket.put(f.key,JSON.stringify(f.record));
    const report=await view(f);expect(report.rows[0]).toMatchObject({delivered:'unknown',recognized_customer_revenue_raw:null,received_pending_delivery_raw:'10000000'});
  });
  it.each(['amount','fingerprint','request','network','missing-payer','unknown'] as const)
  ('missing or mismatched original settlement %s cannot be repaired from a Treasury balance',async kind=>{
    const f=await fixture(),settlement=JSON.parse(f.bucket.values.get(f.settlementKey)!.text);
    if(kind==='amount')settlement.amount='1';if(kind==='fingerprint')settlement.payment_fingerprint='sha256:'+'0'.repeat(64);
    if(kind==='request')settlement.request_hash='sha256:'+'0'.repeat(64);if(kind==='network')settlement.result.network='eip155:84532';
    if(kind==='missing-payer')delete settlement.result.payer;
    if(kind==='unknown'){settlement.state='settlement_unknown';delete settlement.result;}
    await f.bucket.put(f.settlementKey,JSON.stringify(settlement));const before=structuredClone([...f.bucket.values.entries()]);
    expect((await view(f)).rows[0]).toMatchObject({treasury_received:'unknown',recognized_customer_revenue_raw:null,actual_contribution_margin_raw:null});
    expect([...f.bucket.values.entries()]).toEqual(before);
  });
  it.each(['owner_test','platform_test','unknown'] as const)('%s purpose never creates independent customer revenue',async buyer=>{
    const f=await fixture();f.audit.buyer=buyer;
    const report=await view(f);expect(report.rows[0].recognized_customer_revenue_raw).toBeNull();expect(report.rows[0].actual_contribution_margin_raw).toBeNull();
    if(buyer!=='unknown')expect(report.rows[0].counted_customer_transactions).toBe(0);
  });
  it('two projected aliases competing for the same receipt are not two Pilot sales',async()=>{
    const f=await fixture(),evidence=await readPilotAccountingEvidence(f.env,f.identity);
    const report=await view(f,{orders:[evidence,{...evidence,order_id:'fixture-alias',settlement_key:'settlements/'+'a'.repeat(64)+'.json'}]});
    expect(report.rows.every(row=>row.recognized_customer_revenue_raw===null)).toBe(true);expect(report.recognized_customer_revenue_raw).toBeNull();
  });
  it('one package cost attestation applies once; missing platform or failed-attempt invoices keep profit unknown',async()=>{
    const f=await fixture();f.audit.costs=Object.fromEntries(['browser','storage','compute','reads_downloads','settlement','failed_attempts','platform'].map(key=>[key,{raw_usdc:'100',evidence_ref:`fixture-${key}-invoice`}]));
    expect((await view(f)).rows[0]).toMatchObject({actual_variable_cost_raw:'700',actual_contribution_margin_raw:'9999300'});
    delete f.audit.costs!.failed_attempts;expect((await view(f)).rows[0].actual_contribution_margin_raw).toBeNull();
  });
  it('offline CLI joins original Pilot inventory once and rejects conflicting journal aliases without any live access',async()=>{
    const f=await fixture(3),before=structuredClone([...f.bucket.values.entries()]);
    const network=vi.fn(async()=>{throw new Error('offline accounting cannot use provider');});vi.stubGlobal('fetch',network);
    // @ts-ignore import-safe offline adapter
    const {evaluateLocalAccounting}=await import('../scripts/query-order-accounting.mjs');
    const input={schema:'delta-local-accounting-input/v1',as_of:asOf,order_ids:[],pilot_orders:[f.identity,f.identity],
      objects:[...f.bucket.values.entries()].map(([key,value])=>({key,base64:Buffer.from(value.bytes??new TextEncoder().encode(value.text)).toString('base64')})),
      treasury_checkpoint:checkpoint(),attestations:[f.audit]};
    const report=await evaluateLocalAccounting(input);expect(report.rows).toHaveLength(1);expect(report.rows[0]).toMatchObject({delivered:'confirmed',recognized_customer_revenue_raw:'10000000'});
    expect(report.rows[0].child_proofs).toHaveLength(3);expect(network).not.toHaveBeenCalled();expect([...f.bucket.values.entries()]).toEqual(before);
    await expect(evaluateLocalAccounting({...input,pilot_orders:[f.identity,{...f.identity,settlement_key:'settlements/'+'a'.repeat(64)+'.json'}]})).rejects.toThrow('conflicting_pilot_accounting_identity');
  });
});
