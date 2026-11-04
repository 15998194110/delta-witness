// Owner-alert coordination only. No default transport, destination address,
// credentials, customer messages, payment authority or scheduler changes.
import type {RuntimeEnv} from './env';
import {sha256,stableJson,uuidFromDigest} from './crypto';
import {createClaim,commitClaim} from './claims';
import {createOrderReadSnapshot,readOrderMetadata} from './order-storage';
import {withinDeadline} from './deadline';
import type {Severity} from './operating-report';

export const ALERT_OUTBOX_PREFIX='operations/alerts/';
const MAX_BYTES=32000,MAX_HISTORY=16;
const CODES=['scheduler_stale','scheduler_consecutive_failures','paid_undelivered','receipt_unmatched','rpc_coverage_gap','permission_expired','negative_margin'] as const;
const STATES=['blocked','queued','sending','unconfirmed','provider_accepted','delivered','failed'] as const;
type State=typeof STATES[number];
type Destination={id:string;digest:string};
export type AlertObservation={dedupe_key:string;code:typeof CODES[number];subject:string;severity:Severity;stage:'initial'|'escalated';first_seen_at:string;evidence_ref:string};
export type AlertReceipt={notification_id:string;payload_hash:string;destination_digest:string;status:'provider_accepted'|'delivered'|'failed'|'not_applied';receipt_id:string;observed_at:string};
type Ack={notification_id:string;payload_hash:string;severity:Severity;actor_ref:string;evidence_ref:string;observed_at:string};
type History={state:State;generation:number;run_id:string|null;at:string;notification_id:string;payload_hash:string;episode:AlertObservation;
  destination:Destination|null;receipt:AlertReceipt|null;acknowledgment:Ack|null;created_at:string};
export type AlertOutboxRecord={schema:'delta-owner-alert-outbox/v1';episode:AlertObservation;notification_id:string;payload_hash:string;
  destination:Destination|null;state:State;generation:number;run_id:string|null;lease_until:string|null;created_at:string;updated_at:string;
  receipt:AlertReceipt|null;acknowledgment:Ack|null;history:History[]};
export type AlertAdapter={destination:Destination;permission:{state:'available';observed_at:string;evidence_ref:string};
  send:(operation:{notification_id:string;run_id:string;generation:number;payload_hash:string;destination_digest:string;alert:AlertObservation},signal:AbortSignal)=>Promise<AlertReceipt>;
  readOriginal:(operation:{notification_id:string;payload_hash:string;destination_digest:string},signal:AbortSignal)=>Promise<AlertReceipt|null>};
const opaque=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^sha256:[0-9a-f]{64}$/.test(v);
const iso=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const exact=(v:unknown,fields:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...fields].sort().join(',');
const rank={SEV1:3,SEV2:2,SEV3:1};
function observation(v:AlertObservation):boolean{return exact(v,['dedupe_key','code','subject','severity','stage','first_seen_at','evidence_ref'])&&
  CODES.includes(v.code)&&opaque(v.subject)&&['SEV1','SEV2','SEV3'].includes(v.severity)&&['initial','escalated'].includes(v.stage)&&iso(v.first_seen_at)&&
  opaque(v.evidence_ref)&&v.dedupe_key.startsWith(`delta:${v.code}:${v.subject}:`)&&/^delta:[a-z_]+:[A-Za-z0-9._-]{1,96}:[A-Za-z0-9._-]{1,96}$/.test(v.dedupe_key);}
function destination(v:Destination):boolean{return exact(v,['id','digest'])&&opaque(v.id)&&hash(v.digest);}
const payload=(e:AlertObservation,d:Destination|null)=>({alert:e,destination:d});
async function identity(e:AlertObservation){return uuidFromDigest(await sha256(`delta-owner-alert/v1\n${e.dedupe_key}\n${e.severity}\n${e.stage}`));}
async function keyFor(episodeKey:string){if(typeof episodeKey!=='string'||episodeKey.length>300)throw new Error('alert_identity_invalid');return `${ALERT_OUTBOX_PREFIX}episodes/${(await sha256(episodeKey)).slice(7)}.json`;}
function receiptValid(v:AlertReceipt,r:AlertOutboxRecord,now:number):boolean{return exact(v,['notification_id','payload_hash','destination_digest','status','receipt_id','observed_at'])&&
  v.notification_id===r.notification_id&&v.payload_hash===r.payload_hash&&v.destination_digest===r.destination?.digest&&
  ['provider_accepted','delivered','failed','not_applied'].includes(v.status)&&opaque(v.receipt_id)&&iso(v.observed_at)&&Date.parse(v.observed_at)>=Date.parse(r.created_at)&&Date.parse(v.observed_at)<=now;}
async function valid(r:AlertOutboxRecord,episodeKey:string,now:number):Promise<boolean>{
  if(!exact(r,['schema','episode','notification_id','payload_hash','destination','state','generation','run_id','lease_until','created_at','updated_at','receipt','acknowledgment','history'])||
    r.schema!=='delta-owner-alert-outbox/v1'||!observation(r.episode)||r.episode.dedupe_key!==episodeKey||r.notification_id!==await identity(r.episode)||
    !hash(r.payload_hash)||r.payload_hash!==await sha256(stableJson(payload(r.episode,r.destination)))||r.destination!==null&&!destination(r.destination)||
    !STATES.includes(r.state)||!Number.isSafeInteger(r.generation)||r.generation<0||r.generation>8||r.run_id!==null&&!uuid(r.run_id)||
    !iso(r.created_at)||!iso(r.updated_at)||Date.parse(r.created_at)>Date.parse(r.updated_at)||Date.parse(r.updated_at)>now||Date.parse(r.episode.first_seen_at)>Date.parse(r.created_at)||
    (r.state==='sending'?!iso(r.lease_until):r.lease_until!==null)||r.generation===0&&r.run_id!==null||r.generation>0&&!uuid(r.run_id)||
    !Array.isArray(r.history)||r.history.length<1||r.history.length>MAX_HISTORY)return false;
  if(r.state==='blocked'?(r.destination!==null||r.generation!==0):r.destination===null)return false;
  for(const h of r.history){if(!exact(h,['state','generation','run_id','at','notification_id','payload_hash','episode','destination','receipt','acknowledgment','created_at'])||!STATES.includes(h.state)||!Number.isSafeInteger(h.generation)||h.generation<0||h.generation>8||
    h.run_id!==null&&!uuid(h.run_id)||!iso(h.at)||Date.parse(h.at)>Date.parse(r.updated_at)||!iso(h.created_at)||Date.parse(h.created_at)>Date.parse(h.at)||
    !observation(h.episode)||h.episode.dedupe_key!==episodeKey||h.notification_id!==await identity(h.episode)||h.destination!==null&&!destination(h.destination)||
    h.payload_hash!==await sha256(stableJson(payload(h.episode,h.destination))))return false;
    const historical={...r,...h};
    if(h.receipt!==null&&!receiptValid(h.receipt,historical,now))return false;
    const ack=h.acknowledgment;if(ack!==null&&(!exact(ack,['notification_id','payload_hash','severity','actor_ref','evidence_ref','observed_at'])||
      ack.notification_id!==h.notification_id||ack.payload_hash!==h.payload_hash||ack.severity!==h.episode.severity||!opaque(ack.actor_ref)||!opaque(ack.evidence_ref)||
      !iso(ack.observed_at)||Date.parse(ack.observed_at)<Date.parse(h.created_at)||Date.parse(ack.observed_at)>now))return false;
  }
  if(r.receipt!==null&&!receiptValid(r.receipt,r,now))return false;
  if(r.state==='provider_accepted'&&r.receipt?.status!=='provider_accepted'||r.state==='delivered'&&r.receipt?.status!=='delivered'||r.state==='failed'&&!['not_applied','failed'].includes(r.receipt?.status??''))return false;
  if(stableJson(r.history.at(-1))!==stableJson(frame(r)))return false;
  const a=r.acknowledgment;
  return a===null||exact(a,['notification_id','payload_hash','severity','actor_ref','evidence_ref','observed_at'])&&a.notification_id===r.notification_id&&a.payload_hash===r.payload_hash&&
    a.severity===r.episode.severity&&opaque(a.actor_ref)&&opaque(a.evidence_ref)&&iso(a.observed_at)&&Date.parse(a.observed_at)>=Date.parse(r.created_at)&&Date.parse(a.observed_at)<=now;
}
const frame=(r:Omit<AlertOutboxRecord,'history'>):History=>({state:r.state,generation:r.generation,run_id:r.run_id,at:r.updated_at,
  notification_id:r.notification_id,payload_hash:r.payload_hash,episode:r.episode,destination:r.destination,receipt:r.receipt,acknowledgment:r.acknowledgment,created_at:r.created_at});
function next(r:AlertOutboxRecord,patch:Partial<AlertOutboxRecord>,now:number):AlertOutboxRecord{
  if(r.history.length>=MAX_HISTORY)throw new Error('alert_history_exhausted');
  const row={...r,...patch,updated_at:new Date(now).toISOString()};
  const updated={...row,history:[...r.history,frame(row)]};if(new TextEncoder().encode(JSON.stringify(updated)).byteLength>MAX_BYTES)throw new Error('alert_history_exhausted');return updated;
}
async function access<T>(source:RuntimeEnv,body:(env:RuntimeEnv,check:()=>void)=>Promise<T>,ms=20000){const snapshot=createOrderReadSnapshot(source,MAX_BYTES);
  try{return await withinDeadline(body(snapshot.env,snapshot.assertActive),ms,'alert_operation_deadline',snapshot.cancel);}finally{snapshot.cancel();}}

export async function readOperatingAlert(source:RuntimeEnv,episodeKey:string){return access(source,async(env,check)=>{
  const row=await readOrderMetadata<AlertOutboxRecord>(env,await keyFor(episodeKey));check();
  if(row&&!await valid(row.record,episodeKey,Date.now()))throw new Error('alert_original_invalid');return row?.record??null;
},10000);}

// An authenticated source adapter supplies observations. Configuration is not
// provider permission; enqueue cannot send, acknowledge, or prove delivery.
export async function enqueueOperatingAlert(source:RuntimeEnv,e:AlertObservation,d:Destination|null=null){
  if(!observation(e)||Date.parse(e.first_seen_at)>Date.now()||d!==null&&!destination(d))throw new Error('alert_input_invalid');
  return access(source,async(env,check)=>{
    const key=await keyFor(e.dedupe_key),prior=await readOrderMetadata<AlertOutboxRecord>(env,key);check();
    if(prior&&!await valid(prior.record,e.dedupe_key,Date.now()))throw new Error('alert_original_invalid');
    if(prior){const r=prior.record;
      if(r.episode.first_seen_at!==e.first_seen_at)throw new Error('alert_episode_conflict');
      if(r.acknowledgment&&rank[r.acknowledgment.severity]>=rank[e.severity])return {state:'suppressed',reason:'explicit_acknowledgment',notification_id:r.notification_id};
      if(rank[e.severity]<rank[r.episode.severity])return {state:r.state,reason:'original_higher_severity_retained',notification_id:r.notification_id};
      const worsened=rank[e.severity]>rank[r.episode.severity]||e.stage==='escalated'&&r.episode.stage==='initial';
      const canBind=r.state==='blocked'&&d!==null;
      if(!worsened&&!canBind)return {state:r.state,reason:'original_observation_recorded',notification_id:r.notification_id};
      if(['sending','unconfirmed','provider_accepted','queued'].includes(r.state))return {state:r.state,reason:'original_operation_requires_readback',notification_id:r.notification_id};
      if(r.destination&&d&&stableJson(r.destination)!==stableJson(d))throw new Error('alert_destination_conflict');
    }
    const selectedDestination=d??prior?.record.destination??null;
    const now=new Date().toISOString(),row:AlertOutboxRecord={schema:'delta-owner-alert-outbox/v1',episode:{...e},notification_id:await identity(e),
      payload_hash:await sha256(stableJson(payload(e,selectedDestination))),destination:selectedDestination,state:selectedDestination?'queued':'blocked',generation:0,run_id:null,lease_until:null,
      created_at:now,updated_at:now,receipt:null,acknowledgment:null,history:[...(prior?.record.history??[])]};
    row.history.push(frame(row));if(row.history.length>MAX_HISTORY||new TextEncoder().encode(JSON.stringify(row)).byteLength>MAX_BYTES)throw new Error('alert_history_exhausted');check();
    try{const saved=prior?await commitClaim(env,key,prior,row):await createClaim(env,key,row);check();if(!saved)return {state:'conflict',reason:'original_cas_conflict'};}catch{/* exact original readback only */}
    const actual=await readOrderMetadata<AlertOutboxRecord>(env,key);check();
    return actual&&await valid(actual.record,e.dedupe_key,Date.now())&&stableJson(actual.record)===stableJson(row)?
      {state:row.state,reason:'original_observation_persisted',notification_id:row.notification_id}:{state:'unconfirmed',reason:'observation_write_unconfirmed'};
  });
}

export async function acknowledgeOperatingAlert(source:RuntimeEnv,episodeKey:string,input:{notification_id:string;payload_hash:string;actor_ref:string;evidence_ref:string;observed_at:string}){
  if(!exact(input,['notification_id','payload_hash','actor_ref','evidence_ref','observed_at'])||!uuid(input.notification_id)||!hash(input.payload_hash)||!opaque(input.actor_ref)||!opaque(input.evidence_ref)||!iso(input.observed_at)||Date.parse(input.observed_at)>Date.now())throw new Error('alert_ack_invalid');
  return access(source,async(env,check)=>{const key=await keyFor(episodeKey),prior=await readOrderMetadata<AlertOutboxRecord>(env,key);check();
    if(!prior||!await valid(prior.record,episodeKey,Date.now())||prior.record.notification_id!==input.notification_id||prior.record.payload_hash!==input.payload_hash||Date.parse(input.observed_at)<Date.parse(prior.record.created_at))throw new Error('alert_ack_identity_conflict');
    if(prior.record.acknowledgment)return {state:'acknowledged',notification_id:input.notification_id};
    const row=next(prior.record,{acknowledgment:{...input,severity:prior.record.episode.severity}},Date.now());
    try{await commitClaim(env,key,prior,row);}catch{/* read original identity, never repeat ACK write */}
    const actual=await readOrderMetadata<AlertOutboxRecord>(env,key);check();
    return {state:actual&&await valid(actual.record,episodeKey,Date.now())&&stableJson(actual.record.acknowledgment)===stableJson(row.acknowledgment)?'acknowledged':'unconfirmed',notification_id:input.notification_id};
  });
}

// The separately gated owner consumer supplies a verified provider adapter.
// Native receipts and exact-original-ID readback remain its responsibility.
export async function processOperatingAlert(source:RuntimeEnv,episodeKey:string,adapter:AlertAdapter){
  const controller=new AbortController(),now=Date.now();
  if(!adapter||!destination(adapter.destination)||adapter.permission?.state!=='available'||!iso(adapter.permission.observed_at)||!opaque(adapter.permission.evidence_ref)||
    now-Date.parse(adapter.permission.observed_at)<0||now-Date.parse(adapter.permission.observed_at)>300000||typeof adapter.send!=='function'||typeof adapter.readOriginal!=='function')throw new Error('alert_provider_unverified');
  try{return await access(source,async(env,check)=>{const key=await keyFor(episodeKey),prior=await readOrderMetadata<AlertOutboxRecord>(env,key);check();
    if(!prior||!await valid(prior.record,episodeKey,Date.now()))throw new Error('alert_original_invalid');let current=prior;const r=prior.record;
    if(stableJson(r.destination)!==stableJson(adapter.destination))throw new Error('alert_destination_conflict');
    if(r.acknowledgment||['blocked','delivered','failed'].includes(r.state))return {state:r.state,reason:'no_dispatch_permission'};
    const operation={notification_id:r.notification_id,payload_hash:r.payload_hash,destination_digest:adapter.destination.digest};
    if(r.state==='sending'&&Date.now()<Date.parse(r.lease_until!))return {state:'sending',reason:'original_run_active'};
    let receipt:AlertReceipt|null=null;
    if(['sending','unconfirmed','provider_accepted'].includes(r.state)){
      receipt=await withinDeadline(adapter.readOriginal(operation,controller.signal),10000,'alert_provider_deadline',()=>controller.abort());check();
      if(!receipt)return {state:'unconfirmed',reason:'original_receipt_unavailable'};
    }else{
      if(r.state!=='queued'||r.generation>=8)throw new Error('alert_not_dispatchable');
      const claimed=next(r,{state:'sending',generation:r.generation+1,run_id:crypto.randomUUID(),lease_until:new Date(Date.now()+15000).toISOString()},Date.now());
      const granted=await commitClaim(env,key,prior,claimed);check();if(!granted)return {state:'conflict',reason:'claim_conflict'};current=granted;
      try{receipt=await withinDeadline(adapter.send({...operation,run_id:claimed.run_id!,generation:claimed.generation,alert:structuredClone(claimed.episode)},controller.signal),10000,'alert_provider_deadline',()=>controller.abort());}
      catch{check();const unknown=next(claimed,{state:'unconfirmed',lease_until:null},Date.now());await commitClaim(env,key,current,unknown);return {state:'unconfirmed',reason:'original_send_unknown'};}
      check();
    }
    receipt=structuredClone(receipt);
    if(!receiptValid(receipt,current.record,Date.now()))throw new Error('alert_receipt_identity_conflict');
    // Polling an unchanged native result is not a state transition. Appending
    // every accepted observation exhausted the bounded history and prevented a
    // later delivered result from being recorded in a long-running episode.
    const previous=current.record.receipt;
    if(previous&&previous.status===receipt.status&&previous.receipt_id===receipt.receipt_id){
      return {state:current.record.state,receipt_id:previous.receipt_id,recipient_acknowledged:!!current.record.acknowledgment,
        reason:'original_receipt_unchanged'};
    }
    const row=next(current.record,{state:receipt.status==='not_applied'?'failed':receipt.status,receipt,lease_until:null},Date.now());
    try{await commitClaim(env,key,current,row);}catch{/* only original record readback */}
    const actual=await readOrderMetadata<AlertOutboxRecord>(env,key);check();
    return actual&&await valid(actual.record,episodeKey,Date.now())&&stableJson(actual.record)===stableJson(row)?
      {state:row.state,receipt_id:receipt.receipt_id,recipient_acknowledged:!!row.acknowledgment}:{state:'unconfirmed',reason:'receipt_write_unconfirmed'};
  },30000);}finally{controller.abort();}
}
