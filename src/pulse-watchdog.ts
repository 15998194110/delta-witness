import type { RuntimeEnv } from './env';
import { createClaim, commitClaim, type StoredClaim } from './claims';
import { createOrderReadSnapshot, readOrderMetadata } from './order-storage';
import { withinDeadline } from './deadline';
import { sha256, stableJson } from './crypto';
import { createOperatingTask, claimOperatingTask, finishOperatingTask, getOperatingTask, markExpiredOperatingLease, reconcileOperatingTask, deriveOperatingTaskId } from './operating-state';

const REPOSITORY = '15998194110/delta-witness';
const WORKFLOW = 'discovery-pulse.yml';
const ROOT = `https://api.github.com/repos/${REPOSITORY}`;
const KEY = 'operations/control/pulse-watchdog.json';
export const PULSE_STALE_MS = 3 * 60 * 60 * 1000;
export const PULSE_WATCHDOG_DEADLINE_MS = 90_000;
type Guard = { schema: 'delta-pulse-dispatch/v1'; run_id: string; task_id: string; attempted_at: string;
  github_run_id: string | null; workflow_id: number; release_sha: string; outcome: 'attempting'|'accepted'|'confirmed'|'unknown' };
type Result = { outcome: 'disabled'|'checked'|'dispatched'|'degraded'|'recovery_required'; reason: string;
  provider_scheduler_enabled: boolean | null; latest_run_id: string | null; latest_run_at: string | null; next_run: null };
const result = (outcome: Result['outcome'], reason: string, extra: Partial<Result> = {}): Result => ({ outcome, reason,
  provider_scheduler_enabled: null, latest_run_id: null, latest_run_at: null, next_run: null, ...extra });
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const runId = (x: unknown): x is string => typeof x === 'string' && /^[1-9][0-9]{0,18}$/.test(x);
const iso = (x: unknown): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const wireTime = (x: unknown): string | null => typeof x==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(x) &&
  Number.isFinite(Date.parse(x)) && [new Date(x).toISOString(),new Date(x).toISOString().replace('.000Z','Z')].includes(x) ? new Date(x).toISOString() : null;
const hash = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{40}$/.test(x);
function validGuard(x: unknown): x is Guard {
  const r = x as Guard;
  return !!r && Object.keys(r).sort().join(',') === ['schema','run_id','task_id','attempted_at','github_run_id','workflow_id','release_sha','outcome'].sort().join(',') &&
    r.schema === 'delta-pulse-dispatch/v1' && uuid(r.run_id) && uuid(r.task_id) && iso(r.attempted_at) && hash(r.release_sha) &&
    Number.isSafeInteger(r.workflow_id) && r.workflow_id>0 && (r.github_run_id === null || runId(r.github_run_id)) &&
    (!['accepted','confirmed'].includes(r.outcome)||r.github_run_id!==null) && ['attempting','accepted','confirmed','unknown'].includes(r.outcome);
}
const dispatchBody=(run:string,release:string)=>({ref:'master',inputs:{delta_watchdog_run:run,delta_watchdog_release:release}});
async function json(response: Response, signal: AbortSignal): Promise<any> {
  if (!response.ok) { void response.body?.cancel().catch(()=>{}); throw new Error('github_read_rejected'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('github_body_missing');
  const cancel = () => { void reader.cancel().catch(()=>{}); }; signal.addEventListener('abort', cancel, { once: true });
  let size = 0; const chunks: Uint8Array[] = [];
  try {return await withinDeadline((async()=>{
    while (true) { const next = await reader.read(); if (signal.aborted) throw new Error('github_read_cancelled');
      if (next.done) break; size += next.value.byteLength; if (size > 131_072) throw new Error('github_body_limit'); chunks.push(next.value); }
    const bytes = new Uint8Array(size); let at=0; for (const chunk of chunks) { bytes.set(chunk,at);at+=chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));
  })(),8_000,'github_body_deadline',cancel);
  } finally { signal.removeEventListener('abort',cancel);cancel();reader.releaseLock(); }
}

// Reuses the one canonical workflow. This does not enable a disabled workflow,
// execute a business order, pay, contact a customer or retry an uncertain POST.
export async function pulseWatchdog(source: RuntimeEnv, now = Date.now()): Promise<Result> {
  if (source.OPERATIONS_CLOUD_ENABLED !== 'true' || source.PULSE_WATCHDOG_ENABLED !== 'true') return result('disabled','configuration_disabled');
  if (!source.GITHUB_ACTIONS_DISPATCH_TOKEN || !hash(source.OPERATIONS_RELEASE_SHA)) return result('degraded','configuration_incomplete');
  const snapshot = createOrderReadSnapshot(source,8_192), env = snapshot.env;
  const controller = new AbortController();
  const request = async (path: string, body?: object) => {
    snapshot.assertActive();
    return withinDeadline((async()=>{
      const response=await fetch(`${ROOT}${path}`,{method:body?'POST':'GET',redirect:'error',signal:controller.signal,
        headers:{accept:'application/vnd.github+json','x-github-api-version':'2026-03-10','user-agent':'DELTA-canonical-pulse-watchdog',
          authorization:`Bearer ${source.GITHUB_ACTIONS_DISPATCH_TOKEN}`,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
      snapshot.assertActive();return response;
    })(),8_000,'github_transport_deadline',()=>controller.abort());
  };
  try {
    return await withinDeadline((async():Promise<Result>=>{
      const saved = await readOrderMetadata<Guard>(env,KEY,8_192); snapshot.assertActive();
      if(saved&&!validGuard(saved.record))return result('recovery_required','dispatch_guard_invalid');
      const workflow=await json(await request(`/actions/workflows/${WORKFLOW}`),controller.signal);snapshot.assertActive();
      if(workflow.path!==`.github/workflows/${WORKFLOW}` || !Number.isSafeInteger(workflow.id))return result('degraded','workflow_identity_mismatch');
      if(workflow.state!=='active')return result('degraded','workflow_not_active',{provider_scheduler_enabled:false});
      const branch=await json(await request('/branches/master'),controller.signal);snapshot.assertActive();
      if(branch.commit?.sha!==source.OPERATIONS_RELEASE_SHA)return result('degraded','release_drift',{provider_scheduler_enabled:true});
      const list=await json(await request(`/actions/workflows/${WORKFLOW}/runs?per_page=10`),controller.signal);snapshot.assertActive();
      if(!Array.isArray(list.workflow_runs)||list.workflow_runs.length>10 || list.workflow_runs.some((r:any)=>!Number.isSafeInteger(r.id)||r.id<=0||!wireTime(r.created_at)||Date.parse(r.created_at)>now||
        !['queued','in_progress','waiting','requested','pending','completed'].includes(r.status)))return result('degraded','workflow_runs_invalid');
      const rows=list.workflow_runs.filter((r:any)=>r.head_branch==='master').map((r:any)=>({...r,created_at:wireTime(r.created_at)!}));
      const latest=rows.sort((a:any,b:any)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0];
      const info:Partial<Result>={provider_scheduler_enabled:true,latest_run_id:latest?String(latest.id):null,latest_run_at:latest?.created_at??null};
      if(saved){
        if(now-Date.parse(saved.record.attempted_at)<90_000)return result('checked','original_dispatch_pending',info);
        let task=await getOperatingTask(env,saved.record.task_id);snapshot.assertActive();
        const originalId=await deriveOperatingTaskId('canonical-pulse-dispatch',await sha256(`canonical-pulse-dispatch\n${saved.record.attempted_at}`));
        if(originalId!==saved.record.task_id||!task.task||task.task.kind!=='canonical-pulse-dispatch'||task.task.scheduled_at!==saved.record.attempted_at||
          task.task.run_id!==saved.record.run_id||task.task.payload_hash!==await sha256(stableJson(dispatchBody(saved.record.run_id,saved.record.release_sha))))return result('recovery_required','original_task_identity_mismatch',info);
        if(task.task?.state==='running') {task=await markExpiredOperatingLease(env,saved.record.task_id,crypto.randomUUID());snapshot.assertActive();}
        const candidateId=saved.record.github_run_id??String(rows.find((r:any)=>r.display_title===`DELTA Pulse watchdog ${saved.record.run_id}`)?.id??'');
        if(!runId(candidateId))return result('recovery_required','prior_dispatch_requires_readback',info);
        // Read the original run independently of the latest-ten inventory, after
        // freezing any expired task lease. Only this exact source can reconcile it.
        const match=await json(await request(`/actions/runs/${candidateId}`),controller.signal);snapshot.assertActive();
        const readbackTime=new Date().toISOString();
        if(String(match.id)!==candidateId||match.workflow_id!==saved.record.workflow_id||match.head_sha!==saved.record.release_sha||
          match.path!==`.github/workflows/${WORKFLOW}`||match.head_branch!=='master'||match.event!=='workflow_dispatch'||
          match.display_title!==`DELTA Pulse watchdog ${saved.record.run_id}`||!wireTime(match.created_at)||
          Date.parse(match.created_at)<Math.floor(Date.parse(saved.record.attempted_at)/1000)*1000)return result('recovery_required','prior_dispatch_identity_mismatch',info);
        if(task.task?.state==='recovery_required'&&task.etag){
          task=await reconcileOperatingTask(env,saved.record.task_id,{operation_id:crypto.randomUUID(),expected_etag:task.etag,
            readback:{source:'adapter_verified_readback',task_id:saved.record.task_id,run_id:saved.record.run_id,generation:task.task.generation,payload_hash:task.task.payload_hash,
              evidence_hash:await sha256(stableJson({scope:'github_dispatch_readback_not_business_success',run_id:String(match.id),title:match.display_title})),
              observed_at:readbackTime,result:'succeeded'}});snapshot.assertActive();
        }
        if(task.task?.state!=='succeeded')return result('recovery_required','original_task_readback_unconfirmed',info);
        if(saved.record.outcome!=='confirmed'){
          const confirmed=await commitClaim(env,KEY,saved,{...saved.record,outcome:'confirmed',github_run_id:String(match.id)});snapshot.assertActive();
          if(!confirmed)return result('recovery_required','dispatch_readback_cas_conflict',info);
          return result('checked','original_dispatch_confirmed',info);
        }
        if(match.status!=='completed')return result('checked','original_canonical_run_not_terminal',info);
      }
      if(rows.some((r:any)=>['queued','in_progress','waiting','requested','pending'].includes(r.status)))return result('checked','canonical_run_pending',info);
      if(!latest)return result('degraded','no_prior_run_anchor',info);
      if(now-Date.parse(latest.created_at)<PULSE_STALE_MS)return result('checked','canonical_run_recent',info);
      if(saved&&now-Date.parse(saved.record.attempted_at)<PULSE_STALE_MS)return result('checked','dispatch_cooldown',info);
      const run=crypto.randomUUID(),scheduled=new Date(now).toISOString();
      const payload=dispatchBody(run,source.OPERATIONS_RELEASE_SHA!);
      const prepared=await createOperatingTask(env,{kind:'canonical-pulse-dispatch',idempotency_key:await sha256(`canonical-pulse-dispatch\n${scheduled}`),
        payload_hash:await sha256(stableJson(payload)),operation_class:'external_mutation',scheduled_at:scheduled,operation_id:crypto.randomUUID(),
        retry:{max_attempts:1,base_delay_ms:60_000,max_delay_ms:60_000,max_run_ms:90_000}});snapshot.assertActive();
      if(!prepared.task)return result('recovery_required','task_prepare_unconfirmed',info);
      const candidate:Guard={schema:'delta-pulse-dispatch/v1',run_id:run,task_id:prepared.task.task_id,attempted_at:scheduled,
        github_run_id:null,workflow_id:workflow.id,release_sha:source.OPERATIONS_RELEASE_SHA!,outcome:'attempting'};
      const guard:StoredClaim<Guard>|null=saved?await commitClaim(env,KEY,saved,candidate):await createClaim(env,KEY,candidate);snapshot.assertActive();
      if(!guard)return result('checked','another_watchdog_claimed',info);
      const claimed=await claimOperatingTask(env,prepared.task.task_id,{run_id:run,operation_id:crypto.randomUUID(),lease_ms:90_000});snapshot.assertActive();
      if(!claimed.execute||!claimed.lease)return result('recovery_required','task_claim_unconfirmed',info);
      let accepted=false,remote:string|null=null;
      try {
        const response=await request(`/actions/workflows/${WORKFLOW}/dispatches`,payload);
        if(response.status===200){const answer=await json(response,controller.signal);snapshot.assertActive();
          if(Number.isSafeInteger(answer.workflow_run_id)&&answer.workflow_run_id>0){accepted=true;remote=String(answer.workflow_run_id);}}
        else{void response.body?.cancel().catch(()=>{});}
      } catch { /* The original provider outcome stays unknown. Never send again. */ }
      snapshot.assertActive();
      const outcome=accepted?'accepted':'unknown';
      const stored=await commitClaim(env,KEY,guard,{...candidate,outcome,github_run_id:remote});snapshot.assertActive();
      const finished=await finishOperatingTask(env,prepared.task.task_id,claimed.lease,{operation_id:crypto.randomUUID(),outcome:accepted?'succeeded':'unknown',
        ...(accepted?{evidence_hash:await sha256(stableJson({scope:'github_dispatch_accepted_not_business_success',run_id:remote}))}:{})});snapshot.assertActive();
      if(!stored||finished.status!=='updated')return result('recovery_required','dispatch_record_unconfirmed',info);
      return result(accepted?'dispatched':'recovery_required',accepted?'provider_accepted_not_fulfilled':'dispatch_outcome_unknown',info);
    })(),PULSE_WATCHDOG_DEADLINE_MS,'watchdog_deadline',()=>{snapshot.cancel();controller.abort();});
  } catch {return result('degraded','watchdog_evidence_unavailable');}
  finally {snapshot.cancel();controller.abort();}
}
