// Concrete Resend transport. No registration, default destination, environment
// secret loading, scheduler activation or automatic quota upgrade occurs here.
import type {RuntimeEnv} from './env';
import {sha256,stableJson} from './crypto';
import {createClaim,commitClaim,type StoredClaim} from './claims';
import {createOrderReadSnapshot,readOrderMetadata} from './order-storage';
import {withinDeadline} from './deadline';
import {readOperatingAlert,validOperatingNotification,type AlertAdapter,type AlertObservation,type AlertReceipt} from './operating-alert-outbox';

export const RESEND_ALERT_PREFIX='operations/alerts/resend/';
const API='https://api.resend.com';
const MAX_BODY=131072,MAX_RECORD=16000,MAX_PAGES=2,REQUEST_MS=2000;
type Identity=Pick<AlertReceipt,'notification_id'|'payload_hash'|'destination_digest'>;
type SendOperation=Parameters<AlertAdapter['send']>[0];
export type ResendAlertConfig={enabled:boolean;api_key:string;from:string;to:string;destination_id:string;
  destination_digest:string;approved_configuration_digest:string;approval_evidence_ref:string};
type Transport={schema:'delta-owner-alert-resend/v1';notification_id:string;payload_hash:string;destination_digest:string;
  configuration_hash:string;alert:AlertObservation;request_hash:string;state:'prepared'|'posting'|'unknown'|'accepted'|'delivered'|'failed'|'rejected';
  attempts:number;owner_run_id:string;owner_generation:number;provider_email_id:string|null;rejection_code:string|null;
  created_at:string;updated_at:string};
type Http={status:number;headers:Headers;body:any};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^sha256:[0-9a-f]{64}$/.test(v);
const opaque=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(v);
const iso=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const mailbox=(v:unknown):v is string=>typeof v==='string'&&v.length<=254&&/^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(v);
const exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const key=(id:string)=>{if(!uuid(id))throw Error('resend_alert_identity_invalid');return `${RESEND_ALERT_PREFIX}${id}.json`;};
export async function resendAlertConfigurationDigest(config:Pick<ResendAlertConfig,'from'|'to'|'destination_id'>){
  if(!mailbox(config.from)||!mailbox(config.to)||!opaque(config.destination_id))throw Error('resend_alert_configuration_invalid');
  return sha256(stableJson({provider:'resend',from:config.from,to:config.to,destination_id:config.destination_id}));
}
function email(config:ResendAlertConfig,row:Pick<Transport,'notification_id'|'payload_hash'|'destination_digest'|'alert'>){
  const alert=row.alert;
  if('receipt'in alert){
    const r=alert.receipt,corrected=alert.code==='treasury_receipt_corrected',prior=r.correction,reobserved=r.occurrence==='reobserved_after_removal';
    const attribution=r.payer_classification==='unclassified'?'UNKNOWN':`${r.payer_classification} (platform verification; excluded from customer revenue)`;
    const amount=(raw:string)=>`${BigInt(raw)/1000000n}.${(BigInt(raw)%1000000n).toString().padStart(6,'0')}`;
    const details=corrected?
      `DELTA Treasury receipt correction - NOT a new incoming payment\nCorrection: ${prior!.kind}\nPrevious observation: ${amount(prior!.previous_raw_amount)} USDC\nPrevious block hash: ${prior!.previous_block_hash}\n${prior!.kind==='removed'?'The prior receipt observation is no longer present in the verified scan. Its amount below is historical, not a current receipt.':'The receipt observation was replaced. The amount below describes the replacement; do not count it as another payment.'}`:
      `${reobserved?'DELTA Treasury restored / re-observed previous receipt - NOT another payment':'DELTA Treasury observed a USDC receipt'}\nObserved amount: ${r.usdc_decimal} USDC\nThis records an observed transfer at the source checkpoint time; it may be historical. It is not recognized customer revenue. Deduplicate payments by network/token/transaction/log index, not notification ID.`;
    return {from:config.from,to:[config.to],subject:corrected?`DELTA Treasury receipt correction ${row.notification_id}`:
      reobserved?`DELTA Treasury re-observed previous receipt - NOT another payment ${row.notification_id}`:`DELTA Treasury observed ${r.usdc_decimal} USDC receipt ${row.notification_id}`,
      text:`${details}\nAmount in this observation: ${r.usdc_decimal} USDC (${r.raw_amount} raw, 6 decimals)\nNetwork: Base mainnet (${r.network})\nCanonical USDC: ${r.asset}\nTreasury: ${r.treasury}\nTransaction: ${r.tx_hash}\nExplorer: https://basescan.org/tx/${r.tx_hash}\nLog index: ${r.log_index}\nBlock: ${r.block_number}\nBlock hash: ${r.block_hash}\nObserved at: ${r.observed_at}\nConfirmation policy depth: ${r.confirmation_depth} blocks; not absolute finality. Later chain corrections remain possible.\nBuyer attribution: ${attribution}\nFulfillment: UNKNOWN\nCustomer revenue: ${r.customer_revenue}\nActual cost: UNKNOWN\nContribution margin: UNKNOWN\n\nNotification: ${row.notification_id}\nEvidence reference: ${alert.evidence_ref}\nCustody revision: ${r.custody_revision}\nCustody digest: ${r.custody_digest}\nPayload: ${row.payload_hash}\nProvider acceptance, delivery and owner acknowledgment are separate states.`,
      tags:[{name:'delta_notification',value:row.notification_id},{name:'delta_payload',value:row.payload_hash.slice(7)},
        {name:'delta_destination',value:row.destination_digest.slice(7)}]};
  }
  // Do not change this legacy branch: original provider request hashes/readback
  // depend on the exact historical subject, text and tags.
  return {from:config.from,to:[config.to],subject:`DELTA ${alert.severity} alert ${row.notification_id}`,
    text:`DELTA operational alert\nNotification: ${row.notification_id}\nCondition: ${alert.code}\nSubject: ${alert.subject}\nSeverity: ${alert.severity}\nStage: ${alert.stage}\nFirst observed: ${alert.first_seen_at}\nEvidence reference: ${alert.evidence_ref}\nPayload: ${row.payload_hash}\n\nProvider delivery does not mean owner acknowledgment. Review the private operating evidence before acting.`,
    tags:[{name:'delta_notification',value:row.notification_id},{name:'delta_payload',value:row.payload_hash.slice(7)},
      {name:'delta_destination',value:row.destination_digest.slice(7)}]};
}
function sameIdentity(row:Transport,operation:Identity){return row.notification_id===operation.notification_id&&row.payload_hash===operation.payload_hash&&row.destination_digest===operation.destination_digest;}
const validAlert=validOperatingNotification;
async function valid(row:Transport,config:ResendAlertConfig,configurationHash:string){
  return exact(row,['schema','notification_id','payload_hash','destination_digest','configuration_hash','alert','request_hash','state','attempts','owner_run_id','owner_generation','provider_email_id','rejection_code','created_at','updated_at'])&&
    row.schema==='delta-owner-alert-resend/v1'&&uuid(row.notification_id)&&hash(row.payload_hash)&&row.destination_digest===config.destination_digest&&row.configuration_hash===configurationHash&&
    validAlert(row.alert)&&row.payload_hash===await sha256(stableJson({alert:row.alert,destination:{id:config.destination_id,digest:config.destination_digest}}))&&
    row.request_hash===await sha256(stableJson(email(config,row)))&&['prepared','posting','unknown','accepted','delivered','failed','rejected'].includes(row.state)&&
    Number.isSafeInteger(row.attempts)&&row.attempts>=0&&row.attempts<=2&&uuid(row.owner_run_id)&&Number.isSafeInteger(row.owner_generation)&&row.owner_generation>=1&&row.owner_generation<=8&&
    (row.provider_email_id===null||uuid(row.provider_email_id))&&(row.rejection_code===null||['validation_error','restricted_api_key','missing_api_key','invalid_permission','suspended_api_key','rate_limit_exceeded','daily_quota_exceeded','monthly_quota_exceeded'].includes(row.rejection_code))&&
    iso(row.created_at)&&iso(row.updated_at)&&Date.parse(row.created_at)<=Date.parse(row.updated_at)&&Date.parse(row.updated_at)<=Date.now()&&
    (row.state==='prepared'?row.attempts===0:row.attempts>=1)&&(!['accepted','delivered','failed'].includes(row.state)||row.provider_email_id!==null);
}

// Signed webhook custody can corroborate only an already-known original
// provider email. It cannot bind an unknown POST outcome to an arbitrary ID.
// Native GET readback remains responsible for resolving that unknown outcome.
export async function readResendAlertWebhookBinding(source:RuntimeEnv,config:ResendAlertConfig,data:unknown){
  if(!config.enabled||!data||typeof data!=='object'||Array.isArray(data))return null;
  const d=data as Record<string,unknown>,tags=d.tags as Record<string,unknown>;
  if(!tags||!uuid(tags.delta_notification)||!uuid(d.email_id))return null;
  const configurationHash=await resendAlertConfigurationDigest(config);
  if(config.destination_digest!==configurationHash||config.approved_configuration_digest!==configurationHash||!opaque(config.approval_evidence_ref))return null;
  const stored=await readOrderMetadata<Transport>(source,key(tags.delta_notification),MAX_RECORD);
  if(!stored||!await valid(stored.record,config,configurationHash))return null;
  const row=stored.record,expected=email(config,row);
  if(row.provider_email_id!==d.email_id||d.from!==expected.from||stableJson(d.to)!==stableJson(expected.to)||d.subject!==expected.subject||
    stableJson(tags)!==stableJson(Object.fromEntries(expected.tags.map(t=>[t.name,t.value])))||
    typeof d.created_at!=='string'||!Number.isFinite(Date.parse(d.created_at))||Date.parse(d.created_at)<Date.parse(row.created_at)-5000||Date.parse(d.created_at)>Date.now())return null;
  return {notification_id:row.notification_id,payload_hash:row.payload_hash,destination_digest:row.destination_digest,
    provider_email_id:row.provider_email_id,original_created_at:row.created_at};
}

// Disabled returns before network/storage. Explicit approval binds the precise
// sender and destination; live native readback verifies usable full-access key
// plus a verified sending domain. Quota/acceptance are still checked per POST.
export async function createResendAlertAdapter(source:RuntimeEnv,config:ResendAlertConfig,
  options:{fetch?:typeof fetch}={}):Promise<AlertAdapter|null>{
  if(config.enabled!==true)return null;
  const configurationHash=await resendAlertConfigurationDigest(config);
  if(!/^re_[A-Za-z0-9_-]{8,256}$/.test(config.api_key)||!hash(config.destination_digest)||config.destination_digest!==configurationHash||
    config.approved_configuration_digest!==configurationHash||!opaque(config.approval_evidence_ref))throw Error('resend_alert_approval_missing');
  // Keep the secret in this runtime closure only. Never include raw responses,
  // addresses or authentication in diagnostics or durable operational records.
  const transport=options.fetch??fetch;
  async function request(method:'GET'|'POST',path:string,signal:AbortSignal,body?:unknown,idempotencyKey?:string):Promise<Http>{
    const controller=new AbortController(),cancel=()=>controller.abort();signal.addEventListener('abort',cancel,{once:true});
    const check=()=>{if(signal.aborted||controller.signal.aborted)throw Error('resend_alert_http_unconfirmed');};
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    try{return await withinDeadline((async()=>{
      check();const response=await transport(`${API}${path}`,{method,redirect:'manual',signal:controller.signal,
        headers:{authorization:`Bearer ${config.api_key}`,accept:'application/json',...(method==='POST'?{'content-type':'application/json','idempotency-key':idempotencyKey!}:{})},
        ...(body?{body:stableJson(body)}:{})});
      check();if(response.redirected||response.status>=300&&response.status<400||response.url&&response.url!==`${API}${path}`)throw Error('resend_alert_redirect_rejected');
      if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||!response.body)throw Error('resend_alert_http_unconfirmed');
      const length=response.headers.get('content-length');if(length&&(!/^[0-9]+$/.test(length)||Number(length)>MAX_BODY))throw Error('resend_alert_http_unconfirmed');
      reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
      while(true){const part=await reader.read();check();if(part.done)break;size+=part.value.byteLength;if(size>MAX_BODY)throw Error('resend_alert_http_unconfirmed');chunks.push(part.value);}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));check();return{status:response.status,headers:response.headers,body:parsed};
    })(),REQUEST_MS,'resend_alert_http_unconfirmed',cancel);}catch{throw Error('resend_alert_http_unconfirmed');}
    finally{cancel();signal.removeEventListener('abort',cancel);if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();}}
  }
  const permissionController=new AbortController();
  try{
    const emails=await request('GET','/emails?limit=1',permissionController.signal);
    if(emails.status!==200||emails.body?.object!=='list'||!Array.isArray(emails.body.data)||emails.body.data.length>1||typeof emails.body.has_more!=='boolean')throw Error('resend_alert_permission_unverified');
    const domains=await request('GET','/domains?limit=100',permissionController.signal),domain=config.from.split('@')[1];
    const matching=domains.body?.data?.filter((row:any)=>row?.name===domain);
    if(domains.status!==200||domains.body?.object!=='list'||!Array.isArray(domains.body.data)||domains.body.data.length>100||
      !Array.isArray(matching)||matching.length!==1||matching[0].status!=='verified'||matching[0].capabilities?.sending!=='enabled')throw Error('resend_alert_permission_unverified');
  }finally{permissionController.abort();}
  const destination={id:config.destination_id,digest:config.destination_digest};
  function receipt(row:Transport,status:AlertReceipt['status']):AlertReceipt{return{notification_id:row.notification_id,payload_hash:row.payload_hash,
    destination_digest:row.destination_digest,status,receipt_id:row.provider_email_id??`resend-rejected-${row.notification_id}`,observed_at:new Date().toISOString()};}
  async function store(env:RuntimeEnv,previous:StoredClaim<Transport>,row:Transport,check:()=>void){
    check();try{await commitClaim(env,key(row.notification_id),previous,row);}catch{/* exact original record below, never retry CAS */}
    check();const actual=await readOrderMetadata<Transport>(env,key(row.notification_id),MAX_RECORD);check();
    if(!actual||!await valid(actual.record,config,configurationHash)||stableJson(actual.record)!==stableJson(row))throw Error('resend_alert_storage_unconfirmed');return actual;
  }
  async function native(env:RuntimeEnv,current:StoredClaim<Transport>,signal:AbortSignal,check:()=>void):Promise<AlertReceipt|null>{
    const row=current.record;let id=row.provider_email_id;
    if(!id){
      // Lost POST ACK: bounded GET only. A missing/truncated list is never
      // evidence that POST was not applied, even beyond Resend's 24h key TTL.
      let after:string|undefined;const seen=new Set<string>(),matches:string[]=[];
      for(let page=0;page<MAX_PAGES;page++){
        const response=await request('GET',`/emails?limit=100${after?`&after=${after}`:''}`,signal);check();
        const list=response.body;if(response.status!==200||list?.object!=='list'||!Array.isArray(list.data)||list.data.length>100||typeof list.has_more!=='boolean')return null;
        for(const item of list.data){if(!uuid(item?.id)||seen.has(item.id))throw Error('resend_alert_provider_identity_conflict');seen.add(item.id);
          if(item.subject===email(config,row).subject&&item.from===config.from&&stableJson(item.to)===stableJson([config.to]))matches.push(item.id);}
        if(!list.has_more)break;if(!list.data.length)return null;after=list.data.at(-1).id;
      }
      if(matches.length!==1)return null;id=matches[0];
    }
    const response=await request('GET',`/emails/${id}`,signal);check();const value=response.body,expected=email(config,row);
    if(response.status!==200||value?.object!=='email'||value.id!==id||value.from!==expected.from||stableJson(value.to)!==stableJson(expected.to)||
      value.subject!==expected.subject||value.text!==expected.text||value.html!==null&&value.html!==undefined&&value.html!==''||
      ['bcc','cc','reply_to'].some(k=>value[k]!==null&&value[k]!==undefined&&(!Array.isArray(value[k])||value[k].length!==0))||
      !Array.isArray(value.tags)||stableJson([...value.tags].sort((a,b)=>String(a.name).localeCompare(String(b.name))))!==stableJson([...expected.tags].sort((a,b)=>a.name.localeCompare(b.name)))||
      !Number.isFinite(Date.parse(value.created_at))||Date.parse(value.created_at)<Date.parse(row.created_at)-5000||Date.parse(value.created_at)>Date.now())return null;
    const event=value.last_event;
    const status:AlertReceipt['status']|null=event==='delivered'?'delivered':['bounced','failed','canceled','suppressed'].includes(event)?'failed':
      ['sent','scheduled','queued','delivery_delayed','opened','clicked','complained'].includes(event)?'provider_accepted':null;
    if(!status)return null;
    // No delivery regression or resend after a definitive terminal result.
    const selected=row.state==='delivered'?'delivered':row.state==='failed'?'failed':status;
    const actual=await store(env,current,{...row,provider_email_id:id,state:selected==='provider_accepted'?'accepted':selected,updated_at:new Date().toISOString()},check);
    return receipt(actual.record,selected);
  }
  async function access<T>(signal:AbortSignal,operation:(env:RuntimeEnv,check:()=>void)=>Promise<T>){
    const snapshot=createOrderReadSnapshot(source,MAX_RECORD),cancel=()=>snapshot.cancel();signal.addEventListener('abort',cancel,{once:true});
    const check=()=>{snapshot.assertActive();if(signal.aborted)throw Error('resend_alert_operation_unconfirmed');};
    try{check();return await withinDeadline(operation(snapshot.env,check),9000,'resend_alert_operation_unconfirmed',cancel);}finally{snapshot.cancel();signal.removeEventListener('abort',cancel);}
  }
  return {destination,permission:{state:'available',observed_at:new Date().toISOString(),evidence_ref:'resend-native-permission-readback'},
    readOriginal:async(operation,signal)=>access(signal,async(env,check)=>{
      const current=await readOrderMetadata<Transport>(env,key(operation.notification_id),MAX_RECORD);check();
      if(!current)return null;if(!await valid(current.record,config,configurationHash)||!sameIdentity(current.record,operation))throw Error('resend_alert_original_invalid');
      if(current.record.state==='rejected')return receipt(current.record,'not_applied');return native(env,current,signal,check);
    }),
    send:async(operation,signal)=>access(signal,async(env,check)=>{
      const authoritative=await readOperatingAlert(source,operation.alert.dedupe_key);check();
      if(!authoritative||authoritative.state!=='sending'||authoritative.acknowledgment||authoritative.notification_id!==operation.notification_id||authoritative.payload_hash!==operation.payload_hash||
        authoritative.run_id!==operation.run_id||authoritative.generation!==operation.generation||stableJson(authoritative.destination)!==stableJson(destination)||
        Date.parse(authoritative.lease_until!)<=Date.now()||stableJson(authoritative.episode)!==stableJson(operation.alert))throw Error('resend_alert_claim_invalid');
      let current=await readOrderMetadata<Transport>(env,key(operation.notification_id),MAX_RECORD);check();
      if(current){if(!await valid(current.record,config,configurationHash)||!sameIdentity(current.record,operation))throw Error('resend_alert_original_invalid');
        const existing=await native(env,current,signal,check);if(existing)return existing;throw Error('resend_alert_original_unconfirmed');}
      const at=new Date().toISOString(),initial:Transport={schema:'delta-owner-alert-resend/v1',notification_id:operation.notification_id,payload_hash:operation.payload_hash,
        destination_digest:operation.destination_digest,configuration_hash:configurationHash,alert:structuredClone(operation.alert),request_hash:'',state:'prepared',attempts:0,
        owner_run_id:operation.run_id,owner_generation:operation.generation,provider_email_id:null,rejection_code:null,created_at:at,updated_at:at};
      initial.request_hash=await sha256(stableJson(email(config,initial)));if(!await valid(initial,config,configurationHash))throw Error('resend_alert_original_invalid');
      const saved=await createClaim(env,key(initial.notification_id),initial);check();if(!saved)throw Error('resend_alert_original_conflict');current=saved;
      for(let attempt=0;attempt<2;attempt++){
        const posting={...current.record,state:'posting' as const,attempts:current.record.attempts+1,updated_at:new Date().toISOString()};
        // A lost claim ACK never grants a POST, even if the conditional write
        // later commits. Only a known CAS acknowledgment grants this attempt.
        const claimed=await commitClaim(env,key(posting.notification_id),current,posting);check();if(!claimed)throw Error('resend_alert_original_conflict');current=claimed;
        let response:Http;
        try{response=await request('POST','/emails',signal,email(config,posting),`delta-alert/${posting.notification_id}`);check();}
        catch{await store(env,current,{...posting,state:'unknown',updated_at:new Date().toISOString()},check);throw Error('resend_alert_post_unconfirmed');}
        if(response.status===200&&uuid(response.body?.id)){
          const accepted=await store(env,current,{...posting,state:'accepted',provider_email_id:response.body.id,rejection_code:null,updated_at:new Date().toISOString()},check);
          return receipt(accepted.record,'provider_accepted');
        }
        const name=response.body?.name;
        const rejected=typeof name==='string'&&([400,401,403].includes(response.status)&&['validation_error','restricted_api_key','missing_api_key','invalid_permission','suspended_api_key'].includes(name)||
          response.status===429&&['rate_limit_exceeded','daily_quota_exceeded','monthly_quota_exceeded'].includes(name));
        if(!rejected){await store(env,current,{...posting,state:'unknown',updated_at:new Date().toISOString()},check);throw Error('resend_alert_post_unconfirmed');}
        current=await store(env,current,{...posting,state:'rejected',rejection_code:name,updated_at:new Date().toISOString()},check);
        const retryHeader=response.headers.get('retry-after'),delay=retryHeader&&/^\d+$/.test(retryHeader)?Number(retryHeader)*1000:1000;
        if(attempt===1||name!=='rate_limit_exceeded'||delay>1000)return receipt(current.record,'not_applied');
        // One bounded retry only for a native explicit rate rejection, under
        // the exact original key/body and after original GET readback. Absence
        // is not itself retry authority; the explicit rejection is required.
        const previous=await native(env,current,signal,check);if(previous)return previous;
        await withinDeadline(new Promise<void>(resolve=>setTimeout(resolve,delay)),1100,'resend_alert_backoff',()=>{});check();
      }
      throw Error('resend_alert_attempts_exhausted');
    })};
}
