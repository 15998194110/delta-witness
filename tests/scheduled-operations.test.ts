import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { app } from '../src/index';
import { parseWatchRegistration, registerWatch, runDueWatches, WatchRunError } from '../src/watch';
import { runScheduledOperations, scheduledStatus, SCHEDULED_LANE_TIMEOUT_MS, SCHEDULED_OBSERVATION_TIMEOUT_MS, type ScheduledWork } from '../src/scheduled-operations';
import { MemoryBucket, orderRuntime } from './helpers/order-runtime';

const noon = Date.parse('2026-11-03T12:00:00.000Z');
const daily = Date.parse('2026-11-03T03:00:00.000Z');
class Bucket extends MemoryBucket {
  async list(options?: R2ListOptions) { return { objects: [...this.values.keys()].filter(key => key.startsWith(options?.prefix ?? '')).map(key => ({key})), truncated: false }; }
}
function fixture(enabled = false) {
  const bucket = new Bucket(), env = orderRuntime(bucket);
  env.SCHEDULED_OPERATIONS_OBSERVABILITY_ENABLED = enabled ? 'true' : undefined;
  env.INDEXNOW_ADMIN_SECRET = 'fixture-admin-credential';
  return { bucket, env };
}
function works() {
  return { meshkore: vi.fn<ScheduledWork>(async()=>({outcome:'success'})), watch: vi.fn<ScheduledWork>(async()=>({outcome:'success'})), indexnow: vi.fn<ScheduledWork>(async()=>({outcome:'success'})) };
}
async function invoke(env: ReturnType<typeof fixture>['env'], cron = '*/3 * * * *', time = noon) {
  const pending: Promise<unknown>[] = [];
  await worker.scheduled({ cron, scheduledTime: time } as ScheduledController, env, {waitUntil(value: Promise<unknown>) {pending.push(value);}} as ExecutionContext);
  await Promise.all(pending);
}
function latest(bucket: Bucket, task: string) { return JSON.parse(bucket.values.get(`operations/scheduled/latest/${task}.json`)!.text); }
function statusRequest(extra = '', headers: Record<string,string> = {'authorization':'Bearer fixture-admin-credential'}) {
  return new Request(`https://delta.test/internal/scheduled/status${extra}`,{headers});
}
async function dueWatch(options: {webhookStatus?:number; expected?:Record<string,unknown>}={}) {
  const state=fixture(true);
  const network=vi.fn(async(input:string|URL|Request)=>{
    const url=new URL(String(input));
    if(url.hostname==='cloudflare-dns.com')return Response.json(url.searchParams.get('type')==='A'?{Status:0,Answer:[{type:1,data:'93.184.216.34'}]}:{Status:0,Answer:[]});
    if(url.hostname==='example.com')return new Response('',{status:200});
    if(url.hostname==='webhook.test')return new Response(null,{status:options.webhookStatus??204});
    throw new Error('unexpected_fixture_network');
  });vi.stubGlobal('fetch',network);
  const request=await parseWatchRegistration({url:'https://example.com/',checks:1,interval_seconds:900,
    ...(options.webhookStatus===undefined?{}:{webhook_url:'https://webhook.test/events'}),...(options.expected?{expected:options.expected}:{})});
  const created=await registerWatch({env:state.env,request,requestHash:'sha256:cron-fixture',fingerprint:'sha256:cron-watch',partner:'fixture',channel:'fixture',grossPaidUsd:1});
  const key=`watches/${created.body.watch_id}.json`,record=JSON.parse(state.bucket.values.get(key)!.text);
  await state.bucket.put(key,JSON.stringify({...record,next_check_at:'2020-01-01T00:00:00.000Z'}));
  return {...state,key,network,record:()=>JSON.parse(state.bucket.values.get(key)!.text)};
}
beforeEach(()=>{
  vi.spyOn(console,'log').mockImplementation(()=>{});
  const original = crypto;
  const subtle = new Proxy(original.subtle, { get(target, name) {
    if(name==='timingSafeEqual') return (a:ArrayBuffer,b:ArrayBuffer)=>Buffer.from(a).equals(Buffer.from(b));
    const value = Reflect.get(target,name,target); return typeof value==='function'?value.bind(target):value;
  }});
  vi.stubGlobal('crypto',new Proxy(original,{get(target,name){if(name==='subtle')return subtle;const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}}));
});
afterEach(()=>{ vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks(); });

describe('existing Cron lane observation without new business authority',()=>{
  it.each([
    ['*/3 * * * *',noon,['meshkore']], ['*/15 * * * *',noon,['watch']], ['*/15 * * * *',daily,['watch','indexnow']], ['* * * * *',noon,[]],
  ] as const)('dispatches only the existing exact trigger %s and UTC slot',async(cron,scheduledTime,expected)=>{
    const {bucket,env}=fixture(),work=works(); const results=await runScheduledOperations(env,{cron,scheduledTime},work);
    expect(results.map(row=>row.task_id)).toEqual(expected);
    for(const task of ['meshkore','watch','indexnow'] as const)expect(work[task]).toHaveBeenCalledTimes(expected.includes(task as never)?1:0);
    expect([...bucket.values.keys()]).toEqual([]);expect(results.every(row=>row.observation==='disabled')).toBe(true);
  });
  it('missing MeshKore credential is explicitly skipped and never marked last success',async()=>{
    const {bucket,env}=fixture(true),network=vi.fn();vi.stubGlobal('fetch',network);
    await invoke(env);expect(network).not.toHaveBeenCalled();
    expect(latest(bucket,'meshkore')).toMatchObject({latest:{outcome:'skipped',reason:'missing_configuration'},last_success:null});
    expect([...bucket.values.keys()].every(key=>key.startsWith('operations/scheduled/'))).toBe(true);
  });
  it('actual MeshKore 503 becomes a degraded invocation without exposing credentials or provider body',async()=>{
    const {bucket,env}=fixture(true);env.MESHKORE_API_KEY='fixture-mesh-secret';
    const network=vi.fn(async()=>new Response('fixture-provider-secret',{status:503}));vi.stubGlobal('fetch',network);
    await expect(invoke(env)).rejects.toThrow('scheduled_operations_degraded');
    expect(network).toHaveBeenCalledTimes(1);expect(latest(bucket,'meshkore')).toMatchObject({latest:{outcome:'degraded',reason:'upstream_rejected',http_status:503},last_success:null});
    expect(JSON.stringify([...bucket.values])).not.toContain('fixture-mesh-secret');expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('fixture-provider-secret');
  });
  it('actual MeshKore success executes only token and existing-agent PATCH once',async()=>{
    const {bucket,env}=fixture(true);env.MESHKORE_API_KEY='fixture-mesh-secret';
    const network=vi.fn(async(url:string,init:RequestInit)=>url.endsWith('/token')?Response.json({token:'fixture-issued-token'}):new Response(null,{status:204}));vi.stubGlobal('fetch',network);
    await invoke(env);expect(network.mock.calls.map(([url,init])=>[url,init.method])).toEqual([
      ['https://api.meshkore.com/v1/agents/token','POST'],['https://api.meshkore.com/v1/agents/me','PATCH'],
    ]);expect(latest(bucket,'meshkore').last_success.outcome).toBe('success');
    expect(JSON.stringify([...bucket.values])).not.toContain('fixture-issued-token');
  });
  it.each(['invalid-json','oversized','missing-token'])('actual MeshKore %s response never reaches PATCH',async kind=>{
    const {bucket,env}=fixture(true);env.MESHKORE_API_KEY='fixture-key';
    const network=vi.fn(async()=>kind==='invalid-json'?new Response('{'):kind==='oversized'?new Response(' '.repeat(16385)):Response.json({}));vi.stubGlobal('fetch',network);
    await expect(invoke(env)).rejects.toThrow('scheduled_operations_degraded');
    expect(network).toHaveBeenCalledTimes(1);expect(latest(bucket,'meshkore').latest).toMatchObject({outcome:'degraded',reason:'upstream_invalid_response'});
  });
  it.each(['fetch','body'])('MeshKore total deadline covers stalled %s and stops a late PATCH',async stage=>{
    vi.useFakeTimers();vi.setSystemTime(noon);const {env}=fixture();env.MESHKORE_API_KEY='fixture-key';
    let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});const cancel=vi.fn();
    const network=vi.fn(async()=>{entered();if(stage==='fetch')await new Promise<void>(resolve=>{release=resolve;});
      return stage==='body'?new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel})):Response.json({token:'fixture-token'});});vi.stubGlobal('fetch',network);
    const pending=invoke(env).then(()=>null,error=>error);await ready;await vi.advanceTimersByTimeAsync(SCHEDULED_LANE_TIMEOUT_MS.meshkore+1);
    expect((await pending)?.message).toBe('scheduled_operations_degraded');release?.();await vi.advanceTimersByTimeAsync(1);
    expect(network).toHaveBeenCalledTimes(1);if(stage==='body')expect(cancel).toHaveBeenCalled();
    const rows=vi.mocked(console.log).mock.calls.map(([line])=>JSON.parse(line));expect(rows.find(row=>row.task_id==='meshkore')).toMatchObject({outcome:'timeout',reason:'lane_deadline'});
  });
  it('IndexNow failure cannot block actual Watch scans and separate lane outcomes persist',async()=>{
    const {bucket,env}=fixture(true);env.INDEXNOW_KEY='delta-witness-2026-8f0c5a3d6e7b91ac';
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('fixture-secret-body',{status:502})));
    await expect(invoke(env,'*/15 * * * *',daily)).rejects.toThrow('scheduled_operations_degraded');
    expect(latest(bucket,'indexnow').latest).toMatchObject({outcome:'degraded',http_status:502});
    expect(latest(bucket,'watch')).toMatchObject({latest:{outcome:'success',counts:{checks_selected:0}},last_success:{outcome:'success'}});
    expect(bucket.values.has('ops/watch-list-cursor.json')).toBe(true);expect(bucket.values.has('ops/watch-notification-list-cursor.json')).toBe(true);
    expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it('rejected Watch items are counted without removing original records or consuming work again',async()=>{
    const {bucket,env}=fixture(true);await bucket.put('watches/fixture-malformed.json','{');const original=bucket.values.get('watches/fixture-malformed.json');
    await expect(invoke(env,'*/15 * * * *')).rejects.toThrow('scheduled_operations_degraded');
    expect(latest(bucket,'watch').latest).toMatchObject({outcome:'degraded',reason:'watch_items_rejected',counts:{checks_selected:1,checks_settled:0,checks_rejected:1}});
    expect(bucket.values.get('watches/fixture-malformed.json')).toEqual(original);expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it('Watch inventory rejection keeps the original caller error and returns its summary on the error',async()=>{
    const {bucket,env}=fixture();bucket.list=async()=>{throw new Error('fixture-inventory-secret');};
    let caught:unknown;try{await runDueWatches(env);}catch(error){caught=error;}
    expect(caught).toBeInstanceOf(WatchRunError);expect((caught as WatchRunError).message).toBe('fixture-inventory-secret');expect((caught as WatchRunError).summary.inventory_failures).toBeGreaterThan(0);
    await expect(invoke(env,'*/15 * * * *')).rejects.toThrow('scheduled_operations_degraded');
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('fixture-inventory-secret');
  });
  it('handled capture failure is degraded without another capture, quota debit, or false last success',async()=>{
    const state=await dueWatch();vi.mocked(state.env.BROWSER.quickAction).mockRejectedValue(new Error('fixture-capture-failed'));
    await expect(invoke(state.env,'*/15 * * * *')).rejects.toThrow('scheduled_operations_degraded');
    expect(latest(state.bucket,'watch')).toMatchObject({latest:{outcome:'degraded',counts:{checks_failed:1,checks_rejected:0}},last_success:null});
    expect(state.record()).toMatchObject({checks_attempted:1,checks_remaining:0,last_result:{ok:false}});
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });
  it('handled webhook retry remains degraded and does not redeliver before its original backoff',async()=>{
    const state=await dueWatch({webhookStatus:503});
    await expect(invoke(state.env,'*/15 * * * *')).rejects.toThrow('scheduled_operations_degraded');
    expect(latest(state.bucket,'watch')).toMatchObject({latest:{outcome:'degraded',counts:{notifications_failed:1}},last_success:null});
    const event=[...state.bucket.values.entries()].find(([key])=>key.startsWith('watch-notifications/'))!;
    expect(JSON.parse(event[1].text)).toMatchObject({state:'retry_wait',attempts:1});
    await expect(invoke(state.env,'*/15 * * * *')).rejects.toThrow('scheduled_operations_degraded');
    expect(latest(state.bucket,'watch').latest.counts.notifications_deferred).toBeGreaterThan(0);
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
    expect(state.network.mock.calls.filter(([url])=>new URL(String(url)).hostname==='webhook.test')).toHaveLength(1);
    expect(state.bucket.values.get(event[0])).toEqual(event[1]);
  });
  it('successful negative Guard observation is successful execution rather than a capture failure',async()=>{
    const state=await dueWatch({expected:{contains:['missing-condition']}});
    await invoke(state.env,'*/15 * * * *');
    expect(state.record()).toMatchObject({last_result:{ok:true,safe:false}});
    expect(latest(state.bucket,'watch')).toMatchObject({latest:{outcome:'success',counts:{checks_failed:0}},last_success:{outcome:'success'}});
    expect(state.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });
  it('unknown expired check lease is observed as deferred without new capture or quota mutation',async()=>{
    const state=await dueWatch();const before=state.record();await state.bucket.put(state.key,JSON.stringify({...before,lease_until:'2020-01-01T00:00:00.000Z'}));
    await expect(invoke(state.env,'*/15 * * * *')).rejects.toThrow('scheduled_operations_degraded');
    expect(latest(state.bucket,'watch').latest).toMatchObject({outcome:'degraded',counts:{checks_deferred:1}});
    expect(state.record()).toMatchObject({state:'recovery_required',checks_attempted:before.checks_attempted,checks_remaining:before.checks_remaining});
    expect(state.env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it('a stalled optional lane finishes by its deadline while the other lane succeeds',async()=>{
    vi.useFakeTimers();vi.setSystemTime(daily);const {env}=fixture(),work=works();work.indexnow.mockImplementation(async()=>new Promise(()=>{}));
    const pending=runScheduledOperations(env,{cron:'*/15 * * * *',scheduledTime:daily},work);
    await vi.advanceTimersByTimeAsync(SCHEDULED_LANE_TIMEOUT_MS.indexnow+1);const rows=await pending;
    expect(rows.map(row=>[row.task_id,row.outcome])).toEqual([['watch','success'],['indexnow','timeout']]);expect(work.indexnow).toHaveBeenCalledTimes(1);
  });
  it('late observation write cannot run a late latest update or block the existing work',async()=>{
    vi.useFakeTimers();vi.setSystemTime(noon);const {bucket,env}=fixture(true),work=works(),put=bucket.put.bind(bucket);
    let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});let held=false;
    bucket.put=async(k,v,o)=>{if(k.endsWith('/started.json')&&!held){held=true;entered();await new Promise<void>(resolve=>{release=resolve;});}return put(k,v,o);};
    const pending=runScheduledOperations(env,{cron:'*/3 * * * *',scheduledTime:noon},work);await ready;
    await vi.advanceTimersByTimeAsync(SCHEDULED_OBSERVATION_TIMEOUT_MS+1);const results=await pending;
    expect(work.meshkore).toHaveBeenCalledTimes(1);expect(results[0]).toMatchObject({outcome:'success',observation:'unconfirmed'});
    const before=bucket.values.get('operations/scheduled/latest/meshkore.json');release();await vi.advanceTimersByTimeAsync(1);
    expect(bucket.values.get('operations/scheduled/latest/meshkore.json')).toEqual(before);expect(latest(bucket,'meshkore').latest.outcome).toBe('success');
  });
  it('late older completion cannot replace a newer run or newer last success',async()=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(noon);const {bucket,env}=fixture(true),older=works(),newer=works();
    let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});older.meshkore.mockImplementation(async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});return {outcome:'success'};});
    const pending=runScheduledOperations(env,{cron:'*/3 * * * *',scheduledTime:noon},older);await ready;
    vi.setSystemTime(noon+180_000);const next=await runScheduledOperations(env,{cron:'*/3 * * * *',scheduledTime:noon+180_000},newer);
    release();await pending;const stored=latest(bucket,'meshkore');expect(stored.latest.run_id).toBe(next[0].run_id);expect(stored.last_success.run_id).toBe(next[0].run_id);
    expect([...bucket.values.keys()].filter(key=>key.endsWith('/completed.json'))).toHaveLength(2);
  });
  it('latest CAS conflicts are observed without retrying work or the observation write',async()=>{
    const {bucket,env}=fixture(true),work=works(),put=bucket.put.bind(bucket);let latestWrites=0;
    bucket.put=async(k,v,o)=>{if(k.includes('/latest/')){latestWrites++;return null;}return put(k,v,o);};
    const rows=await runScheduledOperations(env,{cron:'*/3 * * * *',scheduledTime:noon},work);
    expect(rows[0].observation).toBe('conflict');expect(latestWrites).toBe(2);expect(work.meshkore).toHaveBeenCalledTimes(1);
  });
  it('private status requires the existing admin and reports observations without provider schedule or revenue claims',async()=>{
    const {env}=fixture(true);await runScheduledOperations(env,{cron:'*/3 * * * *',scheduledTime:noon},works());
    expect((await app.fetch(statusRequest('',{}),env)).status).toBe(401);
    expect((await app.fetch(statusRequest('?token=fixture-admin-credential'),env)).status).toBe(400);
    expect((await app.fetch(statusRequest('',{authorization:'Bearer fixture-admin-credential',origin:'https://foreign.test'}),env)).status).toBe(400);
    const response=await app.fetch(statusRequest(),env);expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store');
    const result=await response.json() as any;expect(result).toMatchObject({scope:'observational',provider_scheduler_enabled:null,next_run:null,paid_order_recovery_connected:false,revenue_observed:false});
    expect(result.tasks.find((task:any)=>task.task_id==='watch').recorded).toBeNull();expect(JSON.stringify(result)).not.toContain('fixture-admin-credential');
    env.SCHEDULED_OPERATIONS_OBSERVABILITY_ENABLED=undefined;expect((await app.fetch(statusRequest(),env)).status).toBe(503);
  });
  it('malformed stored metadata is not leaked or overwritten by status or observations',async()=>{
    const {bucket,env}=fixture(true);const key='operations/scheduled/latest/meshkore.json';await bucket.put(key,JSON.stringify({secret:'fixture-private-secret'}));const before=bucket.values.get(key);
    expect(await scheduledStatus(env)).toEqual({ok:false,scope:'observational',error:'scheduled_observation_unavailable'});
    const result=await runScheduledOperations(env,{cron:'*/3 * * * *',scheduledTime:noon},works());expect(result[0].observation).toBe('unconfirmed');
    expect(bucket.values.get(key)).toEqual(before);expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('fixture-private-secret');
  });
  it('private status has a short total bound for stalled metadata',async()=>{
    vi.useFakeTimers();const {bucket,env}=fixture(true);bucket.get=async()=>new Promise(()=>{});
    const pending=scheduledStatus(env);await vi.advanceTimersByTimeAsync(SCHEDULED_OBSERVATION_TIMEOUT_MS+1);
    expect(await pending).toEqual({ok:false,scope:'observational',error:'scheduled_observation_unavailable'});
  });
});
