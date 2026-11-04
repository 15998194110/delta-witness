// Offline qualification of exact Worker artifacts with native workerd/local R2.
// All Treasury observations, provider responses, addresses and credentials below
// are synthetic fixtures. No production account or real email is contacted.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const stable=v=>JSON.stringify(v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])):Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):v);
const cleanEnv=()=>{const env={...process.env};for(const key of Object.keys(env))if(/TOKEN|SECRET|PRIVATE_KEY|MNEMONIC|PASSWORD|API_KEY|CLOUDFLARE|WALLET|NODE_OPTIONS/i.test(key))delete env[key];return {...env,WRANGLER_SEND_METRICS:'false',CI:'true'};};
const ID='11111111-1111-4111-8111-111111111111';
const asset='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',treasury='0x1990e21bc219696ff7fbc26527dbaed335ac6367';
const from='delta@example.test',to='owner@example.test',destination='synthetic-owner';
const configDigest='sha256:'+sha(stable({provider:'resend',from,to,destination_id:destination}));
const custodyKey='operations/treasury/revisions/revision-0000000001.json';

if(process.argv[2]!=='--child'){
  assert.equal(process.argv.length,5,'candidate, previous reader, fresh output required');
  const [candidate,previous,output]=process.argv.slice(2).map(p=>resolve(p));
  if(process.platform==='win32'&&join(output,'synthetic-storage/r2/miniflare-R2BucketObject','0'.repeat(64)+'.sqlite-wal').length>248)throw Error('shorter_local_output_path_required_for_native_sqlite');
  await mkdir(output,{recursive:false});
  const inputs=[fileURLToPath(import.meta.url),...[candidate,previous].flatMap(dir=>['worker/index.js','build-evidence.json','wrangler.jsonc'].map(p=>join(dir,p)))];
  const fingerprint=()=>Promise.all(inputs.map(async path=>({path,sha256:sha(await readFile(path))})));
  const before=await fingerprint(),results=[];
  const stages=[['seed-current',candidate,false],['send-ack-crash',candidate,true],['previous-reader',previous,false],['forward-readback',candidate,false],['forward-replay',candidate,false]];
  for(const [stage,build,crash]of stages){
    if(stage==='forward-readback'){
      const original=JSON.parse(await readFile(join(output,'send-ack-crash','state.json'),'utf8'));
      // Respect the real original lease. Never edit/expire the durable lock.
      const remaining=Date.parse(original.episode.record.lease_until)-Date.now()+25;
      if(remaining>0){assert(remaining<=16000);await new Promise(r=>setTimeout(r,remaining));}
    }
    const phase=join(output,stage);await mkdir(phase);
    const child=childProcess.fork(fileURLToPath(import.meta.url),['--child',build,output,stage],{env:cleanEnv(),stdio:['ignore','pipe','pipe','ipc']});
    let log='',nativePid=null,checkpoint=false,timedOut=false;
    child.stdout.on('data',b=>{log+=b;});child.stderr.on('data',b=>{log+=b;});
    const stop=()=>{if(nativePid)try{process.kill(nativePid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}child.kill();};
    const timer=setTimeout(()=>{timedOut=true;stop();},45000);
    const result=await new Promise((accept,reject)=>{
      child.on('message',message=>{
        if(message.type==='native_pid')nativePid=message.pid;
        if(message.type==='checkpoint'){
          checkpoint=true;if(!crash||!nativePid){stop();reject(Error('unexpected checkpoint'));return;}
          process.kill(nativePid,'SIGKILL');setTimeout(()=>child.kill('SIGKILL'),100);
        }
      });
      child.once('error',reject);child.once('exit',(code,signal)=>accept({stage,code,signal,native_pid:nativePid,forced_native_crash:checkpoint&&crash,timed_out:timedOut}));
    });clearTimeout(timer);await writeFile(join(phase,'process.log'),log,{flag:'wx'});
    if(crash)assert(result.forced_native_crash,log.slice(-2000));else assert.equal(result.code,0,log.slice(-2000));results.push(result);
  }
  const read=stage=>readFile(join(output,stage,'state.json'),'utf8').then(JSON.parse);
  const [seed,crashed,old,forward,replay]=await Promise.all(stages.map(([s])=>read(s)));
  assert.equal(seed.episode.record.state,'queued');assert.equal(seed.episode.record.episode.severity,'INFO');assert.equal(seed.provider,null);
  assert.equal(crashed.episode.record.state,'sending');assert.equal(crashed.transport.record.state,'posting');
  assert.equal(crashed.transport.record.provider_email_id,null);assert.equal(crashed.provider.accepted_count,1);assert.equal(crashed.provider.response_delivered_to_worker,false);
  assert.equal(old.reader_response.status,503);assert.equal(old.reader_response.body.error,'alert_evidence_unavailable');
  assert.equal(old.episode.sha256,crashed.episode.sha256);assert.equal(old.transport.sha256,crashed.transport.sha256);
  assert.equal(forward.episode.record.state,'delivered');assert.equal(forward.transport.record.state,'delivered');assert.equal(forward.transport.record.provider_email_id,ID);
  assert.equal(forward.episode.record.receipt.status,'delivered');assert.equal(forward.episode.record.acknowledgment,null);
  for(const snapshot of [crashed,old,forward,replay]){
    assert.equal(snapshot.custody.sha256,seed.custody.sha256);assert.equal(snapshot.episode.record.notification_id,seed.episode.record.notification_id);
    assert.equal(snapshot.episode.record.payload_hash,seed.episode.record.payload_hash);assert.equal(snapshot.provider.accepted_count,1);
    assert.equal(snapshot.transport.record.request_hash,crashed.transport.record.request_hash);assert.equal(snapshot.transport.record.attempts,1);
    assert.equal(snapshot.episode.record.episode.receipt.customer_revenue,'UNKNOWN');assert.equal(snapshot.episode.record.episode.receipt.actual_cost,'UNKNOWN');
  }
  for(const snapshot of [old,forward,replay])assert.equal(snapshot.calls.provider_post,0);
  assert.equal(replay.episode.sha256,forward.episode.sha256);assert.equal(replay.transport.sha256,forward.transport.sha256);
  assert.deepEqual(await fingerprint(),before,'qualification bytes changed');
  const report={schema:'delta-native-notification-forward-recovery/v1',qualification_inputs:before,qualification_inputs_stable:true,results,
    checks:['actual_scheduled_producer_queues_original_INFO_receipt','provider_POST_durably_accepted_before_forced_native_crash','original_lease_expires_without_lock_edit','old_reader_rejects_INFO_and_preserves_original_bytes','forward_native_GET_matches_exact_original_provider_identity','one_provider_POST_across_crash_old_reader_and_forward_recovery','delivered_does_not_mean_owner_acknowledged_or_customer_revenue','terminal_replay_preserves_original_receipt_and_request_hash'],
    real_provider_calls:0,real_payment:false,real_browser_calls:0,production_qualified:false,old_reader_notification_compatible:false,forward_notification_recovery_verified_locally:true,
    limitations:['All provider and Treasury data are explicitly synthetic; local native persistence only.','This proves compatible forward recovery, not a safe whole-system rollback to the old reader.','No live Resend identity, production delivery, recipient acknowledgment or 48-hour soak is qualified.'],ok:true};
  await writeFile(join(output,'result.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));
}else{
  const [build,output,stage]=process.argv.slice(3).map((p,i)=>i<2?resolve(p):p),phase=join(output,stage);
  for(const key of Object.keys(process.env))if(/TOKEN|SECRET|PRIVATE_KEY|MNEMONIC|PASSWORD|API_KEY|CLOUDFLARE|WALLET|NODE_OPTIONS/i.test(key))delete process.env[key];
  const isolated=join(phase,'isolated-home');await mkdir(isolated);os.homedir=()=>isolated;process.env.XDG_CONFIG_HOME=isolated;
  const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const first=Array.isArray(args[0])?args[0][0]:args[0];const host=typeof first==='object'?first?.host:typeof args[1]==='string'?args[1]:'localhost';if(!['localhost','127.0.0.1','::1','[::1]'].includes(host??'localhost'))throw Error('REMOTE_SOCKET_DENIED');return connect.apply(this,args);};
  tls.connect=()=>{throw Error('REMOTE_TLS_DENIED');};
  const spawn=childProcess.spawn;childProcess.spawn=function(file,args,options){const child=spawn.call(this,file,args,options);if(String(file).toLowerCase().includes('workerd'))process.send({type:'native_pid',pid:child.pid});return child;};syncBuiltinESMExports();
  const {Miniflare,Log,LogLevel,convertV4MiniflareOptions}=await import(pathToFileURL(join(repo,'node_modules/miniflare/dist/src/index.js')));
  const evidence=JSON.parse(await readFile(join(build,'build-evidence.json'),'utf8')),bytes=await readFile(join(build,'worker/index.js'));
  assert.equal(sha(bytes),evidence.artifacts.find(a=>a.path==='worker/index.js').sha256);
  const cfg=JSON.parse(await readFile(join(build,'wrangler.jsonc'),'utf8'));
  let revision;
  if(stage==='seed-current'){
    const h=n=>'0x'+n.toString(16).padStart(64,'0');
    const state={schema:'delta-treasury-checkpoint/v1',network:'eip155:8453',asset,treasury,origin_block:1,checked_through_block:100,checked_through_hash:h(100),reorg_anchor:{number:90,hash:h(90)},confirmation_depth:12,checked_at:new Date(Date.now()-1000).toISOString(),transfers:[{receipt_id:`eip155:8453:${asset}:${h(1)}:0`,tx_hash:h(1),block_hash:h(2),block_number:2,log_index:0,from:'0x1111111111111111111111111111111111111111',to:treasury,raw_amount:'1000000',usdc_decimal:'1.000000',usdc:1,treasury_received:true,payer_classification:'unclassified',customer_revenue:'unclassified'}],corrections:[]};
    revision={schema:'delta-treasury-revision/v1',version:1,previous_digest:null,digest:sha(JSON.stringify(state)),state};
    await writeFile(join(output,'synthetic-custody.json'),JSON.stringify(revision),{flag:'wx'});
  }else revision=JSON.parse(await readFile(join(output,'synthetic-custody.json'),'utf8'));
  const calls={provider_get:0,provider_post:0,unexpected_egress:0};let runtime,readerResponse=null;
  const providerPath=join(output,'synthetic-provider.json');
  const provider=async()=>{try{return JSON.parse(await readFile(providerPath,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
  async function snapshot(){
    const bucket=await runtime.getR2Bucket('PROOFS'),entries=(await bucket.list()).objects;
    const items=await Promise.all(entries.map(async({key})=>{const value=await bucket.get(key),raw=await value.text();return {key,sha256:sha(raw),record:JSON.parse(raw)};}));
    const report={stage,artifact_sha256:sha(bytes),custody:items.find(x=>x.key===custodyKey),episode:items.find(x=>x.key.startsWith('operations/alerts/episodes/')&&x.record.episode?.code==='treasury_received'),transport:items.find(x=>x.key.startsWith('operations/alerts/resend/')),provider:await provider(),reader_response:readerResponse,calls:{...calls},other_operational_keys:items.filter(x=>!x.key.startsWith('operations/treasury/')&&!x.key.startsWith('operations/alerts/episodes/')&&!x.key.startsWith('operations/alerts/resend/')).map(x=>x.key)};
    await writeFile(join(phase,'state.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});return report;
  }
  const shim=`import original from './core.mjs';export default {async fetch(request,env,ctx){const pending=[];const local={waitUntil(p){pending.push(p);ctx.waitUntil(p.catch(()=>{}));},passThroughOnException(){}};
  const bound={...env,BROWSER:{async quickAction(){throw Error('REAL_BROWSER_FORBIDDEN');}}};
  if(new URL(request.url).pathname==='/__synthetic/seed'){await env.PROOFS.put(${JSON.stringify(custodyKey)},${JSON.stringify(JSON.stringify(revision))});return Response.json({synthetic_seed:true});}
  if(new URL(request.url).pathname==='/__synthetic/scheduled'){await original.scheduled({cron:'*/15 * * * *',scheduledTime:Date.parse('2026-11-04T12:00:00Z'),noRetry(){}},bound,local);const results=await Promise.allSettled(pending);return Response.json({outcomes:results.map(r=>({status:r.status,reason:r.status==='rejected'?String(r.reason):null}))},{status:results.some(r=>r.status==='rejected')?503:200});}
  const response=await original.fetch(request,bound,local);await Promise.allSettled(pending);return response;}};`;
  await writeFile(join(phase,'injection-module.mjs'),shim,{flag:'wx'});
  const options={name:'delta-notification-qualification',modulesRoot:phase,modules:[{type:'ESModule',path:join(phase,'entry.mjs'),contents:shim},{type:'ESModule',path:join(phase,'core.mjs'),contents:bytes.toString()}],compatibilityDate:cfg.compatibility_date,compatibilityFlags:cfg.compatibility_flags,host:'127.0.0.1',port:0,cf:false,unsafeRegisterWorker:false,log:new Log(LogLevel.ERROR),r2Buckets:['PROOFS'],d1Databases:['ANALYTICS_DB'],resourcePersistencePath:join(output,'synthetic-storage'),bindings:{...cfg.vars,PUBLIC_ORIGIN:'https://delta.test',OPERATIONS_ADMIN_SECRET:'synthetic-admin',OPERATIONS_CLOUD_ENABLED:'true',OPERATIONS_ALERT_OUTBOX_ENABLED:'true',OPERATIONS_TREASURY_NOTIFICATIONS_ENABLED:stage==='seed-current'?'true':'false',OPERATIONS_ALERT_DELIVERY_ENABLED:stage==='seed-current'?'false':'true',OPERATIONS_ALERT_RESEND_API_KEY:'re_synthetic_offline_only',OPERATIONS_ALERT_RESEND_FROM:from,OPERATIONS_ALERT_RESEND_TO:to,OPERATIONS_ALERT_DESTINATION_ID:destination,OPERATIONS_ALERT_DESTINATION_DIGEST:configDigest,OPERATIONS_ALERT_RESEND_APPROVED_CONFIGURATION_DIGEST:configDigest,OPERATIONS_ALERT_RESEND_APPROVAL_EVIDENCE_REF:'synthetic-reviewed',TREASURY_CUSTODY_ENABLED:'true',TREASURY_CUSTODY_ORIGIN_BLOCK:'1',TREASURY_CUSTODY_MINIMUM_VERSION:'1',TREASURY_CUSTODY_MINIMUM_DIGEST:revision.digest},
    outboundService:async request=>{
      const url=new URL(request.url);if(url.origin!=='https://api.resend.com'){calls.unexpected_egress++;throw Error('UNEXPECTED_EGRESS_DENIED');}
      if(request.method==='POST'&&url.pathname==='/emails'){
        calls.provider_post++;assert.equal(stage,'send-ack-crash');assert.equal(await provider(),null,'duplicate synthetic provider POST');
        const email=await request.json(),record={schema:'explicitly-synthetic-provider/v1',accepted_count:1,response_delivered_to_worker:false,id:ID,email:{object:'email',id:ID,...email,html:null,created_at:new Date().toISOString(),last_event:'delivered'}};
        await writeFile(providerPath,JSON.stringify(record,null,2)+'\n',{flag:'wx'});await snapshot();process.send({type:'checkpoint'});return new Promise(()=>{});
      }
      assert.equal(request.method,'GET');calls.provider_get++;
      if(url.pathname==='/domains')return Response.json({object:'list',data:[{id:ID,name:'example.test',status:'verified',capabilities:{sending:'enabled'}}],has_more:false});
      const saved=await provider();
      if(url.pathname==='/emails')return Response.json({object:'list',data:saved?[saved.email]:[],has_more:false});
      if(url.pathname===`/emails/${ID}`&&saved)return Response.json(saved.email);
      throw Error('UNEXPECTED_SYNTHETIC_PROVIDER_ROUTE');
    }};
  try{
    runtime=new Miniflare({...convertV4MiniflareOptions(options),telemetry:{enabled:false}});await runtime.ready;
    if(stage==='seed-current'){const seeded=await runtime.dispatchFetch('https://delta.test/__synthetic/seed');assert.equal(seeded.status,200,await seeded.text());}
    if(stage==='previous-reader'){
      const episode=JSON.parse(await readFile(join(output,'send-ack-crash','state.json'),'utf8')).episode.record;
      const response=await runtime.dispatchFetch('https://delta.test/internal/operations/alerts/read',{method:'POST',headers:{authorization:'Bearer synthetic-admin','content-type':'application/json'},body:JSON.stringify({dedupe_key:episode.episode.dedupe_key})});readerResponse={status:response.status,body:await response.json()};
    }
    const response=await runtime.dispatchFetch('https://delta.test/__synthetic/scheduled'),body=await response.json();
    await writeFile(join(phase,'scheduled-result.json'),JSON.stringify({status:response.status,body},null,2)+'\n',{flag:'wx'});
    if(stage==='send-ack-crash')throw Error('expected forced crash not reached');
    await snapshot();assert.equal(calls.unexpected_egress,0);if(stage!=='previous-reader')assert.equal(response.status,200,JSON.stringify(body));
  }finally{if(runtime)await runtime.dispose();}
}
