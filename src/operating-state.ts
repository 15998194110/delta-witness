import type { RuntimeEnv } from './env';
import { sha256, stableJson, uuidFromDigest } from './crypto';
import { createClaim, commitClaim, type StoredClaim } from './claims';
import { readOrderMetadata, StorageWriteError } from './order-storage';
import { withinDeadline } from './deadline';

export const OPERATING_STATE_MAX_BYTES = 32_000;
export const OPERATING_STATE_DEADLINE_MS = 20_000;
export const OPERATING_HISTORY_LIMIT = 64;
export const OPERATING_MAX_RUN_MS = 3_600_000;
const PREFIX = 'operations/tasks/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const STATES = ['pending','running','retry_wait','recovery_required','dead_letter','succeeded'] as const;
const REASONS = ['created','claimed','checkpointed','lease_renewed','succeeded','retryable_failure','permanent_failure',
  'external_outcome_unknown','lease_expired','attempts_exhausted','reconciled_succeeded','reconciled_not_applied'] as const;
export type OperatingState = typeof STATES[number];
export type OperatingReason = typeof REASONS[number];
export type OperatingCheckpoint = { completed_units: number; cursor: { kind: 'block'|'page'|'offset'; value: number } | null; evidence_hash: string | null };
export type OperatingRetryPolicy = { max_attempts: number; base_delay_ms: number; max_delay_ms: number; max_run_ms: number };
type Frame = { state: OperatingState; run_id: string|null; generation: number; attempts: number; started_at: string|null;
  operation_deadline_at: string|null; lease_until: string|null; next_attempt_at: string|null; checkpoint: OperatingCheckpoint;
  evidence_hash: string|null; reason: OperatingReason };
export type OperatingHistory = Frame & { revision: number; operation_id: string; request_hash: string; at: string };
export type OperatingTask = Frame & {
  schema: 'delta-operating-task/v1'; scope: 'operational_coordination_no_financial_authority'; task_id: string; kind: string;
  idempotency_key: string; payload_hash: string; operation_class: 'read_only'|'external_mutation'; scheduled_at: string; created_at: string;
  updated_at: string; revision: number; retry: OperatingRetryPolicy; history: OperatingHistory[];
};
export type OperatingLease = { run_id: string; generation: number; etag: string };
export type OperatingResult = { status: 'created'|'updated'|'replayed'|'missing'|'blocked'|'conflict'|'unavailable'|'unconfirmed';
  execute: boolean; reason: string; task?: OperatingTask; etag?: string; lease?: OperatingLease };
export type OperatingReadback = { source: 'adapter_verified_readback'; task_id: string; run_id: string; generation: number;
  payload_hash: string; evidence_hash: string; observed_at: string; result: 'succeeded'|'not_applied'|'unknown' };
type Options = { now?: ()=>number; random?: ()=>number };
const keys = (x: unknown, expected: string[]): boolean => !!x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === [...expected].sort().join(',');
const integer = (x: unknown, min=0, max=Number.MAX_SAFE_INTEGER): x is number => Number.isSafeInteger(x) && Number(x)>=min && Number(x)<=max;
const iso = (x: unknown): x is string => typeof x==='string' && Number.isFinite(Date.parse(x)) && new Date(x).toISOString()===x;
const hash = (x: unknown): x is string => typeof x==='string' && HASH.test(x);
const evidenceHash = (x: unknown): x is string => hash(x) && x !== `sha256:${'0'.repeat(64)}`;
const frameKeys = ['state','run_id','generation','attempts','started_at','operation_deadline_at','lease_until','next_attempt_at','checkpoint','evidence_hash','reason'];
const taskKeys = [...frameKeys,'schema','scope','task_id','kind','idempotency_key','payload_hash','operation_class','scheduled_at','created_at','updated_at','revision','retry','history'];
const emptyCheckpoint = ():OperatingCheckpoint => ({completed_units:0,cursor:null,evidence_hash:null});
const frame = (row:Frame):Frame => Object.fromEntries(frameKeys.map(key=>[key,row[key as keyof Frame]])) as Frame;
const fail = (reason:string,status:OperatingResult['status']='blocked'):OperatingResult => ({status,execute:false,reason});
function validPolicy(value: unknown): value is OperatingRetryPolicy {
  const r=value as OperatingRetryPolicy;
  return keys(r,['max_attempts','base_delay_ms','max_delay_ms','max_run_ms']) && integer(r.max_attempts,1,8) &&
    integer(r.base_delay_ms,1_000,3_600_000) && integer(r.max_delay_ms,r.base_delay_ms,3_600_000) && integer(r.max_run_ms,5_000,OPERATING_MAX_RUN_MS);
}
export function validateOperatingCheckpoint(value:unknown):value is OperatingCheckpoint {
  const row=value as OperatingCheckpoint;
  return keys(row,['completed_units','cursor','evidence_hash']) && integer(row.completed_units) &&
    (row.cursor===null || keys(row.cursor,['kind','value']) && ['block','page','offset'].includes(row.cursor.kind) && integer(row.cursor.value)) &&
    (row.evidence_hash===null || evidenceHash(row.evidence_hash));
}
function validFrame(row:Frame):boolean {
  return STATES.includes(row.state) && REASONS.includes(row.reason) && integer(row.generation,0,8) && integer(row.attempts,0,8) && row.generation===row.attempts &&
    (row.state==='pending'?row.attempts===0:row.attempts>0) &&
    (row.run_id===null || typeof row.run_id==='string' && UUID4.test(row.run_id)) &&
    [row.started_at,row.operation_deadline_at,row.lease_until,row.next_attempt_at].every(v=>v===null||iso(v)) &&
    validateOperatingCheckpoint(row.checkpoint) && (row.evidence_hash===null||evidenceHash(row.evidence_hash)) &&
    (row.attempts===0 ? row.run_id===null && row.started_at===null && row.operation_deadline_at===null : row.run_id!==null && row.started_at!==null && row.operation_deadline_at!==null && Date.parse(row.operation_deadline_at)>Date.parse(row.started_at)) &&
    (row.state==='running' ? row.lease_until!==null && row.operation_deadline_at!==null && Date.parse(row.lease_until)<=Date.parse(row.operation_deadline_at) : row.lease_until===null) &&
    (row.state==='retry_wait' ? row.next_attempt_at!==null : row.next_attempt_at===null);
}
export function validateOperatingLease(value:unknown):value is OperatingLease {
  const row=value as OperatingLease;return keys(row,['run_id','generation','etag'])&&UUID4.test(row.run_id)&&integer(row.generation,1,8)&&typeof row.etag==='string'&&row.etag.length>0&&row.etag.length<=256;
}
export function validateOperatingReadback(value:unknown):value is OperatingReadback {
  const row=value as OperatingReadback;
  return keys(row,['source','task_id','run_id','generation','payload_hash','evidence_hash','observed_at','result'])&&row.source==='adapter_verified_readback'&&
    UUID.test(row.task_id)&&UUID4.test(row.run_id)&&integer(row.generation,1,8)&&hash(row.payload_hash)&&evidenceHash(row.evidence_hash)&&iso(row.observed_at)&&['succeeded','not_applied','unknown'].includes(row.result);
}
export async function deriveOperatingTaskId(kind:string,idempotencyKey:string):Promise<string> {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(kind)||!hash(idempotencyKey)) throw new Error('invalid_operating_identity');
  return uuidFromDigest(await sha256(`delta-operating-task/v1\n${kind}\n${idempotencyKey}`));
}
export async function validateOperatingTask(value:unknown,expectedId?:string):Promise<boolean> {
  const row=value as OperatingTask;
  if(!keys(row,taskKeys)||row.schema!=='delta-operating-task/v1'||row.scope!=='operational_coordination_no_financial_authority'||
    typeof row.task_id!=='string'||!UUID.test(row.task_id)||expectedId!==undefined&&row.task_id!==expectedId||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(row.kind)||!hash(row.idempotency_key)||!hash(row.payload_hash)||
    !['read_only','external_mutation'].includes(row.operation_class)||!iso(row.scheduled_at)||!iso(row.created_at)||!iso(row.updated_at)||
    !integer(row.revision,1,OPERATING_HISTORY_LIMIT)||!validPolicy(row.retry)||!validFrame(row)||row.attempts>row.retry.max_attempts||
    !Array.isArray(row.history)||row.history.length!==row.revision) return false;
  if(await deriveOperatingTaskId(row.kind,row.idempotency_key)!==row.task_id)return false;
  const seen=new Set<string>();
  for(const [index,entry] of row.history.entries()){
    if(!keys(entry,[...frameKeys,'revision','operation_id','request_hash','at'])||!validFrame(entry)||entry.revision!==index+1||
      !UUID4.test(entry.operation_id)||!hash(entry.request_hash)||!iso(entry.at)||seen.has(entry.operation_id)||
      index>0 && Date.parse(entry.at)<Date.parse(row.history[index-1].at))return false;
    seen.add(entry.operation_id);
  }
  return stableJson(frame(row))===stableJson(frame(row.history.at(-1)!)) && row.updated_at===row.history.at(-1)!.at;
}
export function operatingBackoff(attempt:number,policy:OperatingRetryPolicy,random= Math.random):number {
  if(!integer(attempt,1,8)||!validPolicy(policy))throw new Error('invalid_operating_retry');
  const unit=random();if(!Number.isFinite(unit)||unit<0||unit>=1)throw new Error('invalid_operating_random');
  const cap=Math.min(policy.max_delay_ms,policy.base_delay_ms*2**(attempt-1));
  return Math.floor(cap/2 + unit*(cap-cap/2));
}
type Context = {assertActive:()=>void;now:()=>number;writeStarted:boolean};
async function boundary(operation:(context:Context)=>Promise<OperatingResult>,options:Options):Promise<OperatingResult>{
  let active=true;const context:Context={assertActive(){if(!active)throw new Error('operating_deadline');},now:options.now??Date.now,writeStarted:false};
  try{return await withinDeadline(operation(context),OPERATING_STATE_DEADLINE_MS,'operating_deadline',()=>{active=false;});}
  catch(error){return fail(context.writeStarted||error instanceof StorageWriteError?'operating_write_unconfirmed':'operating_evidence_unavailable',context.writeStarted||error instanceof StorageWriteError?'unconfirmed':'unavailable');}
  finally{active=false;}
}
async function read(env:RuntimeEnv,id:string,context:Context):Promise<StoredClaim<OperatingTask>|null>{
  if(!UUID.test(id))throw new Error('invalid_operating_identity');
  const stored=await readOrderMetadata<OperatingTask>(env,`${PREFIX}${id}.json`,OPERATING_STATE_MAX_BYTES);context.assertActive();
  if(stored&&(!stored.etag||!await validateOperatingTask(stored.record,id)))throw new Error('invalid_operating_evidence');
  context.assertActive();return stored;
}
export async function getOperatingTask(env:RuntimeEnv,id:string,options:Options={}):Promise<OperatingResult>{
  return boundary(async context=>{const stored=await read(env,id,context);return stored?{status:'replayed',execute:false,reason:'read_only',task:stored.record,etag:stored.etag}:fail('task_missing','missing');},options);
}
function replay(claim:StoredClaim<OperatingTask>,operationId:string,requestHash:string):OperatingResult|null{
  const prior=claim.record.history.find(row=>row.operation_id===operationId);
  return prior ? prior.request_hash===requestHash ? {status:'replayed',execute:false,reason:'original_operation_recorded',task:claim.record,etag:claim.etag} : fail('operation_identity_conflict','conflict') : null;
}
function live(claim:StoredClaim<OperatingTask>,lease:OperatingLease,now:number):boolean {
  const r=claim.record;return r.state==='running'&&r.run_id===lease.run_id&&r.generation===lease.generation&&claim.etag===lease.etag&&
    !!r.lease_until&&!!r.operation_deadline_at&&now<Date.parse(r.lease_until)&&now<Date.parse(r.operation_deadline_at);
}
async function save(env:RuntimeEnv,claim:StoredClaim<OperatingTask>,patch:Partial<Frame>,operationId:string,requestHash:string,context:Context,reservedSlots=0,execute=false,expectedLease?:OperatingLease):Promise<OperatingResult>{
  if(claim.record.history.length+1+reservedSlots>OPERATING_HISTORY_LIMIT)return fail('history_capacity_requires_reconciliation');
  const at=new Date(context.now()).toISOString();
  if(Date.parse(at)<Date.parse(claim.record.updated_at))return fail('clock_regression');
  const next={...claim.record,...patch,updated_at:at,revision:claim.record.revision+1};
  next.history=[...claim.record.history,{...frame(next),revision:next.revision,operation_id:operationId,request_hash:requestHash,at}];
  // Reserve bounded space before allowing work, not after an external outcome.
  if(new TextEncoder().encode(JSON.stringify(next)).byteLength+reservedSlots*1536>OPERATING_STATE_MAX_BYTES||!await validateOperatingTask(next,claim.record.task_id))return fail('invalid_or_oversized_transition');
  context.assertActive();if(expectedLease&&!live(claim,expectedLease,context.now()))return fail('stale_or_expired_lease');context.writeStarted=true;
  const saved=await commitClaim(env,`${PREFIX}${next.task_id}.json`,claim,next);context.assertActive();
  if(!saved)return fail('task_cas_conflict','conflict');
  const lease=next.state==='running'?{run_id:next.run_id!,generation:next.generation,etag:saved.etag}:undefined;
  // A delayed ACK never grants permission after the lease/deadline passed.
  if(lease&&!live(saved,lease,context.now()))return {status:'updated',execute:false,reason:'lease_expired_after_ack',task:next,etag:saved.etag};
  return {status:'updated',execute,reason:'transition_recorded',task:next,etag:saved.etag,...(lease?{lease}:{})};
}
export async function createOperatingTask(env:RuntimeEnv,input:{kind:string;idempotency_key:string;payload_hash:string;operation_class:'read_only'|'external_mutation';scheduled_at:string;operation_id:string;retry:OperatingRetryPolicy;expected_task_id?:string},options:Options={}):Promise<OperatingResult>{
  if(!UUID4.test(input.operation_id)||!hash(input.payload_hash)||!hash(input.idempotency_key)||!/^[a-z][a-z0-9_-]{0,63}$/.test(input.kind)||!iso(input.scheduled_at)||!validPolicy(input.retry)||!['read_only','external_mutation'].includes(input.operation_class))return fail('invalid_task_input');
  return boundary(async context=>{
    const id=await deriveOperatingTaskId(input.kind,input.idempotency_key),prior=await read(env,id,context);
    if(input.expected_task_id!==undefined&&input.expected_task_id!==id)return fail('task_identity_conflict','conflict');
    if(prior){const r=prior.record;return r.payload_hash===input.payload_hash&&r.operation_class===input.operation_class&&r.scheduled_at===input.scheduled_at&&stableJson(r.retry)===stableJson(input.retry)?{status:'replayed',execute:false,reason:'original_task_recorded',task:r,etag:prior.etag}:fail('task_payload_conflict','conflict');}
    const at=new Date(context.now()).toISOString(),base:Frame={state:'pending',run_id:null,generation:0,attempts:0,started_at:null,operation_deadline_at:null,lease_until:null,next_attempt_at:null,checkpoint:emptyCheckpoint(),evidence_hash:null,reason:'created'};
    const requestHash=await sha256(stableJson(input));
    const record:OperatingTask={...base,schema:'delta-operating-task/v1',scope:'operational_coordination_no_financial_authority',task_id:id,kind:input.kind,
      idempotency_key:input.idempotency_key,payload_hash:input.payload_hash,operation_class:input.operation_class,scheduled_at:input.scheduled_at,created_at:at,updated_at:at,revision:1,retry:{...input.retry},
      history:[{...base,revision:1,operation_id:input.operation_id,request_hash:requestHash,at}]};
    context.assertActive();context.writeStarted=true;const saved=await createClaim(env,`${PREFIX}${id}.json`,record);context.assertActive();
    return saved?{status:'created',execute:false,reason:'task_recorded',task:record,etag:saved.etag}:fail('task_cas_conflict','conflict');
  },options);
}
export async function claimOperatingTask(env:RuntimeEnv,id:string,input:{run_id:string;operation_id:string;lease_ms?:number},options:Options={}):Promise<OperatingResult>{
  const leaseMs=input.lease_ms??120_000;if(!UUID4.test(input.run_id)||!UUID4.test(input.operation_id)||!integer(leaseMs,5_000,OPERATING_MAX_RUN_MS))return fail('invalid_claim_input');
  return boundary(async context=>{
    const claim=await read(env,id,context);if(!claim)return fail('task_missing','missing');
    const requestHash=await sha256(stableJson(input)),replayed=replay(claim,input.operation_id,requestHash);if(replayed)return replayed;
    const r=claim.record,now=context.now();
    if(!['pending','retry_wait'].includes(r.state))return fail(r.state==='running'?'original_run_requires_readback':'task_not_claimable');
    if(r.history.some(row=>row.run_id===input.run_id))return fail('run_identity_already_used','conflict');
    if(now<Date.parse(r.next_attempt_at??r.scheduled_at))return fail('task_not_due');
    if(r.attempts>=r.retry.max_attempts)return fail('attempts_exhausted');
    const deadline=now+r.retry.max_run_ms;
    return save(env,claim,{state:'running',run_id:input.run_id,generation:r.generation+1,attempts:r.attempts+1,started_at:new Date(now).toISOString(),
      operation_deadline_at:new Date(deadline).toISOString(),lease_until:new Date(Math.min(now+leaseMs,deadline)).toISOString(),next_attempt_at:null,reason:'claimed'},input.operation_id,requestHash,context,3,true);
  },options);
}
export async function checkpointOperatingTask(env:RuntimeEnv,id:string,lease:OperatingLease,input:{operation_id:string;checkpoint:OperatingCheckpoint;lease_ms?:number},options:Options={}):Promise<OperatingResult>{
  if(!validateOperatingLease(lease)||!UUID4.test(input.operation_id)||!validateOperatingCheckpoint(input.checkpoint)||input.lease_ms!==undefined&&!integer(input.lease_ms,5_000,OPERATING_MAX_RUN_MS))return fail('invalid_checkpoint_input');
  return boundary(async context=>{
    const claim=await read(env,id,context);if(!claim)return fail('task_missing','missing');
    const requestHash=await sha256(stableJson({lease,input})),replayed=replay(claim,input.operation_id,requestHash);if(replayed)return replayed;
    if(!live(claim,lease,context.now()))return fail('stale_or_expired_lease');
    if(input.checkpoint.completed_units<claim.record.checkpoint.completed_units)return fail('checkpoint_regression');
    const previousCursor=claim.record.checkpoint.cursor;
    if(previousCursor&&(!input.checkpoint.cursor||input.checkpoint.cursor.kind!==previousCursor.kind||input.checkpoint.cursor.value<previousCursor.value))return fail('checkpoint_cursor_regression');
    const leaseUntil=input.lease_ms===undefined?claim.record.lease_until:new Date(Math.min(context.now()+input.lease_ms,Date.parse(claim.record.operation_deadline_at!))).toISOString();
    return save(env,claim,{checkpoint:structuredClone(input.checkpoint),lease_until:leaseUntil,reason:input.lease_ms===undefined?'checkpointed':'lease_renewed'},input.operation_id,requestHash,context,2,false,lease);
  },options);
}
export async function finishOperatingTask(env:RuntimeEnv,id:string,lease:OperatingLease,input:{operation_id:string;outcome:'succeeded'|'retryable_failure'|'permanent_failure'|'unknown';evidence_hash?:string},options:Options={}):Promise<OperatingResult>{
  if(!validateOperatingLease(lease)||!UUID4.test(input.operation_id)||!['succeeded','retryable_failure','permanent_failure','unknown'].includes(input.outcome)||input.evidence_hash!==undefined&&!evidenceHash(input.evidence_hash)||input.outcome==='succeeded'&&!evidenceHash(input.evidence_hash))return fail('invalid_finish_input');
  return boundary(async context=>{
    const claim=await read(env,id,context);if(!claim)return fail('task_missing','missing');
    const requestHash=await sha256(stableJson({lease,input})),replayed=replay(claim,input.operation_id,requestHash);if(replayed)return replayed;
    if(!live(claim,lease,context.now()))return fail('stale_or_expired_lease');
    const r=claim.record;let state:OperatingState,reason:OperatingReason,next:string|null=null;
    if(input.outcome==='succeeded'){state='succeeded';reason='succeeded';}
    else if(input.outcome==='unknown'||r.operation_class==='external_mutation'){state='recovery_required';reason='external_outcome_unknown';}
    else if(input.outcome==='permanent_failure'||r.attempts>=r.retry.max_attempts){state='dead_letter';reason=input.outcome==='permanent_failure'?'permanent_failure':'attempts_exhausted';}
    else{state='retry_wait';reason='retryable_failure';next=new Date(context.now()+operatingBackoff(r.attempts,r.retry,options.random)).toISOString();}
    return save(env,claim,{state,reason,lease_until:null,next_attempt_at:next,evidence_hash:input.evidence_hash??r.evidence_hash},input.operation_id,requestHash,context,state==='recovery_required'?1:0,false,lease);
  },options);
}
export async function markExpiredOperatingLease(env:RuntimeEnv,id:string,operationId:string,options:Options={}):Promise<OperatingResult>{
  if(!UUID4.test(operationId))return fail('invalid_operation_id');
  return boundary(async context=>{
    const claim=await read(env,id,context);if(!claim)return fail('task_missing','missing');
    const requestHash=await sha256('mark-expired'),replayed=replay(claim,operationId,requestHash);if(replayed)return replayed;
    const r=claim.record;if(r.state!=='running'||context.now()<Date.parse(r.lease_until!))return fail('lease_not_expired_running');
    return save(env,claim,{state:'recovery_required',lease_until:null,reason:'lease_expired'},operationId,requestHash,context,1);
  },options);
}
export async function reconcileOperatingTask(env:RuntimeEnv,id:string,input:{operation_id:string;expected_etag:string;readback:OperatingReadback},options:Options={}):Promise<OperatingResult>{
  const e=input.readback;
  if(!UUID4.test(input.operation_id)||typeof input.expected_etag!=='string'||!input.expected_etag||input.expected_etag.length>256||!validateOperatingReadback(e))return fail('invalid_reconciliation_evidence');
  return boundary(async context=>{
    const claim=await read(env,id,context);if(!claim)return fail('task_missing','missing');
    const requestHash=await sha256(stableJson(input)),replayed=replay(claim,input.operation_id,requestHash);if(replayed)return replayed;
    const r=claim.record;if(claim.etag!==input.expected_etag||r.state!=='recovery_required'||e.task_id!==r.task_id||e.run_id!==r.run_id||e.generation!==r.generation||e.payload_hash!==r.payload_hash||
      Date.parse(e.observed_at)<Date.parse(r.updated_at)||Date.parse(e.observed_at)>context.now())return fail('reconciliation_identity_conflict','conflict');
    if(e.result==='unknown')return fail('reconciliation_still_unknown');
    const state:OperatingState=e.result==='succeeded'?'succeeded':r.attempts>=r.retry.max_attempts?'dead_letter':'retry_wait';
    return save(env,claim,{state,reason:e.result==='succeeded'?'reconciled_succeeded':state==='dead_letter'?'attempts_exhausted':'reconciled_not_applied',evidence_hash:e.evidence_hash,
      next_attempt_at:state==='retry_wait'?new Date(context.now()+operatingBackoff(r.attempts,r.retry,options.random)).toISOString():null},input.operation_id,requestHash,context);
  },options);
}
