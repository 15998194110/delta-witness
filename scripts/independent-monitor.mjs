// Read-only observer: no dispatch, payment, capture, customer send or provider setup.
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const CORE='https://delta-witness-api.ruphussten.workers.dev';
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
export function assessCronEvidence(snapshot,policy,now=Date.now()){
  const issues=[],tasks=[];
  if(!iso(policy?.active_since)||Date.parse(policy.active_since)>now||!Number.isSafeInteger(policy.grace_ms)||policy.grace_ms<0||policy.grace_ms>300000)
    throw new Error('monitor_policy_invalid');
  const invalid=()=>({state:'unknown',issues:[{code:'source_unavailable',task_id:'cloudflare',evidence_scope:'observation_not_provider_enablement'}],tasks:[],notification_delivered:null});
  if(snapshot?.ok!==true||snapshot.schema!=='delta-cron-status/v1'||!iso(snapshot.observed_at)||Date.parse(snapshot.observed_at)>now+5000||now-Date.parse(snapshot.observed_at)>60000||
    !Array.isArray(snapshot.tasks)||snapshot.tasks.length!==2||new Set(snapshot.tasks.map(t=>t.task_id)).size!==2)return invalid();
  for(const [task_id,interval] of [['cron3',180000],['cron15',900000]]){
    const task=snapshot.tasks.find(t=>t.task_id===task_id);
    if(!task||!Array.isArray(task.runs)||task.runs.length>48||new Set(task.runs.map(r=>r.run_id)).size!==task.runs.length||task.runs.some(r=>
      !r||Object.keys(r).sort().join(',')!=='completed_at,last_success_at,lease_expires_at,outcome,run_id,scheduled_at,started_at,task_id'||!uuid(r.run_id)||r.task_id!==task_id||
      !iso(r.scheduled_at)||Date.parse(r.scheduled_at)%interval!==0||!iso(r.started_at)||Date.parse(r.started_at)>now+5000||Date.parse(r.scheduled_at)>Date.parse(r.started_at)+60000||
      !iso(r.lease_expires_at)||Date.parse(r.lease_expires_at)!==Date.parse(r.started_at)+200000||
      !['running','success','degraded'].includes(r.outcome)||
      (r.outcome==='running'?r.completed_at!==null:!iso(r.completed_at)||r.completed_at<r.started_at||Date.parse(r.completed_at)>now+5000)||
      r.last_success_at!==null&&(!iso(r.last_success_at)||r.last_success_at>(r.completed_at??r.started_at))))return invalid();
    const due=Math.floor((now-policy.grace_ms)/interval)*interval;
    const expected=[due-2*interval,due-interval,due].filter(t=>t>=Date.parse(policy.active_since));
    const missing=expected.filter(t=>!task.runs.some(r=>Date.parse(r.scheduled_at)===t));
    if(expected.length===3&&missing.length===3)issues.push({code:'three_missed_slots',task_id,first_missing_at:new Date(missing[0]).toISOString(),last_missing_at:new Date(missing[2]).toISOString()});
    const recent=task.runs.filter(r=>Date.parse(r.scheduled_at)>=Math.max(Date.parse(policy.active_since),due-2*interval)&&Date.parse(r.scheduled_at)<=now);
    for(const r of recent){
      if(r.outcome==='running'&&Date.parse(r.lease_expires_at)<=now)issues.push({code:'execution_lease_expired',task_id,run_id:r.run_id});
      if(r.outcome==='degraded')issues.push({code:'execution_degraded',task_id,run_id:r.run_id});
    }
    for(const slot of new Set(recent.map(r=>r.scheduled_at))){if(recent.filter(r=>r.scheduled_at===slot).length>1)issues.push({code:'duplicate_execution',task_id,scheduled_at:slot});}
    const success=task.runs.filter(r=>r.outcome==='success').map(r=>r.completed_at).sort().at(-1)??null;
    tasks.push({task_id,expected_slots:expected.map(t=>new Date(t).toISOString()),missing_slots:missing.map(t=>new Date(t).toISOString()),last_success_at:success,
      scheduled_at:recent.map(r=>r.scheduled_at).sort().at(-1)??null,inventory_complete:false});
  }
  return {state:issues.length?'degraded':'observed',issues,tasks,provider_scheduler_enabled:null,notification_delivered:null};
}
async function boundedRequest(fetcher,url,init={},limit=65536){
  const c=new AbortController();let timer,reader;
  try{return await Promise.race([(async()=>{
    const r=await fetcher(url,{...init,redirect:'error',signal:c.signal});
    if(c.signal.aborted){void r.body?.cancel().catch(()=>{});throw new Error('read_canceled');}reader=r.body?.getReader();
    let length=0,chunks=[];
    if(!reader)throw new Error('body_missing');
    while(true){const n=await reader.read();if(c.signal.aborted)throw new Error('read_canceled');if(n.done)break;length+=n.value.length;if(length>limit)throw new Error('body_limit');chunks.push(n.value);}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return {status:r.status,text:new TextDecoder('utf-8',{fatal:true}).decode(bytes)};
  })(),new Promise((_,reject)=>{timer=setTimeout(()=>{c.abort();void reader?.cancel().catch(()=>{});reject(new Error('read_deadline'));},8000);})]);}
  finally{clearTimeout(timer);c.abort();void reader?.cancel().catch(()=>{});}
}
export async function pingIndependentMonitor(fetcher,url,runId,phase){
  if(typeof url!=='string'||!/^https:\/\/hc-ping\.com\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(url)||!uuid(runId)||!['start','success','fail'].includes(phase))return {state:'not_configured',notification_delivered:null};
  try{const r=await boundedRequest(fetcher,`${url}${phase==='success'?'':`/${phase}`}?rid=${runId}`,{method:'GET'},32);
    return {state:r.status===200&&r.text.trim()==='OK'?'accepted':'unconfirmed',notification_delivered:null};
  }catch{return {state:'unconfirmed',notification_delivered:null};}
}
export async function runIndependentMonitor({token,policy,pingUrl,fetcher=fetch,now=()=>Date.now(),runId=randomUUID()}){
  if(!uuid(runId)||typeof token!=='string'||!token||token.length>4096)throw new Error('monitor_configuration_missing');
  const started=new Date(now()).toISOString();
  const heartbeatStart=await pingIndependentMonitor(fetcher,pingUrl,runId,'start');
  let assessment,readAttempts=0;
  // Only bounded GET retries. No business mutation or restarting financial work.
  for(let i=0;i<2;i++){
    readAttempts++;
    try{const r=await boundedRequest(fetcher,`${CORE}/internal/operations/cron`,{method:'GET',headers:{authorization:`Bearer ${token}`,accept:'application/json'}});
      if(r.status!==200)throw new Error('source_rejected');assessment=assessCronEvidence(JSON.parse(r.text),policy,now());break;
    }catch{assessment={state:'unknown',issues:[{code:'source_unavailable',task_id:'cloudflare'}],tasks:[],notification_delivered:null};}
  }
  const heartbeat=await pingIndependentMonitor(fetcher,pingUrl,runId,assessment.state==='observed'?'success':'fail');
  return {schema:'delta-independent-observation/v1',run_id:runId,scheduled_at:policy.scheduled_at??null,started_at:started,completed_at:new Date(now()).toISOString(),
    assessment,read_attempts:readAttempts,heartbeat_start:heartbeatStart,heartbeat_completion:heartbeat,notification_delivered:null,
    source_domain:'cloudflare',observer_domain:'github_actions_candidate',deadman_domain:'healthchecks_candidate',
    business_work_replayed:false,production_activation_proven:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    if(process.env.DELTA_INDEPENDENT_MONITOR_ENABLED!=='true'||!/^[a-f0-9]{40}$/.test(process.env.DELTA_APPROVED_MONITOR_SHA??'')||
      process.env.GITHUB_SHA!==process.env.DELTA_APPROVED_MONITOR_SHA)throw new Error('monitor_activation_not_approved');
    const report=await runIndependentMonitor({token:process.env.DELTA_OPERATIONS_ADMIN_SECRET,pingUrl:process.env.DELTA_MONITOR_HEALTHCHECKS_PING_URL,
      policy:{active_since:process.env.DELTA_MONITOR_ACTIVE_SINCE,grace_ms:60000}});
    if(!process.argv[2])throw new Error('create_only_output_required');
    await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({run_id:report.run_id,state:report.assessment.state,issues:report.assessment.issues.length,heartbeat:report.heartbeat_completion.state,notification_delivered:null}));
    if(report.assessment.state!=='observed'||report.heartbeat_start.state!=='accepted'||report.heartbeat_completion.state!=='accepted')process.exitCode=2;
  }catch{console.error('independent_monitor_unconfirmed');process.exitCode=2;}
}
