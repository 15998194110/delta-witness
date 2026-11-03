// Explicit local OS-process fault rehearsal. Never invokes a cloud provider.
import http from 'node:http';
import {fork} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),output=resolve(process.argv[2]??'');
if(!process.argv[2])throw Error('fresh_output_required');await mkdir(output);
const childEnv={...process.env};for(const key of Object.keys(childEnv))if(/TOKEN|SECRET|PASSWORD|PRIVATE|MNEMONIC|WALLET|API_KEY|CLOUDFLARE|NODE_OPTIONS/i.test(key))delete childEnv[key];
const pings=[],alerts=[],children=[];let timer,lastPing=null;
const deadman=http.createServer((req,res)=>{const phase=req.url.includes('/fail?')?'fail':req.url.includes('/start?')?'start':'success';
  lastPing=Date.now();pings.push({phase,at:new Date().toISOString()});if(phase==='fail')alerts.push({reason:'primary_unavailable',at:new Date().toISOString()});res.end('OK');});
await new Promise(resolve=>deadman.listen(0,'127.0.0.1',resolve));
function child(mode,...args){const c=fork(join(root,'tests/monitor-native/process.mjs'),[mode,...args],{env:childEnv,silent:true,execArgv:[]});children.push(c);return c;}
const waitMessage=c=>new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('child_timeout')),20000);c.once('message',v=>{clearTimeout(timeout);resolve(v);});c.once('error',reject);});
const exited=c=>c.exitCode!==null?Promise.resolve(c.exitCode):new Promise(resolve=>c.once('exit',resolve));
try{
  const primary=child('primary'),{port}=await waitMessage(primary),deadmanPort=String(deadman.address().port);
  const first=child('observer',String(port),deadmanPort,join(output,'healthy.json'));assert.equal((await waitMessage(first)).state,'observed');await exited(first);
  const stopped=exited(primary);primary.kill('SIGKILL');await stopped;
  const second=child('observer',String(port),deadmanPort,join(output,'primary-stopped.json'));assert.equal((await waitMessage(second)).state,'unknown');await exited(second);
  assert.ok(alerts.some(a=>a.reason==='primary_unavailable'));
  // Both producer and observer processes are now gone. The third process's
  // wall-clock expiry still executes. Short fixture interval, NOT a 48h soak.
  await new Promise(resolve=>{timer=setInterval(()=>{if(lastPing!==null&&Date.now()-lastPing>=250){alerts.push({reason:'both_domains_silent',at:new Date().toISOString()});clearInterval(timer);resolve();}},25);});
  const r=JSON.parse(await readFile(join(output,'primary-stopped.json'),'utf8'));
  assert.equal(r.read_attempts,2);assert.equal(r.notification_delivered,null);
  const report={schema:'delta-independent-monitor-process-drill/v1',ok:true,completed_at:new Date().toISOString(),
    primary_os_process_killed:true,observer_ran_after_primary_exit:true,third_monitor_alive_after_both_exit:true,
    heartbeat_events:pings,local_receiver_alerts:alerts,external_requests:0,real_provider_receipt:null,real_notification_delivered:null,
    qualified_scope:'local loopback protocol fixtures with separate OS processes; not independent cloud infrastructure'};
  await writeFile(join(output,'result.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));
}finally{clearInterval(timer);for(const c of children)if(c.exitCode===null&&!c.killed)c.kill('SIGKILL');deadman.close();}
