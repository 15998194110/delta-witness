import {expect,it,vi} from 'vitest';
import {assessCronEvidence,runIndependentMonitor,pingIndependentMonitor} from '../scripts/independent-monitor.mjs';
const now=Date.parse('2026-11-04T01:01:00.000Z'),iso=n=>new Date(n).toISOString();
const policy={active_since:'2026-11-04T00:00:00.000Z',grace_ms:60000};
const ping='https://hc-ping.com/11111111-1111-4111-8111-111111111111';
const runId='22222222-2222-4222-8222-222222222222';
function row(task,time,n=0,outcome='success') {return {task_id:task,run_id:`33333333-3333-4333-8333-${String(n).padStart(12,'0')}`,
  scheduled_at:iso(time),started_at:iso(time),completed_at:outcome==='running'?null:iso(time+1000),lease_expires_at:iso(time+200000),outcome,last_success_at:null};}
function snapshot(empty=false){return {schema:'delta-cron-status/v1',ok:true,observed_at:iso(now),tasks:[
  {task_id:'cron3',runs:empty?[]:[row('cron3',now-60000,1)]},{task_id:'cron15',runs:empty?[]:[row('cron15',now-60000,2)]}]};}
it('alerts exactly after three missing due slots, not waiting for a fourth',()=>{
  const s=snapshot(true);const early=Date.parse('2026-11-04T00:04:00.000Z');s.observed_at=iso(early);
  expect(assessCronEvidence(s,policy,early).issues).toHaveLength(0);
  const threshold=Date.parse('2026-11-04T00:07:00.000Z');s.observed_at=iso(threshold);
  expect(assessCronEvidence(s,policy,threshold).issues.map(i=>i.code)).toEqual(['three_missed_slots']);
});
it('detects stopped primary for both tasks, with explicit missing slot evidence',()=>{
  const result=assessCronEvidence(snapshot(true),policy,now);expect(result.state).toBe('degraded');
  expect(result.issues.map(i=>i.task_id)).toEqual(['cron3','cron15']);expect(result.notification_delivered).toBeNull();
});
it('duplicate, expired run and degraded run are never erased by another successful run',()=>{
  const s=snapshot();s.tasks[0].runs.push(row('cron3',now-240000,3,'running'),row('cron3',now-60000,4,'degraded'));
  const codes=assessCronEvidence(s,policy,now).issues.map(i=>i.code);
  expect(codes).toContain('execution_lease_expired');expect(codes).toContain('duplicate_execution');expect(codes).toContain('execution_degraded');
});
it('missing, stale and malformed provider evidence stays unknown',()=>{
  for(const s of [null,{...snapshot(),observed_at:iso(now-61000)},{...snapshot(),tasks:[]}])expect(assessCronEvidence(s,policy,now).state).toBe('unknown');
});
it('primary completely unavailable still signals separate monitor and saves a bounded result',async()=>{
  const requests=[];const fetcher=async(url,init)=>{requests.push({url,init});if(url.startsWith('https://hc-ping.com/'))return new Response('OK');throw new Error('primary down');};
  const report=await runIndependentMonitor({token:'synthetic-local-admin',policy,pingUrl:ping,fetcher,now:()=>now,runId});
  expect(report.assessment.state).toBe('unknown');expect(report.read_attempts).toBe(2);expect(report.heartbeat_completion.state).toBe('accepted');
  expect(requests.at(-1).url).toContain('/fail?');expect(requests.filter(r=>r.init.method==='GET')).toHaveLength(4);
  expect(JSON.stringify(report)).not.toContain('synthetic-local-admin');expect(JSON.stringify(report)).not.toContain(ping);expect(report.notification_delivered).toBeNull();
});
it('temporary read outage recovers on bounded read without replaying work',async()=>{
  let reads=0;const fetcher=async url=>{if(url.startsWith('https://hc-ping.com/'))return new Response('OK');if(++reads===1)return new Response('',{status:503});return Response.json(snapshot());};
  const r=await runIndependentMonitor({token:'synthetic',policy,pingUrl:ping,fetcher,now:()=>now,runId});
  expect(r.assessment.state).toBe('observed');expect(r.read_attempts).toBe(2);expect(r.business_work_replayed).toBe(false);
});
it('HTTP200 rate limit or oversized response never means heartbeat accepted',async()=>{
  for(const body of ['OK (rate limited)','OK (not found)','x'.repeat(100)])expect((await pingIndependentMonitor(async()=>new Response(body),ping,runId,'success')).state).toBe('unconfirmed');
  const fake=vi.fn();expect((await pingIndependentMonitor(fake,'https://evil.test/',runId,'success')).state).toBe('not_configured');expect(fake).not.toHaveBeenCalled();
});
it('late response after observer deadline is canceled instead of beginning a hung body read',async()=>{
  vi.useFakeTimers();try{
    let release;const cancel=vi.fn();const pending=pingIndependentMonitor(()=>new Promise(r=>{release=r;}),ping,runId,'start');
    await vi.advanceTimersByTimeAsync(8001);expect((await pending).state).toBe('unconfirmed');
    release(new Response(new ReadableStream({cancel})));await vi.advanceTimersByTimeAsync(1);expect(cancel).toHaveBeenCalled();
  }finally{vi.useRealTimers();}
});
