import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {app} from '../src/index';
import {retainFinancialSource,readFinancialSource,financialSourceEnvelope,validateFinancialSource,readFinancialAccounting,
  collectCloudflareBillingHistory,originalMoneyRaw,FINANCIAL_COST_CATEGORIES,type FinancialSource,type FinancialAuditVerifier} from '../src/financial-evidence';
import {MemoryBucket,orderRuntime,orderRequest,mockOrderNetwork,TEST_ORDER_ID,TEST_PAYER} from './helpers/order-runtime';
// @ts-ignore original canonical validator, not a duplicate financial algorithm
import {normalizeLogs,NETWORK,USDC,TREASURY,TRANSFER_TOPIC,TO_TOPIC} from '../scripts/treasury-reconciliation.mjs';
const asOf='2026-11-04T00:00:00.000Z',observed='2026-11-03T23:59:59.000Z',tx=`0x${'12'.repeat(32)}`,blockHash=`0x${'ab'.repeat(32)}`;
const notice=():FinancialSource=>({schema:'delta-financial-source/v1',source_ref:'fixture-invoice-notice',observed_at:observed,collection:'synthetic_fixture',kind:'invoice_notice',
  payload:{provider:'cloudflare',invoice_id:'SYNTHETIC-INVOICE',issued_at:'2026-10-30T14:05:56.000Z',amount_due_usd_raw:'0',dkim_pass:true,dmarc_pass:true,invoice_items_available:false,order_allocation_available:false}});
const audit=():FinancialSource=>({schema:'delta-financial-source/v1',source_ref:'fixture-audit',observed_at:observed,collection:'synthetic_fixture',kind:'order_audit',payload:{
  order_id:TEST_ORDER_ID,buyer:'independent_customer',evidence_ref:'fixture-buyer',refunds:{coverage:'complete',raw_amount:'0',evidence_ref:'fixture-refunds'},
  costs:Object.fromEntries(FINANCIAL_COST_CATEGORIES.map(c=>[c,{raw_usdc:'100',evidence_ref:'fixture-allocation'}]))}});
const support=(kind:'buyer_contract'|'refund_ledger'|'cost_allocation',reference:string):FinancialSource=>({schema:'delta-financial-source/v1',source_ref:reference,
  observed_at:observed,collection:'synthetic_fixture',kind:'audit_support',payload:{document_sha256:`sha256:${'a'.repeat(64)}`,document_type:kind,issuer_ref:'fixture-source-system',order_id:TEST_ORDER_ID}});
function checkpoint(){return{schema:'delta-treasury-checkpoint/v1',network:NETWORK,asset:USDC,treasury:TREASURY,origin_block:90,checked_through_block:110,
  confirmation_depth:1,checked_at:asOf,checked_through_hash:blockHash,reorg_anchor:{number:100,hash:blockHash},corrections:[],transfers:normalizeLogs([{removed:false,address:USDC,transactionHash:tx,blockHash,blockNumber:'0x64',logIndex:'0x0',
    topics:[TRANSFER_TOPIC,`0x${TEST_PAYER.slice(2).padStart(64,'0')}`,TO_TOPIC],data:`0x${(1_000_000n).toString(16).padStart(64,'0')}`}],90,110)};}
async function fixture(sources:FinancialSource[]=[audit(),support('buyer_contract','fixture-buyer'),support('refund_ledger','fixture-refunds'),support('cost_allocation','fixture-allocation')]){
  const bucket=new MemoryBucket(),env=orderRuntime(bucket),network=mockOrderNetwork();vi.stubGlobal('fetch',network);
  expect((await app.fetch(orderRequest(),env)).status).toBe(200);network.mockClear();vi.mocked(env.BROWSER.quickAction).mockClear();
  const hashes=[];for(const source of sources)hashes.push((await retainFinancialSource(env,source)).source_hash);
  const input={as_of:asOf,order_ids:[TEST_ORDER_ID],source_hashes:hashes,treasury_checkpoint:checkpoint()};
  return{bucket,env,network,input};
}
const verifier:FinancialAuditVerifier=async({source,resolved_support})=>({source_hash:source.source_hash,support_hash:resolved_support.support_hash,verified_at:asOf,evidence_ref:'fixture-independent-verifier',buyer_purpose_verified:true,
  refund_coverage_verified:true,cost_categories_verified:[...FINANCIAL_COST_CATEGORIES]});
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(asOf);});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('retains immutable source digest and same bytes on replay without creating a financial fact',async()=>{
  const bucket=new MemoryBucket(),env=orderRuntime(bucket),source=notice();const first=await retainFinancialSource(env,source),before=bucket.sequence;
  expect(first.state).toBe('retained');expect(await retainFinancialSource(env,source)).toMatchObject({replayed:true,source_hash:first.source_hash});
  expect(bucket.sequence).toBe(before);expect((await readFinancialSource(env,first.source_hash))?.source).toEqual(source);
});
it('lost source-create ACK reads the exact original digest and never resends',async()=>{
  const bucket=new MemoryBucket(),env=orderRuntime(bucket),put=bucket.put.bind(bucket),write=vi.fn(async(...args:Parameters<typeof put>)=>{await put(...args);throw new Error('synthetic_unknown');});
  bucket.put=write;expect((await retainFinancialSource(env,notice())).state).toBe('retained');expect(write).toHaveBeenCalledTimes(1);
});
it('imported audit assertions do not verify themselves or turn unknown expenses into zero',async()=>{
  const f=await fixture(),before=f.bucket.sequence;const result=await readFinancialAccounting(f.env,f.input);
  expect(result.accounting.rows[0]).toMatchObject({treasury_received:'confirmed',delivered:'confirmed',recognized_customer_revenue_raw:null,refund_raw:null,actual_variable_cost_raw:null,actual_contribution_margin_raw:null});
  expect(result.audit_qualifications[0].state).toBe('unverified');expect(result.inventory_complete).toBe(false);expect(f.bucket.sequence).toBe(before);expect(f.network).not.toHaveBeenCalled();
});
it('verified exact-source audit composes the original accounting kernel with separate costs/refunds/revenue',async()=>{
  const f=await fixture(),before=f.bucket.sequence,result=await readFinancialAccounting(f.env,f.input,verifier);
  expect(result.evidence_environment).toBe('synthetic_not_customer_activity');expect(result.accounting.rows[0]).toMatchObject({treasury_received_raw:'1000000',recognized_customer_revenue_raw:'1000000',
    actual_variable_cost_raw:'700',actual_contribution_margin_raw:'999300',operating_profit_raw:'999100',counted_customer_transactions:1});
  expect(result.accounting.rows[0].service_fee_tx).toBe(tx);expect(result.audit_qualifications[0].state).toBe('qualified');expect(f.bucket.sequence).toBe(before);
  expect(f.network).not.toHaveBeenCalled();expect(f.env.BROWSER.quickAction).not.toHaveBeenCalled();
});
it('an invoice notification with zero due cannot certify cost, refund coverage or customer purpose even if a verifier is mistaken',async()=>{
  const candidate=audit();Object.assign(candidate.payload,{evidence_ref:'fixture-invoice-notice',refunds:{coverage:'complete',raw_amount:'0',evidence_ref:'fixture-invoice-notice'},
    costs:Object.fromEntries(FINANCIAL_COST_CATEGORIES.map(c=>[c,{raw_usdc:'0',evidence_ref:'fixture-invoice-notice'}]))});
  const f=await fixture([notice(),candidate]),view=await readFinancialAccounting(f.env,f.input,verifier);
  expect(view.accounting.rows[0]).toMatchObject({recognized_customer_revenue_raw:null,actual_variable_cost_raw:null,actual_contribution_margin_raw:null,refund_raw:null});
});
it('each actual category requires its own qualified reference; incomplete invoices cannot produce margin',async()=>{
  const candidate=audit();delete (candidate.payload as any).costs.failed_attempts;const f=await fixture([candidate,support('buyer_contract','fixture-buyer'),support('refund_ledger','fixture-refunds'),support('cost_allocation','fixture-allocation')]);
  expect((await readFinancialAccounting(f.env,f.input,verifier)).accounting.rows[0]).toMatchObject({recognized_customer_revenue_raw:'1000000',actual_variable_cost_raw:null,actual_contribution_margin_raw:null});
});
it.each(['document-digest','issuer','duplicate-observation'] as const)('ambiguous allocation alias fails unknown (%s)',async difference=>{
  const original=support('cost_allocation','fixture-allocation'),other=structuredClone(original);
  if(difference==='document-digest')(other.payload as any).document_sha256=`sha256:${'b'.repeat(64)}`;
  if(difference==='issuer')(other.payload as any).issuer_ref='different-issuer';
  if(difference==='duplicate-observation')other.observed_at='2026-11-03T23:59:58.000Z';
  const f=await fixture([audit(),support('buyer_contract','fixture-buyer'),support('refund_ledger','fixture-refunds'),original,other]);
  const verify=vi.fn(verifier),view=await readFinancialAccounting(f.env,f.input,verify);
  expect(view.accounting.rows[0]).toMatchObject({recognized_customer_revenue_raw:'1000000',actual_variable_cost_raw:null,actual_contribution_margin_raw:null});
  expect(view.audit_qualifications[0].state).toBe('partially_verified');
  expect(Object.values(verify.mock.calls[0][0].resolved_support.cost_source_hashes)).toEqual(FINANCIAL_COST_CATEGORIES.map(()=>null));
});
it('an alias conflict is rejected before filtering document type or order scope',async()=>{
  const conflicting=support('refund_ledger','fixture-buyer');(conflicting.payload as any).order_id='another-order';
  const f=await fixture([audit(),support('buyer_contract','fixture-buyer'),support('refund_ledger','fixture-refunds'),support('cost_allocation','fixture-allocation'),conflicting]);
  const view=await readFinancialAccounting(f.env,f.input,verifier);
  expect(view.accounting.rows[0]).toMatchObject({recognized_customer_revenue_raw:null,actual_variable_cost_raw:'700',actual_contribution_margin_raw:null});
});
it('canonical hash references uniquely select their exact document despite duplicate or hash-shaped aliases',async()=>{
  const original=support('cost_allocation','fixture-allocation'),other=structuredClone(original);(other.payload as any).issuer_ref='different-issuer';
  const hash=(await financialSourceEnvelope(original)).source_hash,candidate=audit();
  for(const cost of Object.values((candidate.payload as any).costs) as any[])cost.evidence_ref=hash;
  const spoof=notice();spoof.source_ref=hash;
  const f=await fixture([candidate,support('buyer_contract','fixture-buyer'),support('refund_ledger','fixture-refunds'),original,other,spoof]);
  const verify=vi.fn(verifier),view=await readFinancialAccounting(f.env,f.input,verify);
  expect(view.accounting.rows[0]).toMatchObject({actual_variable_cost_raw:'700',actual_contribution_margin_raw:'999300'});
  expect(view.audit_qualifications[0].state).toBe('qualified');
  expect(Object.values(verify.mock.calls[0][0].resolved_support.cost_source_hashes)).toEqual(FINANCIAL_COST_CATEGORIES.map(()=>hash));
});
it('approval for an unchanged audit cannot be replayed after its uniquely resolved support document changes',async()=>{
  const original=support('cost_allocation','fixture-allocation'),f=await fixture();let oldApproval:Awaited<ReturnType<FinancialAuditVerifier>>=null;
  const capture:FinancialAuditVerifier=async input=>{oldApproval=await verifier(input);return oldApproval;};
  expect((await readFinancialAccounting(f.env,f.input,capture)).audit_qualifications[0].state).toBe('qualified');
  const replacement=structuredClone(original);(replacement.payload as any).document_sha256=`sha256:${'b'.repeat(64)}`;
  const originalHash=(await financialSourceEnvelope(original)).source_hash,newHash=(await retainFinancialSource(f.env,replacement)).source_hash;
  f.input.source_hashes=f.input.source_hashes.map(hash=>hash===originalHash?newHash:hash);
  const replay:FinancialAuditVerifier=async()=>oldApproval;
  const view=await readFinancialAccounting(f.env,f.input,replay);
  expect(view.audit_qualifications[0].state).toBe('unverified');expect(view.accounting.rows[0]).toMatchObject({recognized_customer_revenue_raw:null,actual_variable_cost_raw:null,actual_contribution_margin_raw:null});
});
it('missing/future source dependencies prevent verification and retain explicit missing scope',async()=>{
  const f=await fixture();f.input.source_hashes.push(`sha256:${'b'.repeat(64)}`);const approve=vi.fn(verifier);
  const result=await readFinancialAccounting(f.env,f.input,approve);expect(approve).not.toHaveBeenCalled();expect(result.missing_sources).toHaveLength(1);expect(result.accounting.recognized_customer_revenue_raw).toBeNull();
});
it.each(['wrong-hash','wrong-support-hash','future','duplicate-category','throws'] as const)('invalid source verification is independently unknown (%s)',async kind=>{
  const f=await fixture();const verify:FinancialAuditVerifier=async input=>{if(kind==='throws')throw Error('provider text must not escape');const value=(await verifier(input))!;
    if(kind==='wrong-hash')value.source_hash=`sha256:${'b'.repeat(64)}`;if(kind==='wrong-support-hash')value.support_hash=`sha256:${'c'.repeat(64)}`;if(kind==='future')value.verified_at='2027-01-01T00:00:00.000Z';if(kind==='duplicate-category')value.cost_categories_verified.push('browser');return value;};
  const result=await readFinancialAccounting(f.env,f.input,verify);expect(result.accounting.recognized_customer_revenue_raw).toBeNull();expect(JSON.stringify(result)).not.toContain('provider text');
});
it('contradictory audits and corrupted archive fail closed, without changing original order records',async()=>{
  const f=await fixture([audit(),{...audit(),source_ref:'contradictory-audit'}]);await expect(readFinancialAccounting(f.env,f.input)).rejects.toThrow('financial_audit_conflict');
  const key=[...f.bucket.values.keys()].find(k=>k.startsWith('operations/financial-evidence/'))!;const value=JSON.parse(f.bucket.values.get(key)!.text);value.source.unexpected='not allowed';await f.bucket.put(key,JSON.stringify(value));
  await expect(readFinancialSource(f.env,value.source_hash)).rejects.toThrow('financial_source_inconsistent');
});
it.each([0,20.99,1.000001])('keeps exact original-currency six-decimal amount %s',value=>expect(originalMoneyRaw(value)).toBe((BigInt(String(value).split('.')[0])*1000000n+BigInt((String(value).split('.')[1]??'').padEnd(6,'0'))).toString()));
it.each([undefined,NaN,Infinity,-1,1e20,0.0000001,'20.99'])('unknown precision or unsupported invoice amount %s remains null',value=>expect(originalMoneyRaw(value)).toBeNull());
it('authenticated API adapter makes fixed GET only, drops private hosted invoice URLs, and keeps USD distinct from USDC',async()=>{
  const request=vi.fn(async()=>Response.json({success:true,result:[{id:'event-1',invoice_id:'fixture-invoice',currency:'USD',amount:20.99,amount_to_pay:0,status:'paid',occurred_at:observed,
    hosted_invoice_url:'https://private.invalid/?token=never-archive',description:'PII must not pass'}],result_info:{page:1,per_page:50,count:1,total_count:1}}));
  const result=await collectCloudflareBillingHistory({account_id:'a'.repeat(32),token:'synthetic-billing-token'},{fetch:request as any});
  expect(request.mock.calls).toHaveLength(1);const [url,options]=(request.mock.calls[0] as unknown as [string,RequestInit]);expect(url).toContain('https://api.cloudflare.com/client/v4/accounts/');
  expect(options).toMatchObject({method:'GET',redirect:'error'});expect(result).toMatchObject({state:'provider_window_observed',provider_listing_complete:true,actual_variable_cost_raw:null,actual_order_costs_verified:false});
  expect((result.sources[0].source.payload as any).events[0]).toMatchObject({currency:'USD',amount_original_raw:'20990000',amount_to_pay_original_raw:'0'});
  expect(JSON.stringify(result)).not.toMatch(/synthetic-billing-token|never-archive|PII must not pass/);expect(validateFinancialSource(result.sources[0].source)).toBe(true);
});
it.each([302,401,429,500])('provider status %s is unavailable, never a zero expense',async status=>{
  const result=await collectCloudflareBillingHistory({account_id:'a'.repeat(32),token:'fixture'},{fetch:vi.fn(async()=>new Response('provider private text',{status})) as any});
  expect(result).toMatchObject({state:'unavailable',provider_listing_complete:false,actual_variable_cost_raw:null});expect(JSON.stringify(result)).not.toContain('provider private text');
});
it('missing pagination evidence is partial even for an empty successful page',async()=>{
  const result=await collectCloudflareBillingHistory({account_id:'a'.repeat(32),token:'fixture'},{fetch:vi.fn(async()=>Response.json({success:true,result:[]})) as any});
  expect(result).toMatchObject({state:'partial',provider_listing_complete:false,actual_variable_cost_raw:null});
});
it.each(['duplicate-event','total-drift'] as const)('pagination %s cannot assert complete billing evidence',async kind=>{
  let page=0;const request=vi.fn(async()=>{page++;return Response.json({success:true,
    result:page===1?Array.from({length:50},(_,i)=>({id:`event-${i}`,currency:'USD',amount:1})): [{id:kind==='duplicate-event'?'event-0':'event-50',currency:'USD',amount:1}],
    result_info:{page,per_page:50,count:page===1?50:1,total_count:page===2&&kind==='total-drift'?52:51}});});
  const result=await collectCloudflareBillingHistory({account_id:'a'.repeat(32),token:'fixture'},{fetch:request as any});
  expect(result).toMatchObject({state:'unavailable',provider_listing_complete:false,actual_variable_cost_raw:null});expect(result.sources).toHaveLength(1);
});
it('oversized provider bodies are canceled, not copied to the evidence archive',async()=>{
  const result=await collectCloudflareBillingHistory({account_id:'a'.repeat(32),token:'fixture'},{fetch:vi.fn(async()=>new Response('x'.repeat(1000001))) as any});
  expect(result.state).toBe('unavailable');expect(result.sources).toEqual([]);
});
it('a hung cost source is isolated; the separately readable original receipt and delivery remain available',async()=>{
  const f=await fixture(),get=f.bucket.get.bind(f.bucket);let entered!:()=>void,release!:(value:any)=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;});let once=true;
  f.bucket.get=async key=>{if(once&&key.startsWith('operations/financial-evidence/')){once=false;entered();return new Promise(resolve=>{release=resolve;});}return get(key);};
  vi.useFakeTimers();const {as_of:_historicalCut,...currentInput}=f.input;
  const pending=readFinancialAccounting(f.env,currentInput,verifier);await ready;await vi.advanceTimersByTimeAsync(2001);
  const result=await pending;expect(result.missing_sources).toHaveLength(1);expect(result.accounting.rows[0]).toMatchObject({treasury_received:'confirmed',delivered:'confirmed',recognized_customer_revenue_raw:null,actual_variable_cost_raw:null});
  expect(result.requested_as_of).toBeNull();expect(Date.parse(result.as_of)).toBeGreaterThan(Date.parse(asOf));
  const before=JSON.stringify(result);release(null);await vi.advanceTimersByTimeAsync(0);expect(JSON.stringify(result)).toBe(before);expect(f.network).not.toHaveBeenCalled();
});
it('body-read deadline cancels the provider stream and leaves listing/cost unknown',async()=>{
  vi.useFakeTimers();let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;}),cancel=vi.fn();
  const request=vi.fn(async()=>{entered();return new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel}));});
  const pending=collectCloudflareBillingHistory({account_id:'a'.repeat(32),token:'fixture'},{fetch:request as any});await ready;await vi.advanceTimersByTimeAsync(20001);
  expect((await pending).state).toBe('unavailable');expect(cancel).toHaveBeenCalled();expect(request).toHaveBeenCalledTimes(1);
});
it('a total API deadline stops late pagination and never archives credentials or late data',async()=>{
  vi.useFakeTimers();let release!:(response:Response)=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
  const request=vi.fn(()=>new Promise<Response>(resolve=>{release=resolve;entered();}));
  const pending=collectCloudflareBillingHistory({account_id:'a'.repeat(32),token:'fixture'},{fetch:request as any});await ready;await vi.advanceTimersByTimeAsync(20001);
  const result=await pending;expect(result.state).toBe('unavailable');release(Response.json({success:true,result:[],result_info:{page:1,per_page:50,count:0,total_count:0}}));
  await vi.advanceTimersByTimeAsync(0);expect(request).toHaveBeenCalledTimes(1);expect(result.sources).toEqual([]);
});
it('an extra credential/provider-text field cannot enter the evidence archive',async()=>{
  expect(validateFinancialSource({...notice(),secret:'do-not-retain'})).toBe(false);
  await expect(financialSourceEnvelope({...notice(),payload:{...(notice().payload as any),url:'https://secret.invalid'}})).rejects.toThrow('invalid_financial_source');
});
