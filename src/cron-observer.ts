import type { RuntimeEnv } from './env';
import { createOrderReadSnapshot } from './order-storage';
import { withinDeadline } from './deadline';

export type CronRun = { run_id:string; task_id:'cron3'|'cron15'; scheduled_at:string; started_at:string;
  completed_at:string|null; lease_expires_at:string; outcome:'running'|'success'|'degraded'; last_success_at:string|null };
type Projection = {schema:'delta-cron-observation/v1'; task_id:CronRun['task_id']; runs:CronRun[]};
const PREFIX='operations/cron-observation/v1/';
const ISO=(s:unknown):s is string=>typeof s==='string'&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function validRun(x:any,task:string):x is CronRun{
  return !!x&&Object.keys(x).sort().join(',')==='completed_at,last_success_at,lease_expires_at,outcome,run_id,scheduled_at,started_at,task_id'&&
    x.task_id===task&&UUID.test(x.run_id)&&ISO(x.scheduled_at)&&ISO(x.started_at)&&ISO(x.lease_expires_at)&&
    Date.parse(x.scheduled_at)<=Date.parse(x.started_at)+60000&&Date.parse(x.started_at)<=Date.now()+5000&&
    Date.parse(x.lease_expires_at)===Date.parse(x.started_at)+200000&&
    ['running','success','degraded'].includes(x.outcome)&&
    (x.outcome==='running'?x.completed_at===null:ISO(x.completed_at)&&x.completed_at>=x.started_at&&Date.parse(x.completed_at)<=Date.now()+5000)&&
    (x.last_success_at===null||ISO(x.last_success_at)&&x.last_success_at<=(x.completed_at??x.started_at));
}
function valid(x:any,task:string):x is Projection{
  return !!x&&Object.keys(x).sort().join(',')==='runs,schema,task_id'&&x.schema==='delta-cron-observation/v1'&&x.task_id===task&&
    Array.isArray(x.runs)&&x.runs.length<=48&&x.runs.every((r:any)=>validRun(r,task))&&new Set(x.runs.map((r:CronRun)=>r.run_id)).size===x.runs.length;
}
async function observe(source:RuntimeEnv,run:CronRun):Promise<boolean>{
  if(!validRun(run,run.task_id))return false;
  const snapshot=createOrderReadSnapshot(source,49152),env=snapshot.env;
  try{return await withinDeadline((async()=>{
    const phase=run.completed_at?'completed':'started',body=JSON.stringify(run);
    const key=`${PREFIX}runs/${run.task_id}/${run.run_id}/${phase}.json`;
    const created=await env.PROOFS.put(key,body,{onlyIf:{etagDoesNotMatch:'*'}});snapshot.assertActive();
    if(!created){const previous=await env.PROOFS.get(key);snapshot.assertActive();if(!previous||await previous.text()!==body)return false;}
    // Retry only explicit CAS rejection. Unknown writes are never blindly retried.
    for(let attempt=0;attempt<3;attempt++){
      const latestKey=`${PREFIX}latest/${run.task_id}.json`,obj=await env.PROOFS.get(latestKey);snapshot.assertActive();
      const previous=obj?await obj.json<Projection>():null;snapshot.assertActive();
      if(previous&&!valid(previous,run.task_id))return false;
      const old=previous?.runs.find(r=>r.run_id===run.run_id);
      if(old?.completed_at&&!run.completed_at)return true;
      const runs=[...(previous?.runs??[]).filter(r=>r.run_id!==run.run_id),run]
        .sort((a,b)=>b.scheduled_at.localeCompare(a.scheduled_at)||b.started_at.localeCompare(a.started_at)||b.run_id.localeCompare(a.run_id)).slice(0,48);
      const next:Projection={schema:'delta-cron-observation/v1',task_id:run.task_id,runs};
      const saved=await env.PROOFS.put(latestKey,JSON.stringify(next),{onlyIf:obj?{etagMatches:obj.etag}:{etagDoesNotMatch:'*'}});
      snapshot.assertActive();if(saved)return true;
    }
    return false;
  })(),2000,'cron_observation_deadline',snapshot.cancel);}catch{return false;}finally{snapshot.cancel();}
}

// Only fixed Healthchecks UUID endpoints. URLs are credentials and never logged.
export async function externalHeartbeat(url:unknown,runId:string,phase:'start'|'success'|'fail',fetcher:typeof fetch=fetch){
  if(typeof url!=='string'||!/^https:\/\/hc-ping\.com\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(url)||!UUID.test(runId))
    return {state:'not_configured' as const,notification_delivered:null};
  const controller=new AbortController();let cancelBody=()=>{};
  try{return await withinDeadline((async()=>{
    const response=await fetcher(`${url}${phase==='success'?'':`/${phase}`}?rid=${runId}`,{method:'GET',redirect:'error',signal:controller.signal});
    if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});throw new Error('heartbeat_canceled');}
    const reader=response.body?.getReader();if(!reader)return {state:'unconfirmed' as const,notification_delivered:null};
    cancelBody=()=>{void reader.cancel().catch(()=>{});};
    let text='',bytes=0;try{while(true){const part=await reader.read();if(controller.signal.aborted)throw new Error('heartbeat_canceled');if(part.done)break;bytes+=part.value.byteLength;if(bytes>32)throw new Error('heartbeat_body_limit');text+=new TextDecoder().decode(part.value);}}
    finally{void reader.cancel().catch(()=>{});}
    // Healthchecks can answer 200 with not-found/rate-limited text: never accept that.
    return {state:response.status===200&&text.trim()==='OK'?'accepted' as const:'unconfirmed' as const,notification_delivered:null};
  })(),4000,'heartbeat_deadline',()=>{controller.abort();cancelBody();});}catch{return {state:'unconfirmed' as const,notification_delivered:null};}finally{controller.abort();cancelBody();}
}

export async function observeCronInvocation(env:RuntimeEnv,controller:Pick<ScheduledController,'cron'|'scheduledTime'>,
  work:()=>Promise<unknown[]>):Promise<void>{
  const task=controller.cron==='*/3 * * * *'?'cron3':controller.cron==='*/15 * * * *'?'cron15':null;
  if(env.CRON_OBSERVER_ENABLED!=='true'||!task){await work();return;}
  if(!Number.isSafeInteger(controller.scheduledTime)||controller.scheduledTime<0)throw new Error('cron_time_invalid');
  const started=Date.now(),run:CronRun={run_id:crypto.randomUUID(),task_id:task,scheduled_at:new Date(controller.scheduledTime).toISOString(),
    started_at:new Date(started).toISOString(),completed_at:null,lease_expires_at:new Date(started+200000).toISOString(),outcome:'running',last_success_at:null};
  const ping=env.CRON_EXTERNAL_HEARTBEAT_ENABLED==='true'?(task==='cron3'?env.CRON3_HEALTHCHECKS_PING_URL:env.CRON15_HEALTHCHECKS_PING_URL):undefined;
  const [stored,startPing]=await Promise.all([observe(env,run),externalHeartbeat(ping,run.run_id,'start')]);
  let failed=false;
  try{await work();}catch{failed=true;}
  const startDegraded=failed||!stored||(env.CRON_EXTERNAL_HEARTBEAT_ENABLED==='true'&&startPing.state!=='accepted');
  const endPing=await externalHeartbeat(ping,run.run_id,startDegraded?'fail':'success');
  const completionDegraded=startDegraded||(env.CRON_EXTERNAL_HEARTBEAT_ENABLED==='true'&&endPing.state!=='accepted');
  const completed_at=new Date().toISOString();
  // Retain heartbeat failure with the immutable original completion, so the
  // independent reader can observe it even after a later healthy invocation.
  const final:CronRun={...run,completed_at,outcome:completionDegraded?'degraded':'success',last_success_at:completionDegraded?null:completed_at};
  const saved=await observe(env,final);
  // If completion persistence failed after the heartbeat, retract the success
  // signal with an explicit failure; never rewrite the original event.
  if(!saved&&env.CRON_EXTERNAL_HEARTBEAT_ENABLED==='true')await externalHeartbeat(ping,run.run_id,'fail');
  const controlDegraded=completionDegraded||!saved;
  console.log(JSON.stringify({event:'cron_control_observation',...final,work_outcome:failed?'degraded':'success',control_outcome:controlDegraded?'degraded':'success',stored:stored&&saved,
    external_monitor_start:startPing.state,external_monitor_completion:endPing.state,notification_delivered:null}));
  if(controlDegraded)
    throw new Error('cron_control_degraded');
}

export async function cronObservationStatus(source:RuntimeEnv){
  if(source.CRON_OBSERVER_ENABLED!=='true')return {ok:false,schema:'delta-cron-status/v1',reason:'disabled'};
  const snapshot=createOrderReadSnapshot(source,49152),env=snapshot.env;
  try{return await withinDeadline((async()=>{
    const tasks=[];
    for(const task_id of ['cron3','cron15'] as const){
      const obj=await env.PROOFS.get(`${PREFIX}latest/${task_id}.json`);snapshot.assertActive();
      const stored=obj?await obj.json<Projection>():null;snapshot.assertActive();
      if(stored&&!valid(stored,task_id))throw new Error('cron_projection_invalid');
      const runs=stored?.runs??[],success=runs.filter(r=>r.outcome==='success'&&r.completed_at).sort((a,b)=>b.completed_at!.localeCompare(a.completed_at!))[0];
      tasks.push({task_id,runs,last_success_at:success?.completed_at??null,inventory_complete:false});
    }
    return {ok:true,schema:'delta-cron-status/v1',observed_at:new Date().toISOString(),provider_scheduler_enabled:null,tasks};
  })(),5000,'cron_status_deadline',snapshot.cancel);}finally{snapshot.cancel();}
}
