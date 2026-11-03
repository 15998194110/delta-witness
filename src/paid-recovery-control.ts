// Original-order recovery orchestration, not a new fulfillment/payment rail.
// One reservation per existing Cron event; the original fulfillment ETag alone
// authorizes its completion. Scan cursors never authorize browser/payment work.
import type { RuntimeEnv } from './env';
import { createClaim, commitClaim } from './claims';
import { createOrderReadSnapshot, readOrderMetadata } from './order-storage';
import { sha256, stableJson } from './crypto';
import { withinDeadline } from './deadline';
import { runPaidOrderRecovery, validatePaidOrderRecoveryResult, type PaidOrderRecoveryResult } from './paid-order-recovery';
import {drainPaidRecoveryPriority,enqueuePaidRecoveryPriority,paidRecoveryPriorityStatus,type PaidRecoveryPriorityResult} from './paid-recovery-priority';

export const PAID_RECOVERY_PREFIX = 'operations/paid-order-recovery/';
const MAX_BYTES = 16_384;
type Cursor = { schema:'delta-paid-recovery-cursor/v1'; version:number; cursor:string|null; run_id:string; updated_at:string };
type LegacyObservation = { schema:'delta-paid-recovery-observation/v1'; run_id:string; scheduled_at:string; started_at:string;
  state:'started'|'observed'; result:PaidOrderRecoveryResult|null; result_hash:string|null };
type PrioritySummary = Pick<PaidRecoveryPriorityResult,'outcome'|'reason'|'inventory_complete'|'counts'>;
type EnrollmentSummary = { attempted:number; unconfirmed:number };
type WorkObservation = { scope:'priority_drain_and_compatibility_scan'; priority:PrioritySummary; enrollment:EnrollmentSummary;
  outcome:'success'|'degraded'; reason:string };
type CurrentObservation = Omit<LegacyObservation,'schema'> & { schema:'delta-paid-recovery-observation/v2';
  work:WorkObservation|null; work_hash:string|null };
type Observation = LegacyObservation | CurrentObservation;
const iso = (v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const uuid = (v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const cursor = (v:unknown):v is string|null=>v===null||typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\u0000-\u001f\u007f]/.test(v);
const keys = (v:unknown,expected:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===expected.sort().join(',');
function validCursor(v:unknown):v is Cursor {
  const r=v as Cursor;return keys(r,['schema','version','cursor','run_id','updated_at'])&&r.schema==='delta-paid-recovery-cursor/v1'&&
    Number.isSafeInteger(r.version)&&r.version>0&&cursor(r.cursor)&&uuid(r.run_id)&&iso(r.updated_at);
}
function validPriority(v:unknown):v is PrioritySummary {
  const r=v as PrioritySummary;
  if(!keys(r,['outcome','reason','inventory_complete','counts'])||r.inventory_complete!==false||
      !keys(r.counts,['selected','inspected','recovered','already_complete','skipped','retry_scheduled','quarantined','conflicts','write_unconfirmed'])||
      Object.values(r.counts).some(n=>!Number.isSafeInteger(n)||n<0||n>3))return false;
  const c=r.counts,problems=c.retry_scheduled+c.quarantined+c.conflicts+c.write_unconfirmed;
  if(c.inspected>c.selected||c.inspected!==c.recovered+c.already_complete+c.skipped+problems)return false;
  return r.outcome==='success'?r.reason==='none'&&problems===0&&c.inspected===c.selected:
    r.outcome==='degraded'&&(r.reason==='priority_unconfirmed'||r.reason==='priority_requires_reconciliation'&&problems>0&&c.inspected===c.selected);
}
function workResult(priority:PrioritySummary,result:PaidOrderRecoveryResult,enrollment:EnrollmentSummary):WorkObservation {
  const reason=priority.outcome==='degraded'?'priority_requires_reconciliation':
    enrollment.unconfirmed>0?'priority_enrollment_unconfirmed':result.reason;
  return {scope:'priority_drain_and_compatibility_scan',priority,enrollment,outcome:reason==='none'?'success':'degraded',reason};
}
function validWork(v:unknown,result:PaidOrderRecoveryResult):v is WorkObservation {
  const r=v as WorkObservation;
  if(!keys(r,['scope','priority','enrollment','outcome','reason'])||!validPriority(r.priority)||
      !keys(r.enrollment,['attempted','unconfirmed'])||Object.values(r.enrollment).some(n=>!Number.isSafeInteger(n)||n<0||n>5)||
      r.enrollment.unconfirmed>r.enrollment.attempted||
      r.enrollment.attempted!==result.items.filter(item=>['reconciliation_required','write_unconfirmed','concurrent'].includes(item.state)).length)return false;
  return stableJson(r)===stableJson(workResult(r.priority,result,r.enrollment));
}
async function validObservation(v:unknown):Promise<boolean>{
  const r=v as Observation,current=r?.schema==='delta-paid-recovery-observation/v2';
  if(!keys(r,['schema','run_id','scheduled_at','started_at','state','result','result_hash',...(current?['work','work_hash']:[])])||
    !['delta-paid-recovery-observation/v1','delta-paid-recovery-observation/v2'].includes(r.schema)||!uuid(r.run_id)||!iso(r.scheduled_at)||!iso(r.started_at)||Date.parse(r.started_at)>Date.now())return false;
  if(r.state==='started')return r.result===null&&r.result_hash===null&&
    (r.schema==='delta-paid-recovery-observation/v1'||r.work===null&&r.work_hash===null);
  if(r.state!=='observed'||!validatePaidOrderRecoveryResult(r.result)||!/^sha256:[0-9a-f]{64}$/.test(r.result_hash??'')||
    r.result_hash!==await sha256(stableJson(r.result)))return false;
  if(r.schema==='delta-paid-recovery-observation/v2'&&(!validWork(r.work,r.result)||
      !/^sha256:[0-9a-f]{64}$/.test(r.work_hash??'')||r.work_hash!==await sha256(stableJson(r.work))))return false;
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
    const initial:CurrentObservation={schema:'delta-paid-recovery-observation/v2',run_id:crypto.randomUUID(),scheduled_at:new Date(scheduledTime).toISOString(),
      started_at:new Date().toISOString(),state:'started',result:null,result_hash:null,work:null,work_hash:null};
    const reserved=await createClaim(env,key,initial);check();
    if(!reserved)return {outcome:'skipped',reason:'event_reservation_conflict'};
    // Spend the first business-work budget on known paid obligations. The
    // bounded compatibility sweep still discovers older unindexed originals.
    const priority=await drainPaidRecoveryPriority(source,{maxOrders:3,deadlineMs:30000,signal:controller.signal});check();
    const result=await runPaidOrderRecovery(source,{...(prior?.record.cursor?{cursor:prior.record.cursor}:{}),maxOrders:5,deadlineMs:20000,signal:controller.signal});check();
    const enrollment:EnrollmentSummary={attempted:0,unconfirmed:0};
    for(const item of result.items){
      if(['reconciliation_required','write_unconfirmed','concurrent'].includes(item.state)){
        enrollment.attempted++;
        const enrolled=await enqueuePaidRecoveryPriority(source,item.order_id,{deadlineMs:1000,signal:controller.signal});check();
        if(enrolled.outcome==='degraded')enrollment.unconfirmed++;
      }
    }
    // This is business-work evidence only. Cursor advancement and latest
    // projection happen afterward and are not established by this record.
    const work=workResult({outcome:priority.outcome,reason:priority.reason,inventory_complete:false,counts:priority.counts},result,enrollment);
    const observed:CurrentObservation={...initial,state:'observed',result,result_hash:await sha256(stableJson(result)),work,work_hash:await sha256(stableJson(work))};
    if(!await validObservation(observed))throw new Error('paid_recovery_observation_invalid');
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
    return {outcome:work.outcome==='success'&&!['conflict','unconfirmed'].includes(cursorState)?'success':'degraded',
      reason:['conflict','unconfirmed'].includes(cursorState)?'cursor_update_unconfirmed':work.reason,run_id:initial.run_id,cursor_state:cursorState,counts:result.counts,priority_counts:priority.counts,inventory_complete:false};
  })(),90_000,'paid_recovery_control_deadline',stop);}catch{return {outcome:'degraded',reason:'control_unconfirmed'};}finally{stop();}
}

export async function paidOrderRecoveryStatus(source:RuntimeEnv){
  const snapshot=createOrderReadSnapshot(source,MAX_BYTES),env=snapshot.env;
  try{return await withinDeadline((async()=>{
    const [latest,current,priority]=await Promise.all([readOrderMetadata<Observation>(env,`${PAID_RECOVERY_PREFIX}latest.json`,MAX_BYTES),
      readOrderMetadata<Cursor>(env,`${PAID_RECOVERY_PREFIX}cursor.json`,MAX_BYTES),paidRecoveryPriorityStatus(source).catch(()=>null)]);snapshot.assertActive();
    if(latest&&!await validObservation(latest.record)||current&&!validCursor(current.record))throw new Error('paid_recovery_status_invalid');
    const freshness=!latest?'unknown':Date.now()-Date.parse(latest.record.result?.completed_at??latest.record.started_at)>3600_000?'stale':'fresh';
    const work=latest?.record.schema==='delta-paid-recovery-observation/v2'?latest.record.work:null;
    return {scope:'original_scoped_capture_preflight_delivery_drafts_only',enabled_by_configuration:source.OPERATIONS_CLOUD_ENABLED==='true'&&source.PAID_ORDER_DRAFT_RECOVERY_ENABLED==='true',
      latest:latest?.record??null,observation_freshness:freshness,
      business_work_health:{scope:'priority_drain_and_compatibility_scan',outcome:priority===null?'degraded':freshness==='fresh'&&work?work.outcome:'unknown',
        reason:priority===null?'priority_read_unavailable':freshness==='fresh'&&work?work.reason:latest?.record.schema==='delta-paid-recovery-observation/v1'?'legacy_priority_unknown':'work_observation_unavailable',
        control_completion:'not_established_by_work_observation'},
      cursor_checkpoint:current?{version:current.record.version,run_id:current.record.run_id,updated_at:current.record.updated_at}:null,
      priority,priority_read_state:priority===null?'unavailable':'available',inventory_complete:false,settlement_retries:false,new_captures:false,customer_revenue:null};
  })(),10_000,'paid_recovery_status_deadline',snapshot.cancel);}finally{snapshot.cancel();}
}
