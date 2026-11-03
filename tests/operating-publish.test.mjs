const {test}=process.env.VITEST?await import('vitest'):await import('node:test');
import assert from 'node:assert/strict';
import {publishOperatingPulse} from '../scripts/publish-operating-pulse.mjs';
import {pulseGate} from '../scripts/pulse-status.mjs';
import {runTreasuryCli} from '../scripts/reconcile-treasury.mjs';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const input={schema:'delta-pulse-status/v1',observed_at:'2026-11-03T00:00:00.000Z',outcome:'success',run:{id:'111',source_sha:'a'.repeat(40)},reporting:{phase:'final'}};
const receipt={ok:true,recorded:true,run_id:'111',source_sha:'a'.repeat(40),source_payload_hash:`sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`,observed_at:input.observed_at,latest_projection_at_or_after_run:true,last_success_at_or_after_run:true};
test('disabled cloud publication does not call a provider or require credentials',async()=>{
  let calls=0;assert.equal((await publishOperatingPulse(null,{fetchImpl:()=>{calls++;}})).state,'disabled');assert.equal(calls,0);
});
test('lost original publication ACK is resolved only by matching immutable readback',async()=>{
  const requests=[];const fetchImpl=async(url,init)=>{requests.push({url,method:init.method??'GET'});assert.equal(init.redirect,'error');
    if(init.method==='POST')throw new Error('fixture_lost_ack');return Response.json(receipt);};
  const result=await publishOperatingPulse(input,{enabled:true,secret:'fixture-credential',fetchImpl});
  assert.equal(result.stored,true);assert.equal(result.notification_delivered,null);assert.equal(requests.filter(x=>x.method==='POST').length,1);
  assert.deepEqual(requests.map(x=>x.url),['https://delta-witness-api.ruphussten.workers.dev/internal/operations/pulse','https://delta-witness-api.ruphussten.workers.dev/internal/operations/pulse/111']);
});
test('HTTP success cannot hide missing source binding or a missing latest projection',async()=>{
  for(const answer of[{...receipt,source_sha:'b'.repeat(40)},{...receipt,source_payload_hash:`sha256:${'f'.repeat(64)}`},{...receipt,recorded:false},{...receipt,latest_projection_at_or_after_run:false},{...receipt,last_success_at_or_after_run:false}]){
    let posts=0;await assert.rejects(publishOperatingPulse(input,{enabled:true,secret:'fixture-credential',fetchImpl:async(_,init)=>{
      if(init.method==='POST'){posts++;return Response.json({ok:true});}return Response.json(answer);
    }}),/operating_readback_unconfirmed/);assert.equal(posts,1);
  }
});
test('cloud-enabled Pulse gate requires actual publication outcome, default remains compatible',()=>{
  const report={schema:'delta-pulse-status/v1',critical_ok:true,reporting:{phase:'final',canonical_artifact:'success'}};
  const outcomes=Object.fromEntries(['report_status','report_final','canonical_artifact','status_artifact'].map(k=>[k,{outcome:'success'}]));
  assert.equal(pulseGate(report,outcomes),true);assert.equal(pulseGate(report,outcomes,true),false);
  outcomes.operating_publish={outcome:'failure'};assert.equal(pulseGate(report,outcomes,true),false);outcomes.operating_publish.outcome='success';assert.equal(pulseGate(report,outcomes,true),true);
});
test('remote custody never combines local or caller-supplied scan origins',async()=>{
  for(const env of[{DELTA_TREASURY_STATE_DIRECTORY:'fixture-only'},{DELTA_TREASURY_START_BLOCK:'100'},{DELTA_TREASURY_CHECKPOINT_BLOCK:'100'}]){
    let called=false;await assert.rejects(runTreasuryCli({...env,DELTA_TREASURY_STATE_MODE:'remote'}, {remoteCheckpointStore:async()=>{called=true;}}),e=>e.category==='ambiguous_checkpoint_authority');assert.equal(called,false);
  }
  await assert.rejects(runTreasuryCli({DELTA_TREASURY_STATE_MODE:'unsupported'}),e=>e.category==='invalid_checkpoint_authority');
});
test('canonical workflow binds watchdog release before execution and retains cloud readback artifact',async()=>{
  const workflow=await readFile(new URL('../.github/workflows/discovery-pulse.yml',import.meta.url),'utf8');
  assert.match(workflow,/delta_watchdog_release == github.sha/);assert.match(workflow,/DELTA Pulse watchdog \{0\}/);
  assert.match(workflow,/DELTA_TREASURY_STATE_MODE: \$\{\{ vars.DELTA_TREASURY_STATE_MODE \}\}/);
  assert.match(workflow,/id: operating_publish[\s\S]*?if: always\(\)/);
  assert.match(workflow,/publish-operating-pulse.mjs \/tmp\/delta-pulse-status-final.json \/tmp\/delta-pulse-status-operating-persistence.json/);
  assert.equal((workflow.match(/group: delta-canonical-revenue-pulse/g)||[]).length,1);
});
