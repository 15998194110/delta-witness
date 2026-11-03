import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket, orderRuntime } from './helpers/order-runtime';
import { createOperatingTask, getOperatingTask, claimOperatingTask, checkpointOperatingTask, finishOperatingTask,
  markExpiredOperatingLease, reconcileOperatingTask, deriveOperatingTaskId, operatingBackoff, validateOperatingTask,
  validateOperatingCheckpoint, OPERATING_STATE_MAX_BYTES, type OperatingLease, type OperatingReadback } from '../src/operating-state';

const initial=Date.parse('2026-11-03T04:00:00.000Z');
const uuid=(n:number)=>`11111111-1111-4111-8111-${n.toString(16).padStart(12,'0')}`;
const h=(n:string)=>`sha256:${n.repeat(64)}`;
const policy={max_attempts:3,base_delay_ms:1000,max_delay_ms:8000,max_run_ms:3_600_000};
const checkpoint={completed_units:1,cursor:{kind:'block' as const,value:123},evidence_hash:h('a')};
function fixture(mutation=false){
  const bucket=new MemoryBucket(),env=orderRuntime(bucket);let now=initial;
  const options={now:()=>now,random:()=>0};
  const input={kind:'canonical-pulse',idempotency_key:h('1'),payload_hash:h('2'),operation_class:mutation?'external_mutation' as const:'read_only' as const,
    scheduled_at:new Date(initial).toISOString(),operation_id:uuid(1),retry:{...policy}};
  return {bucket,env,input,options,setNow:(value:number)=>{now=value;}};
}
async function started(mutation=false){
  const s=fixture(mutation),created=await createOperatingTask(s.env,s.input,s.options),id=created.task!.task_id;
  const run=await claimOperatingTask(s.env,id,{run_id:uuid(2),operation_id:uuid(3),lease_ms:5000},s.options);
  expect(run.execute).toBe(true);return {...s,id,run,lease:run.lease!};
}
function readback(s:Awaited<ReturnType<typeof started>>,result:OperatingReadback['result']='not_applied'):OperatingReadback{
  return {source:'adapter_verified_readback',task_id:s.id,run_id:uuid(2),generation:1,payload_hash:s.input.payload_hash,
    evidence_hash:h('b'),observed_at:new Date(initial+6000).toISOString(),result};
}
beforeEach(()=>{vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('unexpected_external_call');}));});
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('canonical operating task state, local R2 only',()=>{
  it('derives one task key from kind and idempotency, rejects payload changes, never grants on create/read/replay',async()=>{
    const s=fixture(),first=await createOperatingTask(s.env,s.input,s.options);
    expect(first.task!.task_id).toBe(await deriveOperatingTaskId(s.input.kind,s.input.idempotency_key));
    expect(first.execute).toBe(false);expect(await validateOperatingTask(first.task,first.task!.task_id)).toBe(true);
    expect((await createOperatingTask(s.env,{...s.input,operation_id:uuid(99)},s.options)).status).toBe('replayed');
    expect((await createOperatingTask(s.env,{...s.input,payload_hash:h('3')},s.options)).status).toBe('conflict');
    expect((await createOperatingTask(s.env,{...s.input,expected_task_id:uuid(77)},s.options)).status).toBe('conflict');
    expect((await getOperatingTask(s.env,first.task!.task_id,s.options)).execute).toBe(false);
    expect([...s.bucket.values.keys()]).toEqual([`operations/tasks/${first.task!.task_id}.json`]);
    expect(s.env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it('concurrent creation and claims have one original authority and at most one execution permission',async()=>{
    const s=fixture();const created=await Promise.all([createOperatingTask(s.env,s.input,s.options),createOperatingTask(s.env,s.input,s.options)]);
    expect(created.filter(r=>r.status==='created')).toHaveLength(1);
    const id=(created.find(r=>r.task)!).task!.task_id;
    const claims=await Promise.all([claimOperatingTask(s.env,id,{run_id:uuid(2),operation_id:uuid(3)},s.options),claimOperatingTask(s.env,id,{run_id:uuid(4),operation_id:uuid(5)},s.options)]);
    expect(claims.filter(r=>r.execute)).toHaveLength(1);
    const winner=claims.find(r=>r.execute)!;
    expect((await claimOperatingTask(s.env,id,{run_id:winner.task!.run_id!,operation_id:winner.task!.history.at(-1)!.operation_id},s.options)).execute).toBe(false);
  });
  it('original generation/ETag fences stale checkpoint and completion while preserving checkpoint evidence',async()=>{
    const s=await started(),changed=await checkpointOperatingTask(s.env,s.id,s.lease,{operation_id:uuid(4),checkpoint},s.options);
    expect(changed.task!.checkpoint).toEqual(checkpoint);expect(changed.execute).toBe(false);
    const original=JSON.stringify([...s.bucket.values]);
    expect((await finishOperatingTask(s.env,s.id,s.lease,{operation_id:uuid(5),outcome:'succeeded',evidence_hash:h('c')},s.options)).reason).toBe('stale_or_expired_lease');
    expect(JSON.stringify([...s.bucket.values])).toBe(original);
    const completed=await finishOperatingTask(s.env,s.id,changed.lease!,{operation_id:uuid(6),outcome:'succeeded',evidence_hash:h('c')},s.options);
    expect(completed.task!.state).toBe('succeeded');expect(completed.execute).toBe(false);
    expect(completed.task!.history.some(row=>row.checkpoint.evidence_hash===h('a'))).toBe(true);
    expect((await finishOperatingTask(s.env,s.id,changed.lease!,{operation_id:uuid(6),outcome:'succeeded',evidence_hash:h('c')},s.options)).status).toBe('replayed');
    expect((await finishOperatingTask(s.env,s.id,changed.lease!,{operation_id:uuid(6),outcome:'succeeded',evidence_hash:h('d')},s.options)).status).toBe('conflict');
  });
  it.each([false,true])('expired lease never restarts work automatically even for read_only=%s',async mutation=>{
    const s=await started(mutation);s.setNow(initial+6000);
    expect((await claimOperatingTask(s.env,s.id,{run_id:uuid(7),operation_id:uuid(8)},s.options)).execute).toBe(false);
    expect((await checkpointOperatingTask(s.env,s.id,s.lease,{operation_id:uuid(9),checkpoint},s.options)).reason).toBe('stale_or_expired_lease');
    expect((await finishOperatingTask(s.env,s.id,s.lease,{operation_id:uuid(10),outcome:'succeeded',evidence_hash:h('c')},s.options)).reason).toBe('stale_or_expired_lease');
    const expired=await markExpiredOperatingLease(s.env,s.id,uuid(11),s.options);expect(expired.task!.state).toBe('recovery_required');
    expect(expired.execute).toBe(false);expect(expired.task!.attempts).toBe(1);
    expect((await claimOperatingTask(s.env,s.id,{run_id:uuid(12),operation_id:uuid(13)},s.options)).execute).toBe(false);
  });
  it('read-only retries use bounded jitter and attempt limits, while permanent failure is terminal',async()=>{
    const s=await started();let lease=s.lease;
    for(let attempt=1;attempt<=3;attempt++){
      const failed=await finishOperatingTask(s.env,s.id,lease,{operation_id:uuid(20+attempt),outcome:'retryable_failure'},s.options);
      expect(failed.execute).toBe(false);
      if(attempt===3){expect(failed.task!.state).toBe('dead_letter');break;}
      expect(failed.task!.state).toBe('retry_wait');
      expect((await claimOperatingTask(s.env,s.id,{run_id:uuid(30+attempt),operation_id:uuid(40+attempt)},s.options)).reason).toBe('task_not_due');
      s.setNow(Date.parse(failed.task!.next_attempt_at!));
      const retry=await claimOperatingTask(s.env,s.id,{run_id:uuid(30+attempt),operation_id:uuid(40+attempt)},s.options);expect(retry.execute).toBe(true);lease=retry.lease!;
    }
    expect((await claimOperatingTask(s.env,s.id,{run_id:uuid(90),operation_id:uuid(91)},s.options)).execute).toBe(false);
    const other=await started();expect((await finishOperatingTask(other.env,other.id,other.lease,{operation_id:uuid(4),outcome:'permanent_failure'},other.options)).task!.state).toBe('dead_letter');
  });
  it.each(['retryable_failure','permanent_failure','unknown'] as const)('external mutation %s remains recovery_required without any automatic retry',async outcome=>{
    const s=await started(true);const failed=await finishOperatingTask(s.env,s.id,s.lease,{operation_id:uuid(4),outcome},s.options);
    expect(failed.task!.state).toBe('recovery_required');expect(failed.task!.next_attempt_at).toBeNull();
    s.setNow(initial+1_000_000);expect((await claimOperatingTask(s.env,s.id,{run_id:uuid(5),operation_id:uuid(6)},s.options)).execute).toBe(false);
  });
  it('only exact original not_applied evidence can CAS an unknown mutation into deferred retry',async()=>{
    const s=await started(true);s.setNow(initial+6000);const frozen=await markExpiredOperatingLease(s.env,s.id,uuid(4),s.options);
    const evidence=readback(s),before=JSON.stringify([...s.bucket.values]);
    for(const bad of [{...evidence,payload_hash:h('f')},{...evidence,run_id:uuid(44)},{...evidence,generation:2},{...evidence,task_id:uuid(45)},
      {...evidence,observed_at:new Date(initial).toISOString()}]){
      expect((await reconcileOperatingTask(s.env,s.id,{operation_id:uuid(5),expected_etag:frozen.etag!,readback:bad},s.options)).execute).toBe(false);
      expect(JSON.stringify([...s.bucket.values])).toBe(before);
    }
    expect((await reconcileOperatingTask(s.env,s.id,{operation_id:uuid(6),expected_etag:frozen.etag!,readback:readback(s,'unknown')},s.options)).reason).toBe('reconciliation_still_unknown');
    const restored=await reconcileOperatingTask(s.env,s.id,{operation_id:uuid(7),expected_etag:frozen.etag!,readback:evidence},s.options);
    expect(restored.task!.state).toBe('retry_wait');expect(restored.execute).toBe(false);
    expect(restored.task!.history.some(entry=>entry.state==='recovery_required')).toBe(true);
    s.setNow(Date.parse(restored.task!.next_attempt_at!));
    expect((await claimOperatingTask(s.env,s.id,{run_id:uuid(8),operation_id:uuid(9)},s.options)).execute).toBe(true);
  });
  it('successful original readback completes unknown task without repeating the effect',async()=>{
    const s=await started(true);s.setNow(initial+6000);const frozen=await markExpiredOperatingLease(s.env,s.id,uuid(4),s.options);
    const result=await reconcileOperatingTask(s.env,s.id,{operation_id:uuid(5),expected_etag:frozen.etag!,readback:readback(s,'succeeded')},s.options);
    expect(result.task!.state).toBe('succeeded');expect(result.execute).toBe(false);expect(result.task!.attempts).toBe(1);
  });
  it('heartbeat supports the existing 55-minute Pulse but never extends original one-hour deadline',async()=>{
    const s=fixture();const created=await createOperatingTask(s.env,s.input,s.options),id=created.task!.task_id;
    const claimed=await claimOperatingTask(s.env,id,{run_id:uuid(2),operation_id:uuid(3),lease_ms:55*60_000},s.options);expect(claimed.execute).toBe(true);
    s.setNow(initial+50*60_000);
    const renewed=await checkpointOperatingTask(s.env,id,claimed.lease!,{operation_id:uuid(4),checkpoint,lease_ms:3_600_000},s.options);
    expect(renewed.task!.lease_until).toBe(new Date(initial+3_600_000).toISOString());
    expect(renewed.task!.operation_deadline_at).toBe(claimed.task!.operation_deadline_at);
    s.setNow(initial+3_600_000);expect((await checkpointOperatingTask(s.env,id,renewed.lease!,{operation_id:uuid(5),checkpoint,lease_ms:3_600_000},s.options)).reason).toBe('stale_or_expired_lease');
  });
  it('preserves history and reserves space for completion before refusing further checkpoints',async()=>{
    const s=await started();let lease=s.lease,previous=0,blocked=false;
    for(let index=0;index<64;index++){
      const changed=await checkpointOperatingTask(s.env,s.id,lease,{operation_id:uuid(100+index),checkpoint:{...checkpoint,completed_units:index}},s.options);
      if(changed.status==='blocked'){blocked=true;break;}
      expect(changed.task!.history.length).toBeGreaterThan(previous);previous=changed.task!.history.length;lease=changed.lease!;
    }
    expect(blocked).toBe(true);
    const saved=await finishOperatingTask(s.env,s.id,lease,{operation_id:uuid(200),outcome:'succeeded',evidence_hash:h('d')},s.options);
    expect(saved.task!.state).toBe('succeeded');expect(saved.task!.history.length).toBe(previous+1);
    expect(new TextEncoder().encode(JSON.stringify(saved.task)).byteLength).toBeLessThanOrEqual(OPERATING_STATE_MAX_BYTES);
  });
  it('rejects arbitrary checkpoint contents, regressing cursor units, missing success evidence and unsafe retry policy',async()=>{
    const s=await started();expect(validateOperatingCheckpoint({...checkpoint,secret:'fixture-secret'})).toBe(false);
    expect(validateOperatingCheckpoint({...checkpoint,cursor:{kind:'url',value:'https://private.test/?token=secret'}})).toBe(false);
    expect((await finishOperatingTask(s.env,s.id,s.lease,{operation_id:uuid(4),outcome:'succeeded'},s.options)).reason).toBe('invalid_finish_input');
    expect((await createOperatingTask(s.env,{...s.input,retry:{...policy,max_attempts:9}},s.options)).reason).toBe('invalid_task_input');
    const changed=await checkpointOperatingTask(s.env,s.id,s.lease,{operation_id:uuid(5),checkpoint},s.options);
    expect((await checkpointOperatingTask(s.env,s.id,changed.lease!,{operation_id:uuid(6),checkpoint:{...checkpoint,completed_units:0}},s.options)).reason).toBe('checkpoint_regression');
    for(const cursor of [null,{kind:'page' as const,value:123},{kind:'block' as const,value:122}]){
      expect((await checkpointOperatingTask(s.env,s.id,changed.lease!,{operation_id:uuid(7),checkpoint:{...checkpoint,cursor}},s.options)).reason).toBe('checkpoint_cursor_regression');
    }
    expect(()=>operatingBackoff(1,policy,()=>1)).toThrow('invalid_operating_random');
    expect(operatingBackoff(8,policy,()=>0)).toBe(4000);expect(operatingBackoff(8,policy,()=>0.999)).toBeLessThan(8000);
  });
  it.each(['get','body'])('stalled metadata %s is bounded and cannot grant late permission',async stage=>{
    vi.useFakeTimers();const s=await started(),get=s.bucket.get.bind(s.bucket);let release!:()=>void;
    s.bucket.get=async key=>{if(stage==='get')await new Promise<void>(resolve=>{release=resolve;});const object=await get(key);
      return stage==='body'&&object?{...object,body:new ReadableStream<Uint8Array>({pull(){return new Promise(()=>{});}})}:object;};
    const running=getOperatingTask(s.env,s.id,s.options);await vi.advanceTimersByTimeAsync(15_001);
    expect(await running).toMatchObject({status:'unavailable',execute:false});release?.();await vi.advanceTimersByTimeAsync(1);
  });
  it('lost claim write ACK never grants permission, even when the original CAS later commits',async()=>{
    vi.useFakeTimers();const s=fixture(),created=await createOperatingTask(s.env,s.input,s.options),id=created.task!.task_id,put=s.bucket.put.bind(s.bucket);
    let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});let writes=0;
    s.bucket.put=async(k,v,o)=>{writes++;entered();await new Promise<void>(resolve=>{release=resolve;});return put(k,v,o);};
    const running=claimOperatingTask(s.env,id,{run_id:uuid(2),operation_id:uuid(3)},s.options);await ready;await vi.advanceTimersByTimeAsync(15_001);
    expect(await running).toMatchObject({status:'unconfirmed',execute:false});expect(writes).toBe(1);
    release();await vi.advanceTimersByTimeAsync(1);s.bucket.put=put;
    const read=await getOperatingTask(s.env,id,s.options);expect(read.task!.state).toBe('running');expect(read.execute).toBe(false);
    expect((await claimOperatingTask(s.env,id,{run_id:uuid(2),operation_id:uuid(3)},s.options)).execute).toBe(false);
  });
  it('lease expiration while an ACK is delayed returns no execution permission',async()=>{
    const s=fixture(),created=await createOperatingTask(s.env,s.input,s.options),id=created.task!.task_id,put=s.bucket.put.bind(s.bucket);
    s.bucket.put=async(k,v,o)=>{const result=await put(k,v,o);s.setNow(initial+6000);return result;};
    const result=await claimOperatingTask(s.env,id,{run_id:uuid(2),operation_id:uuid(3),lease_ms:5000},s.options);
    expect(result).toMatchObject({status:'updated',execute:false,reason:'lease_expired_after_ack'});expect(result.lease).toBeUndefined();
  });
  it('corrupt or oversized original metadata is retained, never reset or exposed as missing',async()=>{
    const s=fixture(),id=await deriveOperatingTaskId(s.input.kind,s.input.idempotency_key),key=`operations/tasks/${id}.json`;
    for(const data of ['{',JSON.stringify({secret:'fixture-secret'}),' '.repeat(OPERATING_STATE_MAX_BYTES+1)]){
      await s.bucket.put(key,data);const before=s.bucket.values.get(key);
      const result=await createOperatingTask(s.env,s.input,s.options);expect(result.status).toBe('unavailable');expect(result.execute).toBe(false);
      expect(s.bucket.values.get(key)).toEqual(before);expect(JSON.stringify(result)).not.toContain('fixture-secret');
    }
  });
});
