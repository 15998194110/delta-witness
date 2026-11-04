import type { RuntimeEnv } from './env';
import { createOrderReadSnapshot, readOrderMetadata } from './order-storage';
import { createClaim, commitClaim } from './claims';
import { stableJson,sha256 } from './crypto';
import { withinDeadline } from './deadline';
import { projectOperatingReport, type OperatingReportInput, type RunOutcome } from './operating-report';
import { paidOrderRecoveryStatus } from './paid-recovery-control';
import {enqueueOperatingAlert,type AlertObservation} from './operating-alert-outbox';
import {readPaidAlertSource,checkpointPaidAlertSource,type PaidAlertSource} from './operating-paid-alert-source';

const PREFIX='operations/control/';
const MAX_BYTES=65_536;
const OUTCOMES=['success','degraded','failed','timeout','cancelled','skipped','unknown'] as const;
type Pulse={schema:'delta-cloud-pulse/v1';run_id:string;source_sha:string;source_payload_hash:string;observed_at:string;started_at:string;completed_at:string;
  duration_ms:number|null;outcome:typeof OUTCOMES[number];critical_ok:boolean;treasury:{state:'verified_declared_interval'|'unverified';from:number|null;through:number|null};
  api_health:'healthy'|'unverified';degraded_sources:number|null};
type Watchdog={schema:'delta-cloud-watchdog/v1';observed_at:string;outcome:string;reason:string;provider_scheduler_enabled:boolean|null;latest_run_id:string|null;latest_run_at:string|null;next_run:null};
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const number=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>=0;
const time=(x:unknown):string|null=>typeof x==='string'&&Number.isFinite(Date.parse(x))?new Date(x).toISOString():null;
function pulseRecord(value:unknown,now:number):Omit<Pulse,'source_payload_hash'> {
  if(!object(value)||value.schema!=='delta-pulse-status/v1'||!object(value.run)||!object(value.reporting)||value.reporting.phase!=='final'||
    !/^[1-9][0-9]{0,18}$/.test(String(value.run.id))||typeof value.run.source_sha!=='string'||!/^[0-9a-f]{40}$/.test(value.run.source_sha)||
    !OUTCOMES.includes(value.outcome as any)||typeof value.critical_ok!=='boolean')throw new Error('pulse_input_invalid');
  const observed=time(value.observed_at),started=time(value.started_at),completed=time(value.completed_at);
  if(!observed||!started||!completed||Date.parse(started)>Date.parse(completed)||Date.parse(completed)>Date.parse(observed)||Date.parse(observed)>now+30_000||
    (value.duration_ms!==null&&(!number(value.duration_ms)||value.duration_ms>3_600_000)))throw new Error('pulse_input_invalid');
  const treasury=object(value.treasury)?value.treasury:{};
  const covered=treasury.state==='verified_declared_interval'&&number(treasury.start_block)&&number(treasury.through_block)&&treasury.start_block<=treasury.through_block;
  const scanners=object(value.scanners)?Object.values(value.scanners):[];
  const degraded=scanners.length&&scanners.every(object)?scanners.filter((s:any)=>s.state!=='checked').length:null;
  return {schema:'delta-cloud-pulse/v1',run_id:String(value.run.id),source_sha:value.run.source_sha,observed_at:observed,started_at:started,completed_at:completed,
    duration_ms:value.duration_ms as number|null,outcome:value.outcome as Pulse['outcome'],critical_ok:value.critical_ok,
    treasury:{state:covered?'verified_declared_interval':'unverified',from:covered?treasury.start_block as number:null,through:covered?treasury.through_block as number:null},
    api_health:object(value.core)&&object(value.core.purchase_path)&&value.core.purchase_path.state==='verified'?'healthy':'unverified',degraded_sources:degraded};
}
function validStoredPulse(value:unknown):value is Pulse {
  const row=value as Pulse;return object(value)&&Object.keys(value).sort().join(',')===['schema','run_id','source_sha','source_payload_hash','observed_at','started_at','completed_at','duration_ms','outcome','critical_ok','treasury','api_health','degraded_sources'].sort().join(',')&&
    row.schema==='delta-cloud-pulse/v1'&&/^[1-9][0-9]{0,18}$/.test(row.run_id)&&
    /^[0-9a-f]{40}$/.test(row.source_sha)&&/^sha256:[0-9a-f]{64}$/.test(row.source_payload_hash)&&!!time(row.observed_at)&&!!time(row.started_at)&&!!time(row.completed_at)&&OUTCOMES.includes(row.outcome)&&
    Date.parse(row.started_at)<=Date.parse(row.completed_at)&&Date.parse(row.completed_at)<=Date.parse(row.observed_at)&&
    (row.duration_ms===null||number(row.duration_ms)&&row.duration_ms<=3_600_000)&&['healthy','unverified'].includes(row.api_health)&&
    (row.degraded_sources===null||number(row.degraded_sources))&&typeof row.critical_ok==='boolean'&&object(row.treasury)&&Object.keys(row.treasury).sort().join(',')==='from,state,through'&&
    (row.treasury.state==='unverified'?row.treasury.from===null&&row.treasury.through===null:
      row.treasury.state==='verified_declared_interval'&&number(row.treasury.from)&&number(row.treasury.through)&&row.treasury.from<=row.treasury.through);
}
function validWatchdog(row:unknown):row is Watchdog {
  return object(row)&&Object.keys(row).sort().join(',')===['schema','observed_at','outcome','reason','provider_scheduler_enabled','latest_run_id','latest_run_at','next_run'].sort().join(',')&&
    row.schema==='delta-cloud-watchdog/v1'&&!!time(row.observed_at)&&['disabled','checked','dispatched','degraded','recovery_required'].includes(String(row.outcome))&&
    typeof row.reason==='string'&&/^[a-z_]{1,80}$/.test(row.reason)&&(row.provider_scheduler_enabled===null||typeof row.provider_scheduler_enabled==='boolean')&&
    (row.latest_run_id===null||typeof row.latest_run_id==='string'&&/^[1-9][0-9]{0,18}$/.test(row.latest_run_id))&&(row.latest_run_at===null||!!time(row.latest_run_at))&&row.next_run===null;
}
export async function readOperatingJson(request:Request):Promise<unknown>{
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')||!request.body)throw new Error('operating_json_required');
  const reader=request.body.getReader();const cancel=()=>{void reader.cancel().catch(()=>{});};
  try{return await withinDeadline((async()=>{
    const parts:Uint8Array[]=[];let size=0;
    while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>MAX_BYTES)throw new Error('operating_body_limit');parts.push(next.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));
  })(),5_000,'operating_body_deadline',cancel);}finally{cancel();reader.releaseLock();}
}
// Authenticated runner assertions are operational observations. They do not
// confer payment, customer-revenue, accounting or artifact-access authority.
export async function recordOperatingPulse(source:RuntimeEnv,input:unknown,now=Date.now()){
  const row:Pulse={...pulseRecord(input,now),source_payload_hash:await sha256(JSON.stringify(input))};
  if(source.OPERATIONS_RELEASE_SHA&&source.OPERATIONS_RELEASE_SHA!==row.source_sha)throw new Error('pulse_release_mismatch');
  const snapshot=createOrderReadSnapshot(source,MAX_BYTES),env=snapshot.env;
  try{return await withinDeadline((async()=>{
    const key=`${PREFIX}pulse/runs/${row.run_id}.json`;
    const previous=await readOrderMetadata<Pulse>(env,key,MAX_BYTES);snapshot.assertActive();
    if(previous){if(stableJson(previous.record)!==stableJson(row))throw new Error('pulse_identity_conflict');}
    else{const saved=await createClaim(env,key,row);snapshot.assertActive();if(!saved)throw new Error('pulse_write_conflict');}
    const current=await readOrderMetadata<Pulse>(env,`${PREFIX}pulse/latest.json`,MAX_BYTES);snapshot.assertActive();
    if(current&&!validStoredPulse(current.record))throw new Error('pulse_previous_invalid');
    const position=(r:Pulse)=>`${r.started_at}|${r.run_id.padStart(19,'0')}`;
    if(!current||position(row)>position(current.record)){
      const saved=current?await commitClaim(env,`${PREFIX}pulse/latest.json`,current,row):await createClaim(env,`${PREFIX}pulse/latest.json`,row);snapshot.assertActive();
      if(!saved)throw new Error('pulse_latest_conflict');
    }
    if(row.outcome==='success'){
      const key=`${PREFIX}pulse/last-success.json`,success=await readOrderMetadata<Pulse>(env,key,MAX_BYTES);snapshot.assertActive();
      if(success&&(!validStoredPulse(success.record)||success.record.outcome!=='success'))throw new Error('pulse_success_invalid');
      if(!success||position(row)>position(success.record)){
        const saved=success?await commitClaim(env,key,success,row):await createClaim(env,key,row);snapshot.assertActive();if(!saved)throw new Error('pulse_success_conflict');
      }
    }
    return {ok:true,scope:'operational_observation_only',run_id:row.run_id,recorded:true,financial_verification:false,notification_delivered:null};
  })(),20_000,'operating_persistence_deadline',snapshot.cancel);}finally{snapshot.cancel();}
}
export async function operatingPulseReceipt(env:RuntimeEnv,id:string){
  if(!/^[1-9][0-9]{0,18}$/.test(id))throw new Error('pulse_identity_invalid');
  const snapshot=createOrderReadSnapshot(env,MAX_BYTES);
  try{return await withinDeadline((async()=>{
    const [saved,latest,success]=await Promise.all([readOrderMetadata<Pulse>(snapshot.env,`${PREFIX}pulse/runs/${id}.json`,MAX_BYTES),
      readOrderMetadata<Pulse>(snapshot.env,`${PREFIX}pulse/latest.json`,MAX_BYTES),readOrderMetadata<Pulse>(snapshot.env,`${PREFIX}pulse/last-success.json`,MAX_BYTES)]);snapshot.assertActive();
    if([saved,latest,success].some(row=>row&&!validStoredPulse(row.record))||success&&success.record.outcome!=='success')throw new Error('operating_snapshot_invalid');
    const position=(row:Pulse)=>`${row.started_at}|${row.run_id.padStart(19,'0')}`;
    return saved?{ok:true,recorded:true,run_id:saved.record.run_id,source_sha:saved.record.source_sha,source_payload_hash:saved.record.source_payload_hash,observed_at:saved.record.observed_at,
      latest_projection_at_or_after_run:!!latest&&position(latest.record)>=position(saved.record),
      last_success_at_or_after_run:saved.record.outcome!=='success'?null:!!success&&position(success.record)>=position(saved.record),scope:'operational_observation_only'}:
      {ok:true,recorded:false,run_id:id,scope:'operational_observation_only'};
  })(),10_000,'operating_receipt_deadline',snapshot.cancel);}finally{snapshot.cancel();}
}
export async function recordWatchdogObservation(source:RuntimeEnv,value:Record<string,unknown>,now=Date.now()){
  if(source.OPERATIONS_CLOUD_ENABLED!=='true')return;
  const row:Watchdog={schema:'delta-cloud-watchdog/v1',observed_at:new Date(now).toISOString(),
    outcome:['disabled','checked','dispatched','degraded','recovery_required'].includes(String(value.outcome))?String(value.outcome):'degraded',
    reason:typeof value.reason==='string'&&/^[a-z_]{1,80}$/.test(value.reason)?value.reason:'unknown',
    provider_scheduler_enabled:typeof value.provider_scheduler_enabled==='boolean'?value.provider_scheduler_enabled:null,
    latest_run_id:typeof value.latest_run_id==='string'&&/^[1-9][0-9]{0,18}$/.test(value.latest_run_id)?value.latest_run_id:null,
    latest_run_at:time(value.latest_run_at),next_run:null};
  const snapshot=createOrderReadSnapshot(source,8_192),env=snapshot.env;
  try{await withinDeadline((async()=>{
    const key=`${PREFIX}watchdog/latest.json`,current=await readOrderMetadata<Watchdog>(env,key,8_192);snapshot.assertActive();
    if(current&&!validWatchdog(current.record))throw new Error('watchdog_previous_invalid');
    if(current&&current.record.observed_at>=row.observed_at)return;
    const saved=current?await commitClaim(env,key,current,row):await createClaim(env,key,row);snapshot.assertActive();if(!saved)throw new Error('watchdog_observation_conflict');
  })(),10_000,'operating_persistence_deadline',snapshot.cancel);}finally{snapshot.cancel();}
}
export async function operatingStatus(source:RuntimeEnv,now=Date.now(),paidAlertPage?:PaidAlertSource){
  const snapshot=createOrderReadSnapshot(source,MAX_BYTES),env=snapshot.env;
  try{return await withinDeadline((async()=>{
    const [p,w,s,paidRecovery,paidAlerts]=await Promise.all([readOrderMetadata<Pulse>(env,`${PREFIX}pulse/latest.json`,MAX_BYTES),readOrderMetadata<Watchdog>(env,`${PREFIX}watchdog/latest.json`,8_192),readOrderMetadata<Pulse>(env,`${PREFIX}pulse/last-success.json`,MAX_BYTES),
      paidOrderRecoveryStatus(source).catch(()=>null),paidAlertPage??readPaidAlertSource(source)]);snapshot.assertActive();
    if(p&&!validStoredPulse(p.record))throw new Error('operating_snapshot_invalid');
    if(s&&(!validStoredPulse(s.record)||s.record.outcome!=='success'))throw new Error('operating_snapshot_invalid');
    const watchdog=w?.record;
    if(watchdog&&!validWatchdog(watchdog))throw new Error('operating_snapshot_invalid');
    const evidence=(value:any,observed:string,id:string)=>({value,observed_at:observed,evidence_id:id});
    const pulse=p?.record,run=pulse&&pulse.outcome!=='unknown'?{id:pulse.run_id,outcome:pulse.outcome as RunOutcome,started_at:pulse.started_at,completed_at:pulse.completed_at,duration_ms:pulse.duration_ms}:undefined;
    const scheduler:NonNullable<OperatingReportInput['schedulers']>[number]={id:'github-pulse',
      ...(watchdog?.provider_scheduler_enabled!==null&&watchdog?.provider_scheduler_enabled!==undefined?{provider_config:evidence(watchdog.provider_scheduler_enabled?'enabled':'disabled',watchdog.observed_at,'github-workflow-state')}:{}) ,
      expected_interval_seconds:evidence(3_600,new Date(now).toISOString(),'declared-hourly-policy'),
      ...(run?{run:evidence(run,pulse!.observed_at,`github-run-${pulse!.run_id}`)}:{}),
      ...(s?{last_success:evidence(s.record.completed_at,s.record.observed_at,`github-success-${s.record.run_id}`)}:{})};
    // Missing joins/invoices never become zero. Even a verified Treasury
    // interval below supplies coverage, not customer revenue or actual costs.
    const report=projectOperatingReport({schedulers:[scheduler,{id:'cloudflare-cron'}],business:{paid_undelivered:paidAlerts.issues},
      ...(pulse?.treasury.state==='verified_declared_interval'?{rpc_coverage:evidence({status:'complete',from_block:pulse.treasury.from!,through_block:pulse.treasury.through!},pulse.observed_at,`treasury-run-${pulse.run_id}`)}:{}),
      ...(p||w?{persistence:evidence('stored',new Date(now).toISOString(),'r2-operating-readback')}:{})},Math.max(now,Date.now()));
    // The independent consumer observation is not a financial join. Missing or
    // corrupt recovery metadata must not erase the other lane observations.
    return {ok:true,report,source_inventory_complete:false,cloud:{enabled_by_configuration:source.OPERATIONS_CLOUD_ENABLED==='true',watchdog:watchdog??null,
      pulse_observation:pulse??null,background_paid_order_recovery_connected:paidRecovery?.enabled_by_configuration===true&&paidRecovery.observation_freshness==='fresh',
      background_paid_order_recovery_health:paidRecovery?.business_work_health.outcome??'unknown',
      paid_order_draft_recovery:paidRecovery,paid_alert_source:{state:paidAlerts.state,scope:paidAlerts.scope,inventory_complete:false,
        selected:paidAlerts.observation?.items.length??null,observed_at:paidAlerts.observation?.observed_at??null,
        unknown:paidAlerts.observation?.items.filter(item=>!item.summary||item.summary.state==='unknown').length??null},
      notification_adapter_configured:null,canonical_operator_pipeline_migrated:false,
      alert_outbox:{enabled_by_configuration:source.OPERATIONS_ALERT_OUTBOX_ENABLED==='true',provider_sender_configured:null,
        delivery_enabled_by_configuration:source.OPERATIONS_ALERT_DELIVERY_ENABLED==='true',adapter_implementation:'resend/v1',notification_delivered:null},
      failure_rate:null,recovery_count:null,buyer_leads_total:null,qualified_leads_total:null},
      financial_scope:'Source snapshots are not a ledger. Original orders, receipts, refunds and actual invoices must be joined separately.'};
  })(),15_000,'operating_status_deadline',snapshot.cancel);}finally{snapshot.cancel();}
}

// Persist incident intent independently. Provider permission/delivery is not
// inferred from destination configuration, and this function has no transport.
export async function persistOperatingAlertCandidates(source:RuntimeEnv){
  if(source.OPERATIONS_CLOUD_ENABLED!=='true'||source.OPERATIONS_ALERT_OUTBOX_ENABLED!=='true')return {state:'disabled'};
  const snapshot=createOrderReadSnapshot(source,65_536),env=snapshot.env;
  try{return await withinDeadline((async()=>{
    const paidPage=await readPaidAlertSource(source);snapshot.assertActive();
    const status=await operatingStatus(source,Date.now(),paidPage);snapshot.assertActive();
    const candidates=status.report.alerts.filter(a=>a.notification_decision.action!=='local_only').sort((a,b)=>Number(b.code==='paid_undelivered')-Number(a.code==='paid_undelivered')).slice(0,5);
    const destination=source.OPERATIONS_ALERT_DESTINATION_ID&&source.OPERATIONS_ALERT_DESTINATION_DIGEST?
      {id:source.OPERATIONS_ALERT_DESTINATION_ID,digest:source.OPERATIONS_ALERT_DESTINATION_DIGEST}:null;
    const results=[];
    for(const alert of candidates){snapshot.assertActive();const e:AlertObservation={dedupe_key:alert.dedupe_key,code:alert.code as AlertObservation['code'],
      subject:alert.subject,severity:alert.severity,stage:alert.escalation.state==='due'?'escalated':'initial',first_seen_at:alert.first_seen_at,evidence_ref:alert.evidence_ids[0]};
      results.push(await enqueueOperatingAlert(env,e,destination));snapshot.assertActive();}
    const established=results.every(result=>'notification_id' in result&&!!result.notification_id);
    const paidSourceCheckpoint=established?await checkpointPaidAlertSource(source,paidPage):{state:'retained',reason:'alert_intent_unconfirmed'};snapshot.assertActive();
    return {state:'observations_checked',selected:candidates.length,results,paid_source_checkpoint:paidSourceCheckpoint,notification_delivered:null};
  })(),40000,'alert_projection_deadline',snapshot.cancel);}finally{snapshot.cancel();}
}
