// Original-order recovery orchestration, not a new fulfillment/payment rail.
// One reservation per existing Cron event; the original fulfillment ETag alone
// authorizes its completion. Scan cursors never authorize browser/payment work.
import type { RuntimeEnv } from './env';
import { createClaim, commitClaim } from './claims';
import { createOrderReadSnapshot, readOrderMetadata } from './order-storage';
import { sha256, stableJson } from './crypto';
import { withinDeadline } from './deadline';
import { runPaidOrderRecovery, validatePaidOrderRecoveryResult, type PaidOrderRecoveryResult } from './paid-order-recovery';

export const PAID_RECOVERY_PREFIX = 'operations/paid-order-recovery/';
const MAX_BYTES = 16_384;
type Cursor = { schema:'delta-paid-recovery-cursor/v1'; version:number; cursor:string|null; run_id:string; updated_at:string };
type Observation = { schema:'delta-paid-recovery-observation/v1'; run_id:string; scheduled_at:string; started_at:string;
  state:'started'|'observed'; result:PaidOrderRecoveryResult|null; result_hash:string|null };
const iso = (v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const uuid = (v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const cursor = (v:unknown):v is string|null=>v===null||typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\u0000-\u001f\u007f]/.test(v);
const keys = (v:unknown,expected:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===expected.sort().join(',');
function validCursor(v:unknown):v is Cursor {
  const r=v as Cursor;return keys(r,['schema','version','cursor','run_id','updated_at'])&&r.schema==='delta-paid-recovery-cursor/v1'&&
    Number.isSafeInteger(r.version)&&r.version>0&&cursor(r.cursor)&&uuid(r.run_id)&&iso(r.updated_at);
}
async function validObservation(v:unknown):Promise<boolean>{
  const r=v as Observation;if(!keys(r,['schema','run_id','scheduled_at','started_at','state','result','result_hash'])||
    r.schema!=='delta-paid-recovery-observation/v1'||!uuid(r.run_id)||!iso(r.scheduled_at)||!iso(r.started_at)||Date.parse(r.started_at)>Date.now())return false;
  if(r.state==='started')return r.result===null&&r.result_hash===null;
  if(r.state!=='observed'||!validatePaidOrderRecoveryResult(r.result)||!/^sha256:[0-9a-f]{64}$/.test(r.result_hash??'')||
    r.result_hash!==await sha256(stableJson(r.result)))return false;
  return Date.parse(r.result.started_at)>=Date.parse(r.started_at)&&Date.parse(r.result.completed_at)<=Date.now();
}
const eventKey=(scheduled:number)=>`${PAID_RECOVERY_PREFIX}runs/${scheduled}.json`;
const position=(r:Observation)=>`${r.scheduled_at}|${r.started_at}|${r.run_id}`;

export async function scheduledPaidOrderRecovery(source:RuntimeEnv,scheduledTime:number){
  if(source.OPERATIONS_CLOUD_ENABLED!=='true'||source.PAID_ORDER_DRAFT_RECOVERY_ENABLED!=='true')return {outcome:'skipped',reason:'not_enabled'};
  if(!Number.isSafeInteger(scheduledTime)||scheduledTime<0||!iso(new Date(scheduledTime).toISOString()))throw new Error('paid_recovery_schedule_invalid');
  const snapshot=createOrderReadSnapshot(source,MAX_BYTES),env=snapshot.env,controller=new AbortController();
  const check=()=>{snapshot.assertActive();if(controller.signal.aborted)throw new Error('paid_recovery_control_deadline');};
  const stop=()=>{controller.abort();snapshot.cancel();};
  try{return await withinDeadline((async()=>{
    const key=eventKey(scheduledTime),existing=await readOrderMetadata<Observation>(env,key,MAX_BYTES);check();
    if(existing){if(!await validObservation(existing.record)||existing.record.scheduled_at!==new Date(scheduledTime).toISOString())throw new Error('paid_recovery_observation_invalid');
      // An indeterminate original event is never blindly repeated. A later
      // Cron can independently inspect the same original order/CAS safely.
      return {outcome:existing.record.state==='observed'?'skipped':'degraded',reason:'original_event_recorded',run_id:existing.record.run_id};}
    const cursorKey=`${PAID_RECOVERY_PREFIX}cursor.json`,prior=await readOrderMetadata<Cursor>(env,cursorKey,MAX_BYTES);check();
    if(prior&&!validCursor(prior.record))throw new Error('paid_recovery_cursor_invalid');
    const initial:Observation={schema:'delta-paid-recovery-observation/v1',run_id:crypto.randomUUID(),scheduled_at:new Date(scheduledTime).toISOString(),
      started_at:new Date().toISOString(),state:'started',result:null,result_hash:null};
    const reserved=await createClaim(env,key,initial);check();
    if(!reserved)return {outcome:'skipped',reason:'event_reservation_conflict'};
    const result=await runPaidOrderRecovery(source,{...(prior?.record.cursor?{cursor:prior.record.cursor}:{}),maxOrders:5,deadlineMs:60_000,signal:controller.signal});check();
    const observed:Observation={...initial,state:'observed',result,result_hash:await sha256(stableJson(result))};
    // One final CAS. If the ACK is lost only the exact original record is read;
    // no new reservation or final-write attempt is made under another identity.
    try{await commitClaim(env,key,reserved,observed);}catch{/* independent original readback below */}
    check();const receipt=await readOrderMetadata<Observation>(env,key,MAX_BYTES);check();
    if(!receipt||!await validObservation(receipt.record)||stableJson(receipt.record)!==stableJson(observed))
      return {outcome:'degraded',reason:'observation_unconfirmed',run_id:initial.run_id};
    let cursorState='retained';
    if(result.inventory.page_complete){
      if(prior&&prior.record.version>=Number.MAX_SAFE_INTEGER)throw new Error('paid_recovery_cursor_exhausted');
      const next:Cursor={schema:'delta-paid-recovery-cursor/v1',version:(prior?.record.version??0)+1,cursor:result.inventory.next_cursor,
        run_id:initial.run_id,updated_at:result.completed_at};
      try{const advanced=prior?await commitClaim(env,cursorKey,prior,next):await createClaim(env,cursorKey,next);check();cursorState=advanced?'advanced':'conflict';}
      catch{check();const actual=await readOrderMetadata<Cursor>(env,cursorKey,MAX_BYTES);check();
        cursorState=actual&&validCursor(actual.record)&&stableJson(actual.record)===stableJson(next)?'advanced':'unconfirmed';}
    }
    const latestKey=`${PAID_RECOVERY_PREFIX}latest.json`,latest=await readOrderMetadata<Observation>(env,latestKey,MAX_BYTES);check();
    if(latest&&!await validObservation(latest.record))throw new Error('paid_recovery_latest_invalid');
    if(!latest||position(observed)>position(latest.record)){
      const saved=latest?await commitClaim(env,latestKey,latest,observed):await createClaim(env,latestKey,observed);check();
      if(!saved)return {outcome:'degraded',reason:'latest_projection_conflict',run_id:initial.run_id,cursor_state:cursorState};
    }
    return {outcome:result.outcome==='success'&&!['conflict','unconfirmed'].includes(cursorState)?'success':'degraded',
      reason:result.reason,run_id:initial.run_id,cursor_state:cursorState,counts:result.counts,inventory_complete:false};
  })(),90_000,'paid_recovery_control_deadline',stop);}catch{return {outcome:'degraded',reason:'control_unconfirmed'};}finally{stop();}
}

export async function paidOrderRecoveryStatus(source:RuntimeEnv){
  const snapshot=createOrderReadSnapshot(source,MAX_BYTES),env=snapshot.env;
  try{return await withinDeadline((async()=>{
    const [latest,current]=await Promise.all([readOrderMetadata<Observation>(env,`${PAID_RECOVERY_PREFIX}latest.json`,MAX_BYTES),
      readOrderMetadata<Cursor>(env,`${PAID_RECOVERY_PREFIX}cursor.json`,MAX_BYTES)]);snapshot.assertActive();
    if(latest&&!await validObservation(latest.record)||current&&!validCursor(current.record))throw new Error('paid_recovery_status_invalid');
    return {scope:'original_scoped_capture_preflight_delivery_drafts_only',enabled_by_configuration:source.OPERATIONS_CLOUD_ENABLED==='true'&&source.PAID_ORDER_DRAFT_RECOVERY_ENABLED==='true',
      latest:latest?.record??null,observation_freshness:!latest?'unknown':Date.now()-Date.parse(latest.record.result?.completed_at??latest.record.started_at)>3600_000?'stale':'fresh',
      cursor_checkpoint:current?{version:current.record.version,run_id:current.record.run_id,updated_at:current.record.updated_at}:null,
      inventory_complete:false,settlement_retries:false,new_captures:false,customer_revenue:null};
  })(),10_000,'paid_recovery_status_deadline',snapshot.cancel);}finally{snapshot.cancel();}
}
