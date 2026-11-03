import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {app} from '../src/index';
import {MemoryBucket,orderRuntime} from './helpers/order-runtime';
import {operatingStatus,recordOperatingPulse,recordWatchdogObservation,persistOperatingAlertCandidates} from '../src/operating-control';
import {operatingDashboard} from '../src/operating-dashboard';
import {createHash} from 'node:crypto';
const now=Date.parse('2026-11-03T12:00:00.000Z'),release='a'.repeat(40),credential='fixture-operating-credential';
function fixture(){const bucket=new MemoryBucket(),env=orderRuntime(bucket);Object.assign(env,{OPERATIONS_CLOUD_ENABLED:'true',OPERATIONS_ADMIN_SECRET:credential,OPERATIONS_RELEASE_SHA:release});return{env,bucket};}
function pulse(id='100',outcome='success',offset=0){return{schema:'delta-pulse-status/v1',observed_at:new Date(now+offset).toISOString(),started_at:new Date(now+offset-5000).toISOString(),completed_at:new Date(now+offset-1000).toISOString(),duration_ms:4000,outcome,critical_ok:outcome==='success',run:{id,source_sha:release},reporting:{phase:'final'},core:{purchase_path:{state:'verified'}},treasury:{state:'verified_declared_interval',start_block:100,through_block:200},scanners:{one:{state:'checked'}}};}
const request=(path:string,body?:unknown,headers:Record<string,string>={})=>new Request(`https://delta.test/internal/operations/${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${credential}`,...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(now);const original=crypto,subtle=new Proxy(original.subtle,{get(target,name){if(name==='timingSafeEqual')return(a:ArrayBuffer,b:ArrayBuffer)=>Buffer.from(a).equals(Buffer.from(b));const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}});
  vi.stubGlobal('crypto',new Proxy(original,{get(target,name){if(name==='subtle')return subtle;const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}}));
});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('operations endpoints stay private, disabled by default and independent of payment',async()=>{
  const {env,bucket}=fixture();delete env.OPERATIONS_CLOUD_ENABLED;
  expect((await app.fetch(request('status'),env)).status).toBe(503);env.OPERATIONS_CLOUD_ENABLED='true';
  expect((await app.fetch(request('status',undefined,{authorization:'Bearer incorrect'}),env)).status).toBe(401);
  expect((await app.fetch(request('status',undefined,{origin:'https://other.test'}),env)).status).toBe(400);
  expect((await app.fetch(request('status',undefined,{'payment-signature':'fixture'}),env)).status).toBe(400);
  expect(bucket.values.size).toBe(0);expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
});
it('actual app intake, immutable receipt, private report and HTML use the same original observation',async()=>{
  const {env,bucket}=fixture(),input=pulse();Object.assign(input,{unexpected_fixture_text:'do-not-persist'});
  expect((await app.fetch(request('pulse',input),env)).status).toBe(200);
  const receipt=await (await app.fetch(request('pulse/100'),env)).json() as any;
  expect(receipt.recorded).toBe(true);expect(receipt.latest_projection_at_or_after_run).toBe(true);
  expect(receipt.source_payload_hash).toBe(`sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`);
  const status=await app.fetch(request('status'),env),body=await status.json() as any;
  expect(status.headers.get('cache-control')).toBe('private, no-store');expect(body.report.business.metrics.customer_revenue_usdc.value).toBeNull();
  expect(body.report.business.metrics.variable_cost_usdc.value).toBeNull();expect(body.report.schedulers[0].run.value.id).toBe('100');
  expect([...bucket.values.values()].some(x=>x.text.includes('do-not-persist'))).toBe(false);
  const html=await app.fetch(request('dashboard'),env);expect(html.headers.get('content-security-policy')).toContain("default-src 'none'");expect(await html.text()).toContain('unknown');
});
it('later failures and old delayed results cannot regress latest or erase last success',async()=>{
  const {env}=fixture();await recordOperatingPulse(env,pulse());vi.setSystemTime(now+10_000);await recordOperatingPulse(env,pulse('101','failed',10_000));
  await recordOperatingPulse(env,pulse('99','success',-10_000));const status=await operatingStatus(env);
  expect(status.cloud.pulse_observation?.run_id).toBe('101');expect(status.report.schedulers[0].last_success.value).toBe(pulse().completed_at);
});
it('same run with different content and source drift preserve original bytes',async()=>{
  const {env,bucket}=fixture();await recordOperatingPulse(env,pulse());const before=new Map([...bucket.values].map(([k,v])=>[k,v.text]));
  await expect(recordOperatingPulse(env,pulse('100','failed'))).rejects.toThrow();
  await expect(recordOperatingPulse(env,{...pulse('101'),run:{id:'101',source_sha:'b'.repeat(40)}})).rejects.toThrow();
  expect(new Map([...bucket.values].map(([k,v])=>[k,v.text]))).toEqual(before);
});
it('fresh watchdog provider facts and stale run can signal a gap without inventing next run or income',async()=>{
  const {env}=fixture();await recordOperatingPulse(env,pulse('99','success',-4*3600_000));await recordWatchdogObservation(env,{outcome:'checked',reason:'fixture_observation',provider_scheduler_enabled:true});
  const snapshot=await operatingStatus(env);expect(snapshot.report.alerts.some(x=>x.code==='scheduler_stale')).toBe(true);expect(snapshot.report.schedulers[0].next_run.value).toBeNull();expect(snapshot.cloud.failure_rate).toBeNull();
});
it('dashboard escapes evidence and visibly keeps missing state distinct',async()=>{
  const {env}=fixture(),snapshot=await operatingStatus(env);snapshot.report.limitations.push('<img src=x onerror=fixture>');
  const html=operatingDashboard(snapshot.report);expect(html).toContain('unknown');expect(html).not.toContain('<script');expect(html).not.toContain('<img');expect(html).toContain('&lt;img');expect(html).toContain('总数未知');
});
it('protected owner-alert intake persists a blocked intent and only an exact explicit ACK suppresses it',async()=>{
  const {env,bucket}=fixture();env.OPERATIONS_ALERT_OUTBOX_ENABLED='true';
  const e={dedupe_key:'delta:paid_undelivered:order-1:episode-1',code:'paid_undelivered',subject:'order-1',severity:'SEV1',stage:'initial',first_seen_at:new Date(now-600000).toISOString(),evidence_ref:'fixture-original-order'};
  expect((await app.fetch(request('alerts/observe',e,{origin:'https://other.test'}),env)).status).toBe(400);
  expect((await (await app.fetch(request('alerts/observe',e),env)).json() as any).state).toBe('blocked');
  const read=await app.fetch(request('alerts/read',{dedupe_key:e.dedupe_key}),env),row=(await read.json() as any).alert;
  expect(row).toMatchObject({state:'blocked',receipt:null,acknowledgment:null});expect(read.headers.get('cache-control')).toBe('private, no-store');
  const ack={notification_id:row.notification_id,payload_hash:row.payload_hash,actor_ref:'owner-approved',evidence_ref:'explicit-ack',observed_at:new Date(now).toISOString()};
  expect((await (await app.fetch(request('alerts/acknowledge',{dedupe_key:e.dedupe_key,acknowledgment:ack}),env)).json() as any).state).toBe('acknowledged');
  expect((await (await app.fetch(request('alerts/observe',e),env)).json() as any).state).toBe('suppressed');
  expect([...bucket.values.keys()].every(k=>k.startsWith('operations/alerts/'))).toBe(true);expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
});
it('actual scheduler-gap evidence creates a durable blocked alert without inventing provider permission or delivery',async()=>{
  const {env,bucket}=fixture();env.OPERATIONS_ALERT_OUTBOX_ENABLED='true';
  await recordOperatingPulse(env,pulse('99','success',-4*3600000));await recordWatchdogObservation(env,{outcome:'checked',reason:'fixture_gap',provider_scheduler_enabled:true});
  expect(await persistOperatingAlertCandidates(env)).toMatchObject({state:'observations_checked',selected:1,notification_delivered:null});
  const keys=[...bucket.values.keys()].filter(k=>k.startsWith('operations/alerts/'));expect(keys).toHaveLength(1);
  expect(JSON.parse(bucket.values.get(keys[0])!.text)).toMatchObject({state:'blocked',destination:null,receipt:null});
  const before=bucket.values.get(keys[0])!.text;await persistOperatingAlertCandidates(env);expect(bucket.values.get(keys[0])!.text).toBe(before);
});
