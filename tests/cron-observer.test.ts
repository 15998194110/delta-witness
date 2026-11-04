import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {observeCronInvocation,cronObservationStatus,externalHeartbeat} from '../src/cron-observer';
import {MemoryBucket,orderRuntime} from './helpers/order-runtime';
import worker,{app} from '../src/index';
const event=Date.parse('2026-11-03T12:00:00.000Z');
const ping='https://hc-ping.com/11111111-1111-4111-8111-111111111111';
const id='22222222-2222-4222-8222-222222222222';
function fixture(){const bucket=new MemoryBucket(),env=orderRuntime(bucket);env.CRON_OBSERVER_ENABLED='true';return{bucket,env};}
beforeEach(()=>{vi.spyOn(console,'log').mockImplementation(()=>{});
  const original=crypto,subtle=new Proxy(original.subtle,{get(target,name){
    if(name==='timingSafeEqual')return (a:ArrayBuffer,b:ArrayBuffer)=>Buffer.from(a).equals(Buffer.from(b));
    const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;
  }});
  vi.stubGlobal('crypto',new Proxy(original,{get(target,name){if(name==='subtle')return subtle;const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}}));
});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('default off executes existing work without any storage or provider setup',async()=>{
  const {bucket,env}=fixture();delete env.CRON_OBSERVER_ENABLED;const work=vi.fn(async()=>[]),net=vi.fn();vi.stubGlobal('fetch',net);
  await observeCronInvocation(env,{cron:'*/15 * * * *',scheduledTime:event},work);
  expect(work).toHaveBeenCalledTimes(1);expect(bucket.values.size).toBe(0);expect(net).not.toHaveBeenCalled();
});
it('keeps failed control work distinct from a later successful invocation and reads after fresh wrapper',async()=>{
  const {env}=fixture();await expect(observeCronInvocation(env,{cron:'*/15 * * * *',scheduledTime:event},async()=>{throw new Error('fixture');})).rejects.toThrow('cron_control_degraded');
  await observeCronInvocation(env,{cron:'*/15 * * * *',scheduledTime:event+900000},async()=>[]);
  const status=await cronObservationStatus({...env});
  expect(status.ok).toBe(true);if(!('tasks'in status))throw Error('status');
  expect(status.tasks[1].runs.map(r=>r.outcome)).toEqual(['success','degraded']);
  expect(status.tasks[1].runs.every(r=>!!r.started_at&&!!r.scheduled_at&&!!r.completed_at)).toBe(true);
});
it('distinct triggers for the same slot remain detectable without becoming financial dedupe authority',async()=>{
  const {env}=fixture();for(let n=0;n<2;n++)await observeCronInvocation(env,{cron:'*/3 * * * *',scheduledTime:event},async()=>[]);
  const status=await cronObservationStatus(env);if(!('tasks'in status))throw Error('status');
  expect(status.tasks[0].runs).toHaveLength(2);expect(new Set(status.tasks[0].runs.map(r=>r.run_id)).size).toBe(2);
});
it('database/storage outage does not suppress original business work and does not create a success observation',async()=>{
  const {env,bucket}=fixture();vi.spyOn(bucket,'put').mockRejectedValueOnce(new Error('unavailable'));
  const work=vi.fn(async()=>[]);await expect(observeCronInvocation(env,{cron:'*/15 * * * *',scheduledTime:event},work)).rejects.toThrow('cron_control_degraded');
  expect(work).toHaveBeenCalledTimes(1);const status=await cronObservationStatus(env);if(!('tasks'in status))throw Error('status');
  expect(status.tasks[1].runs[0].outcome).toBe('degraded');
  expect(status.tasks[1].runs[0].last_success_at).toBeNull();
  await observeCronInvocation(env,{cron:'*/15 * * * *',scheduledTime:event+900000},async()=>[]);
  const recovered=await cronObservationStatus(env);if(!('tasks'in recovered))throw Error('status');
  expect(recovered.tasks[1].runs.map(r=>r.outcome)).toEqual(['success','degraded']);
});
it('a future controller timestamp cannot poison durable success evidence or suppress paid work',async()=>{
  const {env,bucket}=fixture();const work=vi.fn(async()=>[]);
  await expect(observeCronInvocation(env,{cron:'*/15 * * * *',scheduledTime:Date.now()+600000},work)).rejects.toThrow('cron_control_degraded');
  expect(work).toHaveBeenCalledTimes(1);expect(bucket.values.size).toBe(0);
});
it('actual scheduled consumer is independently gated and configuration failure is retained as degraded',async()=>{
  const {env,bucket}=fixture();Object.assign(env,{OPERATIONS_CLOUD_ENABLED:'true',OPERATIONS_ALERT_OUTBOX_ENABLED:'true',OPERATIONS_ALERT_DELIVERY_ENABLED:'true'});
  Object.assign(env.PROOFS,{list:async()=>({objects:[],truncated:false})});const net=vi.fn();vi.stubGlobal('fetch',net);
  const pending:Promise<unknown>[]=[];
  await worker.scheduled({cron:'*/15 * * * *',scheduledTime:event} as ScheduledController,env,{waitUntil(p:Promise<unknown>){pending.push(p);}} as ExecutionContext);
  await expect(Promise.all(pending)).rejects.toThrow('cron_control_degraded');
  const status=await cronObservationStatus(env);if(!('tasks'in status))throw Error('status');
  expect(status.tasks[1].runs[0].outcome).toBe('degraded');expect(net).not.toHaveBeenCalled();expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
});
it.each(['inventory','checkpoint'])('a failed paid-debt %s cannot be hidden by healthy independent Cron lanes',async fault=>{
  const {env,bucket}=fixture();
  Object.assign(env,{OPERATIONS_CLOUD_ENABLED:'true',OPERATIONS_ALERT_OUTBOX_ENABLED:'true'});
  Object.assign(env.PROOFS,{list:async()=>{if(fault==='inventory')throw new Error('synthetic inventory outage');return {objects:[],truncated:false};}});
  const put=bucket.put.bind(bucket);
  vi.spyOn(bucket,'put').mockImplementation(async(key,value,options)=>{
    if(fault==='checkpoint'&&key==='operations/alerts/sources/paid/cursor.json')throw new Error('synthetic cursor outage');
    return put(key,value,options);
  });
  const net=vi.fn();vi.stubGlobal('fetch',net);const pending:Promise<unknown>[]=[];
  await worker.scheduled({cron:'*/15 * * * *',scheduledTime:event} as ScheduledController,env,{waitUntil(p:Promise<unknown>){pending.push(p);}} as ExecutionContext);
  await expect(Promise.all(pending)).rejects.toThrow('cron_control_degraded');
  const status=await cronObservationStatus(env);if(!('tasks'in status))throw Error('status');
  expect(status.tasks[1].runs[0]).toMatchObject({outcome:'degraded',last_success_at:null});
  expect(bucket.values.has('operations/alerts/sources/paid/cursor.json')).toBe(false);
  expect(net).not.toHaveBeenCalled();expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
});
it('heartbeat failure cannot report recipient delivery or leak bearer URL in log',async()=>{
  const {env}=fixture();Object.assign(env,{CRON_EXTERNAL_HEARTBEAT_ENABLED:'true',CRON15_HEALTHCHECKS_PING_URL:ping});
  const net=vi.fn(async()=>new Response('OK (rate limited)',{status:200}));vi.stubGlobal('fetch',net);
  await expect(observeCronInvocation(env,{cron:'*/15 * * * *',scheduledTime:event},async()=>[])).rejects.toThrow('cron_control_degraded');
  expect(net).toHaveBeenCalledTimes(2);expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(ping);
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0])).notification_delivered).toBeNull();
  const status=await cronObservationStatus(env);if(!('tasks'in status))throw Error('status');
  expect(status.tasks[1].runs[0]).toMatchObject({outcome:'degraded',last_success_at:null});
});
it('only exact Healthchecks endpoint and OK response qualify as accepted, not delivered',async()=>{
  const net=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>new Response('OK'));expect(await externalHeartbeat(ping,id,'fail',net)).toEqual({state:'accepted',notification_delivered:null});
  expect(net.mock.calls[0][0]).toBe(`${ping}/fail?rid=${id}`);
  for(const url of ['http://127.0.0.1/','https://hc-ping.com.evil/x',`${ping}?create=1`])expect((await externalHeartbeat(url,id,'success',net)).state).toBe('not_configured');
  expect(net).toHaveBeenCalledTimes(1);
});
it('stalled heartbeat body is canceled at its deadline rather than consuming the handler forever',async()=>{
  vi.useFakeTimers();const cancel=vi.fn();const stream=new ReadableStream<Uint8Array>({cancel});
  const result=externalHeartbeat(ping,id,'start',vi.fn(async()=>new Response(stream)));
  await vi.advanceTimersByTimeAsync(4001);expect((await result).state).toBe('unconfirmed');expect(cancel).toHaveBeenCalled();
});
it('a fetch ignoring cancellation cannot start reading its late body after the deadline',async()=>{
  vi.useFakeTimers();let release!:(response:Response)=>void;const cancel=vi.fn();
  const pending=externalHeartbeat(ping,id,'start',vi.fn(()=>new Promise<Response>(r=>{release=r;})));
  await vi.advanceTimersByTimeAsync(4001);expect((await pending).state).toBe('unconfirmed');
  release(new Response(new ReadableStream<Uint8Array>({cancel})));await vi.advanceTimersByTimeAsync(1);expect(cancel).toHaveBeenCalled();
});
it('private cron status requires existing operations authorization and rejects query credentials',async()=>{
  const {env}=fixture();Object.assign(env,{OPERATIONS_CLOUD_ENABLED:'true',OPERATIONS_ADMIN_SECRET:'synthetic-admin'});
  expect((await app.fetch(new Request('https://delta.test/internal/operations/cron'),env)).status).toBe(401);
  const r=await app.fetch(new Request('https://delta.test/internal/operations/cron',{headers:{authorization:'Bearer synthetic-admin'}}),env);
  expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toContain('no-store');
});
