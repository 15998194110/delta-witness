import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeltaWitness } from '../packages/js-client/src/index.js';
import { app } from '../src/index';
import { readCoreAccountingEvidence, deriveOrderAccounting } from '../src/accounting';
import { verifyExportedBundle } from '../src/export-verification';
import { MemoryBucket, orderRuntime, mockOrderNetwork, orderPayment, TEST_ORDER_ID, TEST_PAYER } from './helpers/order-runtime';
// @ts-ignore shared existing receipt validation module, synthetic receipt only
import { normalizeLogs, NETWORK, USDC, TREASURY, TRANSFER_TOPIC, TO_TOPIC } from '../scripts/treasury-reconciliation.mjs';

afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.restoreAllMocks();});
describe('synthetic customer-business correlation contract (not Invoica/PayAgentic schema)',()=>{
  it('separates one business reference from service authorization, original order, proof, export and canonical receipt',async()=>{
    const at='2026-11-02T00:00:00.000Z';vi.setSystemTime(new Date(at));
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),network=mockOrderNetwork();vi.stubGlobal('fetch',network);
    const records=new Map<string,any>();
    const store={load:async(id:string)=>structuredClone(records.get(id)??null),
      compareAndSet:async(id:string,revision:number|null,value:unknown)=>{
        if((records.get(id)?.revision??null)!==revision)return false;records.set(id,structuredClone(value));return true;
      }};
    const plain=(url:string,init?:RequestInit)=>app.fetch(new Request(url,init),env);
    const client=new DeltaWitness({baseUrl:'https://delta.test',fetchImpl:plain,orderStore:store});
    // Buyer-owned business mapping is private application data, never a Core
    // payment header, capability, provider invoice schema or public proof field.
    const business={namespace:'synthetic-procurement',id:'fixture-invoice-001',contract_evidence_ref:'fixture-contract-only-v1'};
    const quote:any=await client.quote('capture');expect(quote.price).toBe('$1');expect(quote.economics.grossPriceUsd).toBe(1);
    await client.prepareOrder('capture',{url:'https://example.com/'},{orderId:TEST_ORDER_ID});
    let authorizations=0;
    const paid=async(url:string,init?:RequestInit)=>{
      expect((await plain(url,init)).status).toBe(402);
      authorizations++;
      const headers=new Headers(init?.headers);headers.set('payment-signature',Buffer.from(JSON.stringify(orderPayment())).toString('base64'));
      return plain(url,{...init,headers});
    };
    const delivered=await client.executeOrder(TEST_ORDER_ID,paid);
    const queried=await client.recoverOrder(TEST_ORDER_ID);expect(queried).toEqual(delivered);
    const [manifest,html,markdown,screenshot]=await Promise.all(['manifest','html','markdown','screenshot'].map(kind=>client.exportArtifact(TEST_ORDER_ID,kind as any)));
    const verified=await verifyExportedBundle({manifest:manifest.bytes,html:html.bytes,markdown:markdown.bytes,screenshot:screenshot.bytes},delivered.delivery!.bundle_root);
    expect(verified).toMatchObject({ok:true,proof_id:delivered.delivery!.proof_id});
    const order=await readCoreAccountingEvidence(env,TEST_ORDER_ID);
    const tx=`0x${'12'.repeat(32)}`,blockHash=`0x${'ab'.repeat(32)}`;
    const transfers=normalizeLogs([{removed:false,address:USDC,transactionHash:tx,blockHash,blockNumber:'0x64',logIndex:'0x0',
      topics:[TRANSFER_TOPIC,`0x${TEST_PAYER.slice(2).padStart(64,'0')}`,TO_TOPIC],data:`0x${(1000000n).toString(16).padStart(64,'0')}`}],90,110);
    const checkpoint={schema:'delta-treasury-checkpoint/v1',network:NETWORK,asset:USDC,treasury:TREASURY,origin_block:90,checked_through_block:110,
      confirmation_depth:1,checked_at:at,checked_through_hash:blockHash,reorg_anchor:{number:100,hash:blockHash},corrections:[],transfers};
    const result=await deriveOrderAccounting({as_of:at,orders:[order],treasury_checkpoint:checkpoint,attestations:[{
      order_id:TEST_ORDER_ID,buyer:'independent_customer',evidence_ref:'synthetic-customer-purpose',
      refunds:{coverage:'complete',raw_amount:'0',evidence_ref:'synthetic-refund-coverage'},external_business_reference:business}]});
    expect(result.rows[0]).toMatchObject({order_id:TEST_ORDER_ID,proof_id:delivered.delivery!.proof_id,service_fee_tx:tx,
      external_business_reference:business,recognized_customer_revenue_raw:'1000000',actual_contribution_margin_raw:null});
    expect(JSON.stringify(delivered)).not.toContain(business.id);
    expect(JSON.stringify(manifest)).not.toContain(business.id);
    expect(authorizations).toBe(1);expect(network.mock.calls.filter(([url])=>String(url).endsWith('/settle'))).toHaveLength(1);
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });
  it('an external invoice reference grants neither service use nor private export and cannot create revenue',async()=>{
    const env=orderRuntime(new MemoryBucket());vi.stubGlobal('fetch',mockOrderNetwork());
    const response=await app.fetch(new Request('https://delta.test/v1/capture',{method:'POST',headers:{'content-type':'application/json','x-external-invoice-id':'fixture-invoice-001'},body:JSON.stringify({url:'https://example.com/'})}),env);
    expect(response.status).toBe(402);expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
    const exported=await app.fetch(new Request(`https://delta.test/v1/orders/${TEST_ORDER_ID}/artifacts/html`,{headers:{'x-external-invoice-id':'fixture-invoice-001'}}),env);
    expect(exported.status).toBe(404);
    const projection=await deriveOrderAccounting({as_of:'2026-11-02T00:00:00.000Z',orders:[],treasury_checkpoint:null});
    expect(projection.recognized_customer_revenue_raw).toBeNull();
  });
});
