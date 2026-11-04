// Native workerd + persistent local R2, with synthetic transports and explicit
// fault injection. Raw production artifacts are loaded as unchanged modules.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
const here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,'../..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const cleanEnv=()=>{const env={...process.env};for(const key of Object.keys(env))if(/TOKEN|SECRET|PRIVATE_KEY|MNEMONIC|PASSWORD|API_KEY|CLOUDFLARE|WALLET|NODE_OPTIONS/i.test(key))delete env[key];return {...env,WRANGLER_SEND_METRICS:'false',CI:'true'};};
const scenario=process.argv[6]??'capture';
if(!['capture','preflight','priority','unknown','preproof','post'].includes(scenario))throw Error('invalid_local_scenario');
const product=scenario==='preflight'?'preflight':'capture',amount=product==='preflight'?'5000000':'1000000';
const requestBody={url:'https://example.com/',...(product==='preflight'?{expected:{contains:['missing promise']}}:{})};
const ID='11111111-1111-4111-8111-111111111111',TOKEN=Buffer.alloc(32,17).toString('base64url');
const schedule=Date.parse('2026-11-04T12:00:00.000Z');
const signature=Buffer.from(JSON.stringify({x402Version:2,resource:{url:`https://delta.test/v1/${product}`},accepted:{scheme:'exact',network:'eip155:8453',asset:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',amount,payTo:'0x1990e21bc219696ff7fbc26527dbaed335ac6367',maxTimeoutSeconds:300,extra:{name:'USD Coin',version:'2',paymentFlow:'upfront'}},payload:{signature:'0x'+'ab'.repeat(65),authorization:{from:'0x1111111111111111111111111111111111111111',to:'0x1990e21bc219696ff7fbc26527dbaed335ac6367',value:amount,validAfter:'0',validBefore:'9999999999',nonce:'0x'+'cd'.repeat(32)}}})).toString('base64');

if(process.argv[2]!=='--child'){
  if(![6,7].includes(process.argv.length))throw Error('four_local_paths_required');
  const [candidate,old,compatible,output]=process.argv.slice(2,6).map(value=>resolve(value));
  await mkdir(output,{recursive:false});
  const inputs=[fileURLToPath(import.meta.url),...['0001_telemetry.sql','0002_metric_provenance.sql'].map(name=>join(repo,'migrations',name)),...[candidate,old,compatible].flatMap(build=>['worker/index.js','build-evidence.json','wrangler.jsonc'].map(name=>join(build,name)))];
  const fingerprintInputs=()=>Promise.all(inputs.map(async path=>({path,sha256:sha(await readFile(path))})));
  const inputBefore=await fingerprintInputs();
  const stages=scenario==='unknown'?[['seed-unknown',candidate,false],['old-no-consumer',old,false],['unknown-fallback',compatible,false],['unknown-forward',candidate,false]]:
    scenario==='preproof'?[['seed-preproof',candidate,true],['old-no-consumer',old,false],['preproof-fallback',compatible,false],['preproof-forward',candidate,false]]:
    scenario==='priority'?[['seed-priority',candidate,false],['old-no-consumer',old,false],['priority-fallback',compatible,false],['forward-readback',candidate,false]]:
    scenario==='post'?[['seed-priority',candidate,false],['old-no-consumer',old,false],['post-fallback',compatible,false],['post-forward',candidate,false]]:
    [['seed-crash',candidate,true],['old-no-consumer',old,false],['failed-new-start',candidate,false],['storage-down',compatible,false],['recovery-ack-crash',compatible,true],['fallback-resume',compatible,false],['d1-down',compatible,false],['d1-resume',compatible,false],['forward-readback',candidate,false]];
  const results=[];
  for(const [stage,build,crash] of stages){
    const phase=join(output,stage);await mkdir(phase);
    const child=childProcess.fork(fileURLToPath(import.meta.url),['--child',build,output,stage,scenario],{env:cleanEnv(),stdio:['ignore','pipe','pipe','ipc']});
    let log='',nativePid=null,checkpoint=false;
    child.stdout.on('data',b=>{log+=b;});child.stderr.on('data',b=>{log+=b;});
    const stopNative=()=>{if(nativePid)try{process.kill(nativePid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}};
    const timer=setTimeout(()=>{stopNative();child.kill();},45000);
    const result=await new Promise((accept,reject)=>{
      child.on('message',message=>{
        if(message.type==='native_pid')nativePid=message.pid;
        if(message.type==='checkpoint'){
          checkpoint=true;
          if(!crash||!nativePid){stopNative();child.kill();reject(Error('unexpected_checkpoint'));return;}
          // Actual native child process is forcibly terminated after durable R2
          // readback, not disposed gracefully and not replaced by MemoryBucket.
          process.kill(nativePid,'SIGKILL');
          setTimeout(()=>child.kill('SIGKILL'),100);
        }
      });
      child.once('error',reject);child.once('exit',(code,signal)=>accept({stage,code,signal,native_pid:nativePid,forced_native_crash:checkpoint&&crash}));
    });clearTimeout(timer);await writeFile(join(phase,'process.log'),log,{flag:'wx'});
    if(crash)assert(result.forced_native_crash);else assert.equal(result.code,0,log.slice(-2000));
    results.push(result);
  }
  const read=stage=>readFile(join(output,stage,'state.json'),'utf8').then(JSON.parse);
  const extraScenario=['unknown','preproof','priority','post'].includes(scenario);
  if(extraScenario){
    const initial=await read(stages[0][0]);assert.equal(initial.calls.settle,1);
    const records=await Promise.all(stages.slice(1).map(([stage])=>read(stage)));
    for(const row of records){
      assert.equal(row.calls.settle,0);assert.equal(row.calls.verify,0);assert.equal(row.calls.browser,0);
      assert.deepEqual(row.telemetry.rows.slice(0,initial.telemetry.rows.length),initial.telemetry.rows);
      assert.deepEqual(row.business.filter(r=>!r.key.startsWith('fulfillments/')),initial.business.filter(r=>!r.key.startsWith('fulfillments/')));
    }
    const last=records.at(-1);let checks;
    if(scenario==='priority'||scenario==='post'){
      const pending=s=>s.operational.find(row=>row.key.endsWith('/priority/pending.json'))?.record;
      assert.equal(initial.calls.browser,1);assert.equal(initial.fulfillment.state,'processing');assert.equal(pending(initial).entries.length,1);
      assert.deepEqual(initial.business,records[0].business);assert.deepEqual(pending(initial),pending(records[0]));
      const recovered=records[1];assert.equal(recovered.calls.completion_writes,1);assert.equal(recovered.fulfillment.state,'complete');
      if(scenario==='priority'){
        assert.equal(pending(recovered).entries.length,0);assert.equal(pending(last).entries.length,0);
        assert(recovered.operational.some(row=>row.record?.schema==='delta-paid-recovery-priority-order/v1'&&row.record.state==='resolved'&&row.record.reason==='original_delivery_recovered'));
        assert(recovered.operational.some(row=>row.record?.schema==='delta-paid-recovery-observation/v2'&&row.record.work.priority.counts.recovered===1));
      }
      assert.deepEqual({...initial.fulfillment,state:'complete',updated_at:recovered.fulfillment.updated_at},recovered.fulfillment);
      assert.deepEqual(recovered.business,last.business);assert.equal(last.calls.completion_writes,0);
      checks=scenario==='priority'?['actual_unfinished_response_enrolls_existing_priority_queue','old_worker_retains_pending_entry','native_compatible_priority_drain_recovers_original_once','priority_resolution_durable_and_pending_removed','candidate_replay_preserves_complete_original']:
        ['original_old_native_empty_POST_reproduces_400','compatible_native_HTTP_POST_recovers_original_once','dispatch_and_real_HTTP_zero_byte_variants_accepted','nonempty_signature_and_wrong_capability_rejected','candidate_native_POST_preserves_original_completion'];
    }else{
      for(const row of records){assert.deepEqual(row.business,initial.business);assert.equal(row.calls.completion_writes,0);}
      const reason=scenario==='unknown'?'settlement_unknown':'evidence_inconsistent';
      assert.equal(initial.calls.browser,scenario==='unknown'?0:1);
      if(scenario==='unknown'){assert.equal(initial.fulfillment,null);assert.equal(initial.settlement.state,'settlement_unknown');}
      else{assert.equal(initial.fulfillment.state,'processing');assert(initial.fulfillment.response);assert.equal(initial.business.length,3);}
      assert(last.operational.some(row=>row.record?.result?.items?.some(item=>item.reason===reason)));
      checks=[scenario==='unknown'?'actual_unknown_settlement_reservation_retained':'actual_preproof_crash_retains_unfulfilled_paid_liability','old_and_compatible_and_forward_original_bytes_unchanged','native_recovery_reports_original_reconciliation_reason','buyer_status_and_signed_replay_do_not_repeat_settlement_or_browser'];
    }
    assert.deepEqual(await fingerprintInputs(),inputBefore);
    const fulfilled=['priority','post'].includes(scenario);
    const report={schema:'delta-native-rollback-paid-continuity/v1',scenario,product,qualification_inputs:inputBefore,qualification_inputs_stable:true,results,checks,real_payment:false,external_forwarded:0,real_browser_calls:0,production_qualified:false,synthetic_native_R2:true,independent_OS_processes:true,fulfilled,liability_unresolved:!fulfilled,liability_state:scenario==='preproof'?'confirmed_settlement_unfulfilled':scenario==='unknown'?'unknown_payment_exposure':'original_delivery_complete',financial_totals:'unknown',actual_costs:'unknown',ok:true};
    await writeFile(join(output,'result.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));
  }else{
  const initial=await read('seed-crash'),oldState=await read('old-no-consumer'),outage=await read('storage-down'),ack=await read('recovery-ack-crash'),after=await read('fallback-resume'),d1Down=await read('d1-down'),d1Resume=await read('d1-resume'),forward=await read('forward-readback');
  const immutable=s=>s.business.filter(r=>!r.key.startsWith('fulfillments/'));
  assert.deepEqual(immutable(initial),immutable(after));assert.deepEqual(immutable(initial),immutable(forward));
  assert.deepEqual(initial.business,oldState.business);assert.deepEqual(initial.business,outage.business);
  assert.equal(initial.fulfillment.state,'processing');assert.equal(after.fulfillment.state,'complete');
  assert.deepEqual({...initial.fulfillment,state:'complete',updated_at:after.fulfillment.updated_at},after.fulfillment);
  assert.deepEqual(after.business,forward.business);
  for(const stage of ['old-no-consumer','storage-down','recovery-ack-crash','fallback-resume','d1-down','d1-resume','forward-readback']){
    const row=await read(stage);assert.equal(row.calls.settle,0);assert.equal(row.calls.verify,0);assert.equal(row.calls.browser,0);
    assert.deepEqual(row.telemetry.rows.slice(0,initial.telemetry.rows.length),initial.telemetry.rows);
  }
  assert(initial.telemetry.rows.length>0);assert(initial.telemetry.columns.includes('metric_schema'));
  assert.equal(ack.calls.completion_writes,1);
  assert.deepEqual(after.business,d1Down.business);assert.deepEqual(after.business,d1Resume.business);
  assert.equal(d1Down.calls.d1_rejected,2);assert.deepEqual(d1Down.telemetry.rows,after.telemetry.rows);
  assert.equal(d1Resume.calls.d1_rejected,0);assert.equal(d1Resume.telemetry.rows.length,d1Down.telemetry.rows.length+2);
  assert(d1Down.telemetry.gap.completeness==='incomplete');
  assert.equal(after.calls.completion_writes,0);assert.equal(forward.calls.completion_writes,0);
  assert.equal(initial.calls.settle,1);assert.equal(initial.calls.browser,1);
  assert.deepEqual(await fingerprintInputs(),inputBefore);
  if(product==='preflight'){assert.equal(initial.fulfillment.paid_price_usd,5);assert.equal(after.fulfillment.response.safe,false);assert.equal(after.fulfillment.response.reason,'expectation_failed');}
  const report={schema:'delta-native-rollback-paid-continuity/v1',scenario,product,qualification_inputs:inputBefore,qualification_inputs_stable:true,results,checks:['actual_core_synthetic_settlement_and_draft','native_process_killed_after_durable_draft','unmodified_old_worker_does_not_consume_obligation','failed_new_start_preserves_storage','temporary_R2_read_failure_does_not_clear_original','compatible_fallback_original_CAS_commits','native_process_killed_after_completion_before_ACK','restart_reads_complete_without_second_completion','buyer_order_and_signed_replay_readback','forward_reader_preserves_original_identity','all_original_proof_payment_order_bytes_preserved','native_D1_additive_columns_and_original_rows_retained','native_D1_write_outage_does_not_deadlock_paid_replay','native_D1_writer_resumes_without_claiming_gap_complete'],
    real_payment:false,external_forwarded:0,real_browser_calls:0,production_qualified:false,synthetic_native_R2:true,independent_OS_processes:true,paid_draft_restart_verified_locally:true,
    telemetry_gap:{failed_writes:d1Down.calls.d1_rejected,replayed:false,completeness:'incomplete',financial_totals:'unknown'},
    limitations:['synthetic facilitator and browser transports','fault injection wrapper around unchanged artifact module','D1 telemetry rejected during outage is not replayed; financial totals remain unknown','no live account, deployed version or independent notification acceptance'],ok:true};
  await writeFile(join(output,'result.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));
  }
}else{
  const [build,output,stage]=process.argv.slice(3).map((v,i)=>i<2?resolve(v):v),phase=join(output,stage);
  Object.assign(process.env,cleanEnv());for(const key of Object.keys(process.env))if(/TOKEN|SECRET|PRIVATE_KEY|MNEMONIC|PASSWORD|API_KEY|CLOUDFLARE|WALLET|NODE_OPTIONS/i.test(key))delete process.env[key];
  const isolated=join(phase,'isolated-home');await mkdir(isolated);os.homedir=()=>isolated;process.env.XDG_CONFIG_HOME=isolated;
  const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const first=Array.isArray(args[0])?args[0][0]:args[0];const host=typeof first==='object'?first?.host:typeof args[1]==='string'?args[1]:'localhost';if(!['localhost','127.0.0.1','::1','[::1]'].includes(host??'localhost'))throw Error('REMOTE_SOCKET_DENIED');return connect.apply(this,args);};
  tls.connect=()=>{throw Error('REMOTE_TLS_DENIED');};
  const spawn=childProcess.spawn;childProcess.spawn=function(file,args,options){const child=spawn.call(this,file,args,options);if(String(file).toLowerCase().includes('workerd'))process.send({type:'native_pid',pid:child.pid});return child;};syncBuiltinESMExports();
  const {Miniflare,Log,LogLevel,convertV4MiniflareOptions}=await import(pathToFileURL(join(repo,'node_modules/miniflare/dist/src/index.js')));
  const evidence=JSON.parse(await readFile(join(build,'build-evidence.json'),'utf8')),bytes=await readFile(join(build,'worker/index.js'));assert.equal(sha(bytes),evidence.artifacts.find(a=>a.path==='worker/index.js').sha256);
  const cfg=JSON.parse(await readFile(join(build,'wrangler.jsonc'),'utf8'));
  const calls={supported:0,verify:0,settle:0,browser:0,completion_writes:0,d1_rejected:0,external_forwarded:0};let runtime;
  const shim=`import original from './core.mjs';
const stage=${JSON.stringify(stage)};
async function notify(kind){await fetch('https://fault.local/'+kind,{method:'POST'});}
function envFor(env){const storage=env.PROOFS;const proxy=new Proxy(storage,{get(target,key){
if(key==='put')return async(name,value,options)=>{const record=name.startsWith('fulfillments/')?JSON.parse(value):null;
if(stage==='seed-crash'&&record?.state==='complete'){await notify('checkpoint');await new Promise(()=>{});}
if(stage==='seed-priority'&&record?.state==='complete')throw Error('synthetic_final_write_rejected_before_commit');
const result=await target.put(name,value,options);
if(result&&stage==='seed-preproof'&&record?.state==='processing'&&record.response){await notify('checkpoint');await new Promise(()=>{});}
if(result&&record?.state==='complete')await notify('completion-write');
if(result&&stage==='recovery-ack-crash'&&record?.state==='complete'){await notify('checkpoint');await new Promise(()=>{});}return result;};
if(stage==='storage-down'&&(key==='get'||key==='list'))return async()=>{throw Error('synthetic_storage_unavailable');};
const item=target[key];return typeof item==='function'?item.bind(target):item;}});
const analytics=stage==='d1-down'?{prepare(sql){const native=env.ANALYTICS_DB.prepare(sql);return {bind(...args){native.bind(...args);return {async run(){await notify('d1-rejected');throw Error('synthetic_D1_write_unavailable');}};}};}}:env.ANALYTICS_DB;
return {...env,PROOFS:proxy,ANALYTICS_DB:analytics,BROWSER:{async quickAction(){await notify('browser');return Response.json({success:true,result:{content:'<h1>Example</h1>',markdown:'Example',screenshot:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='},meta:{status:200,finalUrl:'https://example.com/'}},{headers:{'x-browser-ms-used':'1'}});}}};}
export default {async fetch(request,env,ctx){const pending=[];const local={waitUntil(p){pending.push(p);ctx.waitUntil(p.catch(()=>{}));},passThroughOnException(){}};const bound=envFor(env);
if(new URL(request.url).pathname==='/__synthetic/scheduled'){await original.scheduled({cron:'*/15 * * * *',scheduledTime:${schedule+(['fallback-resume','d1-down','d1-resume','forward-readback','unknown-forward','preproof-forward'].includes(stage)?900000:0)},noRetry(){}},bound,local);const results=await Promise.allSettled(pending);return Response.json({outcomes:results.map(r=>r.status)}, {status:results.some(r=>r.status==='rejected')?503:200});}
const response=await original.fetch(request,bound,local);await Promise.allSettled(pending);return response;}};`;
  await writeFile(join(phase,'injection-module.mjs'),shim,{flag:'wx'});
  async function snapshot(){const bucket=await runtime.getR2Bucket('PROOFS'),listed=await bucket.list(),business=[],operational=[];let fulfillment=null,settlement=null;for(const {key}of listed.objects){const object=await bucket.get(key),raw=Buffer.from(await object.arrayBuffer());if(!key.startsWith('operations/')&&!key.startsWith('ops/'))business.push({key,sha256:sha(raw)});else operational.push({key,record:JSON.parse(raw.toString())});if(key.startsWith('fulfillments/'))fulfillment=JSON.parse(raw.toString());if(key.startsWith('settlements/'))settlement=JSON.parse(raw.toString());}business.sort((a,b)=>a.key.localeCompare(b.key));const db=await runtime.getD1Database('ANALYTICS_DB');const rows=(await db.prepare('SELECT * FROM telemetry_events ORDER BY id').all()).results;const columns=(await db.prepare('PRAGMA table_info(telemetry_events)').all()).results.map(row=>row.name);const telemetry={rows,columns,gap:{failed_writes:calls.d1_rejected,completeness:calls.d1_rejected?'incomplete':'not_assessed',financial_totals:'unknown'}};const report={stage,artifact_sha256:sha(bytes),business,operational,fulfillment,settlement,telemetry,calls:{...calls}};await writeFile(join(phase,'state.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});return report;}
  const options={name:'delta-p0-rollback',modulesRoot:phase,modules:[{type:'ESModule',path:join(phase,'entry.mjs'),contents:stage==='failed-new-start'?"throw Error('synthetic_new_version_startup_failure');export default {};":shim},{type:'ESModule',path:join(phase,'core.mjs'),contents:bytes.toString()}],
    compatibilityDate:cfg.compatibility_date,compatibilityFlags:cfg.compatibility_flags,host:'127.0.0.1',port:0,cf:false,unsafeRegisterWorker:false,log:new Log(LogLevel.ERROR),
    r2Buckets:['PROOFS'],d1Databases:['ANALYTICS_DB'],resourcePersistencePath:join(output,'synthetic-storage'),bindings:{...cfg.vars,PUBLIC_ORIGIN:'https://delta.test',FACILITATOR_URL:'https://facilitator.test',ORDER_RECOVERY_TTL_SECONDS:'3600',OPERATIONS_CLOUD_ENABLED:'true',PAID_ORDER_DRAFT_RECOVERY_ENABLED:'true'},
    outboundService:async request=>{const u=new URL(request.url);if(u.origin==='https://fault.local'){if(u.pathname==='/browser')calls.browser++;if(u.pathname==='/completion-write')calls.completion_writes++;if(u.pathname==='/d1-rejected')calls.d1_rejected++;if(u.pathname==='/checkpoint'){await snapshot();process.send({type:'checkpoint'});return new Promise(()=>{});}return new Response('ok');}
      if(u.origin==='https://facilitator.test'){if(u.pathname==='/supported'){calls.supported++;return Response.json({kinds:[{x402Version:2,scheme:'exact',network:'eip155:8453'}],extensions:[],signers:{}});}if(u.pathname==='/verify'){calls.verify++;return Response.json({isValid:true,payer:'0x1111111111111111111111111111111111111111'});}if(u.pathname==='/settle'){calls.settle++;return Response.json({success:scenario!=='unknown',...(scenario==='unknown'?{errorReason:'synthetic_outcome_unknown'}:{}),transaction:'0x'+'12'.repeat(32),network:'eip155:8453',payer:'0x1111111111111111111111111111111111111111'});}}
      if(u.origin==='https://cloudflare-dns.com')return Response.json(u.searchParams.get('type')==='A'?{Status:0,Answer:[{type:1,data:'93.184.216.34'}]}:{Status:0,Answer:[]});
      if(u.origin==='https://example.com')return new Response('',{status:200});throw Error('UNEXPECTED_EGRESS_DENIED');}};
  try{runtime=new Miniflare({...convertV4MiniflareOptions(options),telemetry:{enabled:false}});await runtime.ready;
    if(stage==='failed-new-start')throw Error('expected_startup_failure_missing');
    const invokeOriginal=()=>runtime.dispatchFetch(`https://delta.test/v1/${product}`,{method:'POST',headers:{'content-type':'application/json','payment-signature':signature,'x-delta-order-id':ID,'x-delta-recovery-token':TOKEN},body:JSON.stringify(requestBody)});
    if(stage.startsWith('seed-')){
      const db=await runtime.getD1Database('ANALYTICS_DB');for(const path of ['0001_telemetry.sql','0002_metric_provenance.sql']){const text=await readFile(join(repo,'migrations',path),'utf8');for(const sql of text.replace(/--[^\r\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();}
      const response=await invokeOriginal();
      if(['seed-crash','seed-preproof'].includes(stage))throw Error('expected_seed_crash_missing');
      assert.equal(response.status,503,await response.text());await snapshot();
    }else{
    const response=stage.startsWith('post-')?new Response('no_scheduled_recovery',{status:200}):await runtime.dispatchFetch('https://delta.test/__synthetic/scheduled');
    const degraded=['storage-down','unknown-fallback','unknown-forward','preproof-fallback','preproof-forward'].includes(stage);
    if(response.status!==(degraded?503:200))await snapshot();
    assert.equal(response.status,degraded?503:200,await response.text());
    if(stage==='recovery-ack-crash')throw Error('expected_ack_crash_missing');
    if(scenario==='post'){
      const matrix=[],base=await runtime.ready;
      // Real HTTP runs first: the first compatible POST must perform the one
      // original completion itself, without help from a scheduled invocation.
      for(const transport of ['loopback-http','dispatch'])for(const kind of ['no-body','length-zero','empty-bytes','empty-string','space','payment-signature','x-payment','wrong-token','wrong-id']){
        const path=`/v1/orders/${kind==='wrong-id'?'22222222-2222-4222-8222-222222222222':ID}/recover`;
        const headers={'x-delta-recovery-token':kind==='wrong-token'?Buffer.alloc(32,34).toString('base64url'):TOKEN};
        if(kind==='length-zero')headers['content-length']='0';
        if(['payment-signature','x-payment'].includes(kind))headers[kind]='forbidden';
        const body=kind==='empty-bytes'?new Uint8Array():kind==='empty-string'?'':kind==='space'?' ':undefined;
        let actual;
        if(transport==='dispatch'){const result=await runtime.dispatchFetch(`https://delta.test${path}`,{method:'POST',headers,body});actual={status:result.status,body:await result.json()};}
        else actual=await new Promise((resolve,reject)=>{const request=http.request(new URL(path,base),{method:'POST',headers,agent:false},response=>{let data='';response.on('data',chunk=>data+=chunk);response.on('end',()=>{try{resolve({status:response.statusCode,body:JSON.parse(data)});}catch(error){reject(error);}});});request.on('error',error=>reject(Error(`${stage}/${transport}/${kind}: ${error.code}`)));request.end(body);});
        const invalid=['space','payment-signature','x-payment'].includes(kind),unauthorized=['wrong-token','wrong-id'].includes(kind);
        const expected=unauthorized?404:invalid||stage==='old-no-consumer'?400:200;
        assert.equal(actual.status,expected,JSON.stringify({transport,kind,actual}));
        if(expected===200)assert.equal(actual.body.state,'complete');
        matrix.push({transport,kind,http:actual.status,state:actual.body.state??null,error:actual.body.error??null});
      }
      await writeFile(join(phase,'native-post-matrix.json'),JSON.stringify(matrix,null,2)+'\n',{flag:'wx'});
    }
    if(['fallback-resume','d1-down','d1-resume','forward-readback','priority-fallback'].includes(stage)){
      const status=await runtime.dispatchFetch(`https://delta.test/v1/orders/${ID}`,{headers:{'x-delta-recovery-token':TOKEN}});
      assert.equal(status.status,200);assert.equal((await status.json()).state,'complete');
      const replay=await invokeOriginal();
      assert.equal(replay.status,200);const delivered=await replay.json();assert.equal(delivered.idempotent_replay,true);
      if(product==='preflight'){assert.equal(delivered.safe,false);assert.equal(delivered.reason,'expectation_failed');}
      await writeFile(join(phase,'buyer-readback.json'),JSON.stringify({state:'complete',proof_id:delivered.proof_id,bundle_root:delivered.bundle_root,idempotent_replay:true}),{flag:'wx'});
    }
    if(['unknown-fallback','unknown-forward','preproof-fallback','preproof-forward'].includes(stage)){
      const recovery=await runtime.dispatchFetch(`https://delta.test/v1/orders/${ID}`,{headers:{'x-delta-recovery-token':TOKEN}});
      const view=await recovery.json();assert.equal(recovery.status,scenario==='unknown'?202:503);
      if(scenario==='unknown'){assert.equal(view.payment.state,'settlement_unknown');assert.equal(view.fulfillment.state,'not_started');assert.equal(view.reconciliation_required,true);}
      const replay=await invokeOriginal();const replayBody=await replay.json();
      if(scenario==='preproof'){
        if(stage==='preproof-forward'){
          assert.equal(view.remediation?.state,'needs_intervention');assert.equal(view.remediation?.obligation,'original_paid_delivery_unresolved');
          assert.equal(view.remediation?.historical_evidence_loss_confirmed,null);assert.equal(view.remediation?.additional_payment_required,false);
          assert.equal(view.remediation?.replacement_observation.authorized,false);assert.equal(view.remediation?.refund.authorized,false);
          assert.equal(view.remediation?.customer_revenue_recognized,null);
        }
        assert([202,503].includes(replay.status));assert.notEqual(replayBody.idempotent_replay,true);
        assert(['processing','fulfillment_unknown'].includes(replayBody.state));assert.equal(replayBody.proof_id,undefined);
      }else assert.equal(replay.status,503);
      if(scenario==='unknown'){assert.equal(replayBody.state,'settlement_unknown');assert.equal(replayBody.requires_settlement_reconciliation,true);}
      await writeFile(join(phase,'buyer-readback.json'),JSON.stringify({recover_http:recovery.status,recovery:view,replay_http:replay.status,replay:replayBody}),{flag:'wx'});
    }
    await snapshot();
    }
  }catch(error){if(stage!=='failed-new-start'||!String(error.message).includes('synthetic_new_version_startup_failure'))throw error;await writeFile(join(phase,'expected-startup-failure.json'),JSON.stringify({expected:true,name:error.name,injected_marker_verified:true,message:String(error.message).slice(0,500)}),{flag:'wx'});}
  finally{try{await runtime?.dispose();}catch(error){if(stage!=='failed-new-start')throw error;}}
  process.disconnect();
}
