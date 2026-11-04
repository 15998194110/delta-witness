// Evidence custody and original-order accounting composition. This is not an
// order, funds or revenue ledger. Importing evidence cannot verify itself.
import type {RuntimeEnv} from './env';
import {sha256,stableJson,uuidFromDigest} from './crypto';
import {readOrderBinding} from './orders';
import {createClaim} from './claims';
import {createOrderReadSnapshot,readOrderMetadata} from './order-storage';
import {withinDeadline} from './deadline';
import {readCoreAccountingEvidence,deriveOrderAccounting,type AuditAttestation,type CoreAccountingEvidence} from './accounting';

export const FINANCIAL_SOURCE_PREFIX='operations/financial-evidence/sources/';
export const FINANCIAL_SOURCE_MAX_BYTES=32_000;
export const FINANCIAL_COST_CATEGORIES=['browser','storage','compute','reads_downloads','settlement','failed_attempts','platform','support','acquisition'] as const;
type Category=typeof FINANCIAL_COST_CATEGORIES[number];
const HASH=/^sha256:[0-9a-f]{64}$/,REF=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RAW=/^(0|[1-9][0-9]{0,77})$/;
const ORDER=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Notice={provider:'cloudflare';invoice_id:string;issued_at:string;amount_due_usd_raw:string|null;
  dkim_pass:boolean;dmarc_pass:boolean;invoice_items_available:false;order_allocation_available:false};
export type BillingEvent={event_id:string|null;invoice_id:string|null;occurred_at:string|null;currency:string|null;
  amount_original_raw:string|null;amount_to_pay_original_raw:string|null;status:string|null};
type History={provider:'cloudflare';account_ref:string;page:number;per_page:number;total_count:number|null;events:BillingEvent[];
  account_scope_only:true;invoice_items_available:false;order_allocation_available:false};
type DocumentReference={document_sha256:string;document_type:'buyer_contract'|'refund_ledger'|'cost_allocation';issuer_ref:string;order_id:string};
export type FinancialSource={schema:'delta-financial-source/v1';source_ref:string;observed_at:string;
  collection:'connected_gmail_metadata'|'authenticated_cloudflare_api'|'local_import'|'synthetic_fixture';
  kind:'invoice_notice'|'billing_history'|'order_audit'|'audit_support';payload:Notice|History|AuditAttestation|DocumentReference};
export type FinancialSourceEnvelope={schema:'delta-financial-source-envelope/v1';source_hash:string;source:FinancialSource};
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
function exact(x:unknown,names:string[]):x is Record<string,unknown>{return object(x)&&Object.keys(x).sort().join(',')===[...names].sort().join(',');}
const iso=(x:unknown):x is string=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const ref=(x:unknown):x is string=>typeof x==='string'&&REF.test(x);
const raw=(x:unknown):x is string=>typeof x==='string'&&RAW.test(x);
const integer=(x:unknown,min=0,max=Number.MAX_SAFE_INTEGER):x is number=>Number.isSafeInteger(x)&&Number(x)>=min&&Number(x)<=max;
function validAudit(x:unknown):x is AuditAttestation{
  if(!object(x)||Object.keys(x).some(k=>!['order_id','evidence_ref','buyer','refunds','costs','external_business_reference'].includes(k))||
    !ref(x.order_id)||!ref(x.evidence_ref)||!['independent_customer','owner_test','platform_test','unknown'].includes(String(x.buyer))||
    !exact(x.refunds,['coverage','raw_amount','evidence_ref'])||!ref(x.refunds.evidence_ref)||
    !['complete','unknown'].includes(String(x.refunds.coverage))||
    (x.refunds.coverage==='complete'?!raw(x.refunds.raw_amount):x.refunds.raw_amount!==null))return false;
  if(x.costs!==undefined&&(!object(x.costs)||Object.entries(x.costs).some(([category,cost])=>
    !FINANCIAL_COST_CATEGORIES.includes(category as Category)||!exact(cost,['raw_usdc','evidence_ref'])||!raw(cost.raw_usdc)||!ref(cost.evidence_ref))))return false;
  return x.external_business_reference===undefined||exact(x.external_business_reference,['namespace','id','contract_evidence_ref'])&&Object.values(x.external_business_reference).every(ref);
}
export function validateFinancialSource(value:unknown):value is FinancialSource{
  if(!exact(value,['schema','source_ref','observed_at','collection','kind','payload'])||value.schema!=='delta-financial-source/v1'||
    !ref(value.source_ref)||!iso(value.observed_at)||!['connected_gmail_metadata','authenticated_cloudflare_api','local_import','synthetic_fixture'].includes(String(value.collection)))return false;
  const p=value.payload;
  if(value.kind==='order_audit')return ['local_import','synthetic_fixture'].includes(String(value.collection))&&validAudit(p);
  if(value.kind==='audit_support')return ['local_import','synthetic_fixture'].includes(String(value.collection))&&
    exact(p,['document_sha256','document_type','issuer_ref','order_id'])&&typeof p.document_sha256==='string'&&HASH.test(p.document_sha256)&&
    ['buyer_contract','refund_ledger','cost_allocation'].includes(String(p.document_type))&&ref(p.issuer_ref)&&ref(p.order_id);
  if(value.kind==='invoice_notice')return exact(p,['provider','invoice_id','issued_at','amount_due_usd_raw','dkim_pass','dmarc_pass','invoice_items_available','order_allocation_available'])&&
    p.provider==='cloudflare'&&ref(p.invoice_id)&&iso(p.issued_at)&&Date.parse(p.issued_at)<=Date.parse(value.observed_at)&&
    (p.amount_due_usd_raw===null||raw(p.amount_due_usd_raw))&&typeof p.dkim_pass==='boolean'&&typeof p.dmarc_pass==='boolean'&&
    p.invoice_items_available===false&&p.order_allocation_available===false&&value.collection!=='authenticated_cloudflare_api';
  if(value.kind!=='billing_history'||!exact(p,['provider','account_ref','page','per_page','total_count','events','account_scope_only','invoice_items_available','order_allocation_available'])||
    p.provider!=='cloudflare'||typeof p.account_ref!=='string'||!HASH.test(p.account_ref)||!integer(p.page,1,10)||!integer(p.per_page,1,50)||
    p.total_count!==null&&!integer(p.total_count)||!Array.isArray(p.events)||p.events.length>p.per_page||
    p.account_scope_only!==true||p.invoice_items_available!==false||p.order_allocation_available!==false||value.collection==='connected_gmail_metadata')return false;
  return p.events.every(event=>exact(event,['event_id','invoice_id','occurred_at','currency','amount_original_raw','amount_to_pay_original_raw','status'])&&
    [event.event_id,event.invoice_id,event.status].every(v=>v===null||ref(v))&&
    (event.occurred_at===null||iso(event.occurred_at)&&Date.parse(event.occurred_at)<=Date.parse(value.observed_at as string))&&
    (event.currency===null||typeof event.currency==='string'&&/^[A-Z]{3,6}$/.test(event.currency))&&
    [event.amount_original_raw,event.amount_to_pay_original_raw].every(v=>v===null||raw(v)));
}
export async function financialSourceEnvelope(source:FinancialSource):Promise<FinancialSourceEnvelope>{
  if(!validateFinancialSource(source)||new TextEncoder().encode(stableJson(source)).byteLength>FINANCIAL_SOURCE_MAX_BYTES)throw new Error('invalid_financial_source');
  const envelope:FinancialSourceEnvelope={schema:'delta-financial-source-envelope/v1',source_hash:await sha256(stableJson(source)),source:structuredClone(source)};
  if(new TextEncoder().encode(stableJson(envelope)).byteLength>FINANCIAL_SOURCE_MAX_BYTES)throw new Error('financial_source_size_limit');
  return envelope;
}
export async function validateFinancialSourceEnvelope(value:unknown):Promise<boolean>{
  return exact(value,['schema','source_hash','source'])&&value.schema==='delta-financial-source-envelope/v1'&&typeof value.source_hash==='string'&&HASH.test(value.source_hash)&&
    validateFinancialSource(value.source)&&value.source_hash===await sha256(stableJson(value.source));
}
const sourceKey=(digest:string)=>{if(!HASH.test(digest))throw new Error('invalid_financial_source_hash');return `${FINANCIAL_SOURCE_PREFIX}${digest.slice(7)}.json`;};
export async function readFinancialSource(env:RuntimeEnv,digest:string):Promise<FinancialSourceEnvelope|null>{
  const saved=await readOrderMetadata<FinancialSourceEnvelope>(env,sourceKey(digest),FINANCIAL_SOURCE_MAX_BYTES);
  if(saved&&(!await validateFinancialSourceEnvelope(saved.record)||saved.record.source_hash!==digest))throw new Error('financial_source_inconsistent');
  return saved?.record??null;
}
// A conditional create followed by exact readback. Unknown writes are not
// retried under another key; an import never changes a financial balance.
export async function retainFinancialSource(env:RuntimeEnv,source:FinancialSource){
  const envelope=await financialSourceEnvelope(source),key=sourceKey(envelope.source_hash);
  const snapshot=createOrderReadSnapshot(env,FINANCIAL_SOURCE_MAX_BYTES);
  try{return await withinDeadline((async()=>{
    const original=await readFinancialSource(snapshot.env,envelope.source_hash);snapshot.assertActive();
    if(original)return{state:'retained' as const,source_hash:envelope.source_hash,replayed:true};
    try{await createClaim(snapshot.env,key,envelope);}catch{/* only original-key readback */}
    snapshot.assertActive();const actual=await readFinancialSource(snapshot.env,envelope.source_hash);snapshot.assertActive();
    return actual&&stableJson(actual)===stableJson(envelope)?{state:'retained' as const,source_hash:envelope.source_hash,replayed:false}:
      {state:'unconfirmed' as const,source_hash:envelope.source_hash,replayed:false};
  })(),20_000,'financial_source_deadline',snapshot.cancel);}finally{snapshot.cancel();}
}

// Number-to-money is deliberately loss-intolerant. No unknown precision is
// rounded into an invoice amount and no USD/USDC parity is assumed.
export function originalMoneyRaw(value:unknown):string|null{
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)return null;
  const text=String(value);if(!/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(text))return null;
  const [whole,decimals='']=text.split('.'),amount=BigInt(whole)*1_000_000n+BigInt(decimals.padEnd(6,'0'));
  return amount<=BigInt(Number.MAX_SAFE_INTEGER)&&Number(amount)/1e6===value?amount.toString():null;
}
async function readProviderJson(response:Response,signal:AbortSignal):Promise<unknown>{
  if(!response.body)throw new Error('billing_body_missing');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try{while(true){const item=await reader.read();if(signal.aborted)throw new Error('billing_deadline');if(item.done)break;
    size+=item.value.byteLength;if(size>1_000_000)throw new Error('billing_body_limit');chunks.push(item.value);}
    const bytes=new Uint8Array(size);let cursor=0;for(const chunk of chunks){bytes.set(chunk,cursor);cursor+=chunk.byteLength;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));
  }finally{signal.removeEventListener('abort',cancel);cancel();reader.releaseLock();}
}
export async function collectCloudflareBillingHistory(input:{account_id:string;token:string;max_pages?:number},dependencies:{fetch?:typeof fetch;now?:()=>number}={}){
  if(!/^[0-9a-f]{32}$/.test(input.account_id)||typeof input.token!=='string'||!input.token||input.token.length>4096||/[\r\n]/.test(input.token)||
    input.max_pages!==undefined&&!integer(input.max_pages,1,10))throw new Error('billing_configuration_invalid');
  const controller=new AbortController(),now=dependencies.now??Date.now,request=dependencies.fetch??fetch;
  const sources:FinancialSourceEnvelope[]=[];let complete=false,nextPage:number|null=1;
  try{await withinDeadline((async()=>{
    const accountRef=await sha256(`cloudflare-account/v1\n${input.account_id}`),perPage=50,maxPages=input.max_pages??3;
    let expectedTotal:number|undefined;const eventIds=new Set<string>();
    for(let page=1;page<=maxPages;page++){
      if(controller.signal.aborted)throw new Error('billing_deadline');
      const response=await request(`https://api.cloudflare.com/client/v4/accounts/${input.account_id}/billing/history?page=${page}&per_page=${perPage}`,
        {method:'GET',redirect:'error',headers:{authorization:`Bearer ${input.token}`,accept:'application/json'},signal:controller.signal});
      if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});throw new Error('billing_deadline');}
      if(response.status!==200){void response.body?.cancel().catch(()=>{});throw new Error('billing_provider_unavailable');}
      const body=await readProviderJson(response,controller.signal);if(!object(body)||body.success!==true||!Array.isArray(body.result)||body.result.length>perPage)throw new Error('billing_response_invalid');
      const observed=new Date(now()).toISOString(),safeRef=(v:unknown)=>ref(v)?v:null;
      const events=body.result.map(value=>{
        if(!object(value))throw new Error('billing_response_invalid');
        const time=typeof value.occurred_at==='string'&&Number.isFinite(Date.parse(value.occurred_at))?new Date(value.occurred_at).toISOString():null;
        return{event_id:safeRef(value.id),invoice_id:safeRef(value.invoice_id??value.external_invoice_id),occurred_at:time&&Date.parse(time)<=Date.parse(observed)?time:null,
          currency:typeof value.currency==='string'&&/^[A-Z]{3,6}$/.test(value.currency)?value.currency:null,
          amount_original_raw:originalMoneyRaw(value.amount),amount_to_pay_original_raw:originalMoneyRaw(value.amount_to_pay),status:safeRef(value.status)};
      });
      const info=object(body.result_info)?body.result_info:null;
      if(info&&(info.page!==page||info.per_page!==perPage||info.count!==events.length||!integer(info.total_count)||info.total_count<(page-1)*perPage+events.length))throw new Error('billing_pagination_invalid');
      if(info){if(expectedTotal!==undefined&&expectedTotal!==info.total_count)throw new Error('billing_listing_drift');expectedTotal=Number(info.total_count);}
      for(const event of events){if(event.event_id&&eventIds.has(event.event_id))throw new Error('billing_duplicate_event');if(event.event_id)eventIds.add(event.event_id);}
      const source:FinancialSource={schema:'delta-financial-source/v1',source_ref:`cloudflare-billing-history-page-${page}`,observed_at:observed,
        collection:'authenticated_cloudflare_api',kind:'billing_history',payload:{provider:'cloudflare',account_ref:accountRef,page,per_page:perPage,total_count:info?Number(info.total_count):null,
          events,account_scope_only:true,invoice_items_available:false,order_allocation_available:false}};
      sources.push(await financialSourceEnvelope(source));
      nextPage=page+1;if(info&&page*perPage>=Number(info.total_count)){complete=true;nextPage=null;break;}
      // Without provider pagination evidence an empty/short page is not all-time completeness.
      if(!info){nextPage=null;break;}
    }
  })(),20_000,'billing_collection_deadline',()=>controller.abort());
    return{schema:'delta-billing-collection/v1',state:complete?'provider_window_observed':'partial',sources,provider_listing_complete:complete,next_page:nextPage,
      invoice_line_items_verified:false,actual_order_costs_verified:false,actual_variable_cost_raw:null};
  }catch{return{schema:'delta-billing-collection/v1',state:'unavailable',sources,provider_listing_complete:false,next_page:nextPage,
    invoice_line_items_verified:false,actual_order_costs_verified:false,actual_variable_cost_raw:null};}finally{controller.abort();}
}

export type FinancialSupportGraph={support_hash:string;buyer_source_hash:string|null;refund_source_hash:string|null;cost_source_hashes:Partial<Record<Category,string|null>>};
export type FinancialAuditVerification={source_hash:string;support_hash:string;verified_at:string;evidence_ref:string;buyer_purpose_verified:boolean;
  refund_coverage_verified:boolean;cost_categories_verified:Category[]};
export type FinancialAuditVerifier=(input:{source:FinancialSourceEnvelope;all_sources:readonly FinancialSourceEnvelope[];resolved_support:FinancialSupportGraph;as_of:string})=>Promise<FinancialAuditVerification|null>;
// This callback is an internal trust boundary, not a JSON flag or buyer input.
// Its production implementation must independently check original invoices,
// documented allocation/FX, refund completeness and purpose sources. The
// currently available CF history/notice adapters cannot supply that evidence.
export async function readFinancialAccounting(env:RuntimeEnv,input:{as_of?:string;order_ids:string[];source_hashes:string[];treasury_checkpoint:unknown|null},verify?:FinancialAuditVerifier){
  if(input.as_of!==undefined&&(!iso(input.as_of)||Date.parse(input.as_of)>Date.now())||!Array.isArray(input.order_ids)||!input.order_ids.length||input.order_ids.length>5||
    input.order_ids.some(id=>!ORDER.test(id))||new Set(input.order_ids).size!==input.order_ids.length||
    !Array.isArray(input.source_hashes)||input.source_hashes.length>50||input.source_hashes.some(h=>!HASH.test(h))||new Set(input.source_hashes).size!==input.source_hashes.length)throw new Error('financial_scope_invalid');
  const snapshots=new Set<ReturnType<typeof createOrderReadSnapshot>>();let active=true;
  const asOf=()=>input.as_of??new Date().toISOString();
  const check=()=>{if(!active)throw new Error('financial_join_deadline');};
  const stop=()=>{active=false;for(const snapshot of snapshots)snapshot.cancel();};
  try{return await withinDeadline((async()=>{
  const sources:FinancialSourceEnvelope[]=[];const missing:string[]=[],sourceDeadline=Date.now()+10_000;
  for(const hash of input.source_hashes){check();if(Date.now()>=sourceDeadline){missing.push(hash);continue;}
    const sourceSnapshot=createOrderReadSnapshot(env,FINANCIAL_SOURCE_MAX_BYTES);snapshots.add(sourceSnapshot);let source:FinancialSourceEnvelope|null=null;
    try{source=await withinDeadline(readFinancialSource(sourceSnapshot.env,hash),Math.min(2_000,Math.max(1,sourceDeadline-Date.now())),'financial_source_read_deadline',sourceSnapshot.cancel);}
    catch{/* a cost source outage must not erase the separately readable order facts */}
    finally{sourceSnapshot.cancel();snapshots.delete(sourceSnapshot);}check();
    if(!source||Date.parse(source.source.observed_at)>Date.parse(asOf()))missing.push(hash);else sources.push(source);}
  const audits:AuditAttestation[]=[],qualifications:{source_hash:string;support_hash:string;state:'unverified'|'partially_verified'|'qualified';evidence_ref:string|null}[]=[];
  const seen=new Set<string>();
  for(const source of sources){if(source.source.kind!=='order_audit')continue;
    const candidate=source.source.payload as AuditAttestation;if(!input.order_ids.includes(candidate.order_id))throw new Error('financial_audit_outside_scope');
    if(seen.has(candidate.order_id))throw new Error('financial_audit_conflict');seen.add(candidate.order_id);
    const resolveSupport=(reference:string,type:DocumentReference['document_type']):string|null=>{
      // A digest always means a canonical source identity, never an alias.
      // Aliases must be unique across the whole selected source set before
      // type/order filtering; duplicate issuers/documents cannot be guessed.
      const matches=sources.filter(s=>HASH.test(reference)?s.source_hash===reference:s.source.source_ref===reference);
      if(matches.length!==1||matches[0].source.kind!=='audit_support')return null;
      const document=matches[0].source.payload as DocumentReference;
      return document.document_type===type&&document.order_id===candidate.order_id?matches[0].source_hash:null;
    };
    const supportEdges={buyer_source_hash:resolveSupport(candidate.evidence_ref,'buyer_contract'),refund_source_hash:resolveSupport(candidate.refunds.evidence_ref,'refund_ledger'),
      cost_source_hashes:Object.fromEntries(Object.entries(candidate.costs??{}).map(([category,cost])=>[category,resolveSupport(cost!.evidence_ref,'cost_allocation')]))};
    const resolvedSupport:FinancialSupportGraph={...supportEdges,support_hash:await sha256(stableJson({schema:'delta-financial-support-graph/v1',audit_source_hash:source.source_hash,...supportEdges}))};
    check();
    let approval:FinancialAuditVerification|null=null;
    // Missing dependencies fail closed; neither an invoice email nor a billing
    // history amount may be used as automatic proof of per-order allocation.
    if(verify&&!missing.length)try{check();const decision=await withinDeadline(verify({source:structuredClone(source),all_sources:structuredClone(sources),resolved_support:structuredClone(resolvedSupport),as_of:asOf()}),2_000,'financial_verifier_deadline');check();
      if(decision&&exact(decision,['source_hash','support_hash','verified_at','evidence_ref','buyer_purpose_verified','refund_coverage_verified','cost_categories_verified'])&&
        decision.source_hash===source.source_hash&&decision.support_hash===resolvedSupport.support_hash&&iso(decision.verified_at)&&Date.parse(decision.verified_at)>=Date.parse(source.source.observed_at)&&Date.parse(decision.verified_at)<=Date.parse(asOf())&&
        ref(decision.evidence_ref)&&typeof decision.buyer_purpose_verified==='boolean'&&typeof decision.refund_coverage_verified==='boolean'&&
        Array.isArray(decision.cost_categories_verified)&&new Set(decision.cost_categories_verified).size===decision.cost_categories_verified.length&&
        decision.cost_categories_verified.every(c=>FINANCIAL_COST_CATEGORIES.includes(c)))approval=decision;
    }catch{/* an unavailable verifier is not evidence */}
    const buyerVerified=approval?.buyer_purpose_verified===true&&resolvedSupport.buyer_source_hash!==null;
    const refundVerified=approval?.refund_coverage_verified===true&&resolvedSupport.refund_source_hash!==null;
    const costEntries=Object.entries(candidate.costs??{}).filter(([category])=>approval?.cost_categories_verified.includes(category as Category)&&!!resolvedSupport.cost_source_hashes[category as Category]);
    const qualified=buyerVerified&&refundVerified&&FINANCIAL_COST_CATEGORIES.every(c=>costEntries.some(([category])=>category===c));
    qualifications.push({source_hash:source.source_hash,support_hash:resolvedSupport.support_hash,state:qualified?'qualified':approval?'partially_verified':'unverified',evidence_ref:approval?.evidence_ref??null});
    audits.push({...candidate,buyer:buyerVerified?candidate.buyer:'unknown',
      refunds:refundVerified?candidate.refunds:{coverage:'unknown',raw_amount:null,evidence_ref:candidate.refunds.evidence_ref},
      costs:Object.fromEntries(costEntries)});
  }
  const orders:CoreAccountingEvidence[]=[];for(const id of input.order_ids){check();
    const snapshot=createOrderReadSnapshot(env,FINANCIAL_SOURCE_MAX_BYTES);snapshots.add(snapshot);
    // The outer snapshot cancels original reader continuations too. Artifact
    // permission is derived from the original binding, never caller proof IDs.
    try{const order=await withinDeadline((async()=>{
      let binding:Awaited<ReturnType<typeof readOrderBinding>>=null;
      try{binding=await readOrderBinding(snapshot.env,id);}catch{/* original reader below preserves unknown */}check();snapshot.assertActive();
      if(binding)snapshot.allowArtifactsFor(uuidFromDigest(await sha256(`${binding.payment_fingerprint}\n${binding.product}`)));
      return readCoreAccountingEvidence(snapshot.env,id);
    })(),7_000,'financial_order_read_deadline',snapshot.cancel);check();orders.push(order);}
    catch{check();orders.push({order_id:id,source:'core_original_records',state:'unknown',read_at:new Date().toISOString(),payment_authorized:'unknown',settlement_confirmed:'unknown',delivered:'unknown'});}
    finally{snapshot.cancel();snapshots.delete(snapshot);}}
  const effectiveAsOf=asOf(),accounting=await deriveOrderAccounting({as_of:effectiveAsOf,orders,treasury_checkpoint:input.treasury_checkpoint,attestations:audits});
  // Evidence review, not an executor or an authorization to spend. A selected
  // positive order never establishes complete inventory/channel economics.
  const negative=accounting.rows.filter(r=>r.actual_contribution_margin_raw!==null&&BigInt(r.actual_contribution_margin_raw)<0n).map(r=>r.order_id);
  const unknown=accounting.rows.filter(r=>r.recognized_customer_revenue_raw===null||r.actual_variable_cost_raw===null||r.actual_contribution_margin_raw===null).map(r=>r.order_id);
  const nonpositive=accounting.rows.filter(r=>r.actual_contribution_margin_raw!==null&&BigInt(r.actual_contribution_margin_raw)<=0n).map(r=>r.order_id);
  const expansionGate={schema:'delta-selected-economics-gate/v1',decision:negative.length?'block_negative_margin':'hold',
    scope:'selected_orders_only_not_global_inventory',as_of:effectiveAsOf,accounting_view_hash:accounting.view_hash,
    reasons:[...(negative.length?['evidenced_negative_margin']:[]),...(unknown.length?['actual_economics_unknown']:[]),
      ...(!negative.length&&nonpositive.length?['positive_margin_not_demonstrated']:[]),
      ...(sources.some(s=>s.source.collection==='synthetic_fixture')?['synthetic_evidence_not_commercial_validation']:[]),'inventory_and_external_gates_not_verified'],
    negative_margin_order_ids:negative,unknown_economics_order_ids:unknown,
    selected_positive_economics:unknown.length===0&&nonpositive.length===0&&accounting.rows.length>0,
    mutates_pricing:false,blocks_original_paid_fulfillment:false,authorizes_spend:false};
  check();return{schema:'delta-financial-evidence-view/v1',authority:'original_accounting_derivation_not_a_second_ledger',as_of:effectiveAsOf,requested_as_of:input.as_of??null,
    evidence_environment:sources.some(s=>s.source.collection==='synthetic_fixture')?'synthetic_not_customer_activity':'selected_source_observations_only',
    selected_order_ids:[...input.order_ids],inventory_complete:false,all_time_verified:false,source_hashes:[...input.source_hashes],missing_sources:missing,
    source_observations:sources.map(s=>({source_hash:s.source_hash,kind:s.source.kind,collection:s.source.collection,observed_at:s.source.observed_at})),
    audit_qualifications:qualifications,source_verifier_configured:!!verify,expansion_gate:expansionGate,accounting};
  })(),60_000,'financial_join_deadline',stop);}finally{stop();}
}
