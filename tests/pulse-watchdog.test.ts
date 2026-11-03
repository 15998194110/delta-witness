import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {pulseWatchdog,PULSE_STALE_MS} from '../src/pulse-watchdog';
import {MemoryBucket,orderRuntime} from './helpers/order-runtime';
const now=Date.parse('2026-11-03T12:00:00.000Z'),release='a'.repeat(40),key='operations/control/pulse-watchdog.json';
const path='.github/workflows/discovery-pulse.yml';
function fixture(){const bucket=new MemoryBucket(),env=orderRuntime(bucket);Object.assign(env,{OPERATIONS_CLOUD_ENABLED:'true',PULSE_WATCHDOG_ENABLED:'true',OPERATIONS_RELEASE_SHA:release,GITHUB_ACTIONS_DISPATCH_TOKEN:'fixture-provider-credential'});return{bucket,env};}
const row=(id:number,at=now-PULSE_STALE_MS-1)=>({id,workflow_id:71,head_sha:release,path,head_branch:'master',event:'schedule',display_title:`DELTA Pulse ${id}`,status:'completed',conclusion:'success',created_at:new Date(at).toISOString().replace('.000Z','Z')});
function network(options:{recent?:boolean;active?:boolean;lost?:boolean;legacyAck?:boolean;branch?:string}={}){
  let dispatched:any=null;let dispatchId=82;const body=()=>({...row(dispatchId,now),event:'workflow_dispatch',display_title:`DELTA Pulse watchdog ${dispatched.inputs.delta_watchdog_run}`});
  const fetch=vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=String(input);expect(url.startsWith('https://api.github.com/repos/15998194110/delta-witness/')).toBe(true);
    if(url.endsWith('/actions/workflows/discovery-pulse.yml'))return Response.json({id:71,path,state:options.active===false?'disabled_manually':'active'});
    if(url.endsWith('/branches/master'))return Response.json({commit:{sha:options.branch??release}});
    if(url.includes('/runs?'))return Response.json({workflow_runs:[...(dispatched?[body()]:[]),row(81,options.recent?now-20_000:undefined)]});
    if(url.endsWith('/actions/runs/82'))return Response.json(body());
    if(url.endsWith('/dispatches')){
      expect(init?.redirect).toBe('error');dispatched=JSON.parse(String(init?.body));
      expect(dispatched.ref).toBe('master');expect(dispatched.inputs.delta_watchdog_release).toBe(release);
      if(options.lost)throw new Error('fixture_lost_ack');
      return options.legacyAck?new Response(null,{status:204}):Response.json({workflow_run_id:dispatchId});
    }
    throw new Error('unexpected_fixture_url');
  });return{fetch,get dispatched(){return dispatched;},body};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now);});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('single canonical Pulse cloud watchdog',()=>{
  it('default disabled has no network or state effects',async()=>{const {bucket,env}=fixture();delete env.OPERATIONS_CLOUD_ENABLED;const fetch=vi.fn();vi.stubGlobal('fetch',fetch);expect((await pulseWatchdog(env)).outcome).toBe('disabled');expect(fetch).not.toHaveBeenCalled();expect(bucket.values.size).toBe(0);});
  it('does not activate a disabled workflow or dispatch a release drift',async()=>{for(const opts of[{active:false},{branch:'b'.repeat(40)}]){const {env}=fixture(),net=network(opts);vi.stubGlobal('fetch',net.fetch);expect((await pulseWatchdog(env)).outcome).toBe('degraded');expect(net.dispatched).toBeNull();}});
  it('recent real run does not cause a duplicate dispatch',async()=>{const {env}=fixture(),net=network({recent:true});vi.stubGlobal('fetch',net.fetch);expect((await pulseWatchdog(env)).reason).toBe('canonical_run_recent');expect(net.dispatched).toBeNull();});
  it('concurrent delayed triggers authorize at most one POST',async()=>{const {bucket,env}=fixture(),net=network();vi.stubGlobal('fetch',net.fetch);const result=await Promise.all([pulseWatchdog(env),pulseWatchdog(env)]);expect(result.some(x=>x.outcome==='dispatched')).toBe(true);expect(net.fetch.mock.calls.filter(([url])=>String(url).endsWith('/dispatches'))).toHaveLength(1);expect(JSON.parse(bucket.values.get(key)!.text).github_run_id).toBe('82');expect([...bucket.values.keys()].every(x=>x.startsWith('operations/'))).toBe(true);});
  it.each([{lost:true},{legacyAck:true}])('uncertain ACK is read back as original run; never retried %s',async options=>{const {bucket,env}=fixture(),net=network(options);vi.stubGlobal('fetch',net.fetch);expect((await pulseWatchdog(env)).outcome).toBe('recovery_required');vi.setSystemTime(now+100_000);expect((await pulseWatchdog(env)).reason).toBe('original_dispatch_confirmed');expect(net.fetch.mock.calls.filter(([url])=>String(url).endsWith('/dispatches'))).toHaveLength(1);expect(JSON.parse(bucket.values.get(key)!.text).outcome).toBe('confirmed');});
  it('confirmed original nonterminal run outside latest-ten still blocks new POST',async()=>{const {bucket,env}=fixture(),net=network();vi.stubGlobal('fetch',net.fetch);await pulseWatchdog(env);vi.setSystemTime(now+100_000);await pulseWatchdog(env);
    const follow=vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
      if(String(input).includes('/runs?'))return Response.json({workflow_runs:[row(99,now-PULSE_STALE_MS-1)]});
      if(String(input).endsWith('/actions/runs/82'))return Response.json({...net.body(),status:'queued'});
      return net.fetch(input,init);
    });vi.stubGlobal('fetch',follow);vi.setSystemTime(now+PULSE_STALE_MS+100_000);
    expect((await pulseWatchdog(env)).reason).toBe('original_canonical_run_not_terminal');expect(follow.mock.calls.some(([url])=>String(url).endsWith('/dispatches'))).toBe(false);
    expect(JSON.parse(bucket.values.get(key)!.text).github_run_id).toBe('82');});
  it('readback must bind original workflow, release and payload',async()=>{const {env}=fixture(),net=network({lost:true});vi.stubGlobal('fetch',net.fetch);await pulseWatchdog(env);vi.setSystemTime(now+100_000);
    const corrupt=vi.fn(async(input:string|URL|Request,init?:RequestInit)=>String(input).endsWith('/actions/runs/82')?Response.json({...net.body(),head_sha:'b'.repeat(40)}):net.fetch(input,init));
    vi.stubGlobal('fetch',corrupt);expect((await pulseWatchdog(env)).reason).toBe('prior_dispatch_identity_mismatch');expect(corrupt.mock.calls.some(([url])=>String(url).endsWith('/dispatches'))).toBe(false);});
  it('a lost guard write ACK never authorizes provider work or clears the guard',async()=>{const {bucket,env}=fixture(),net=network(),put=bucket.put.bind(bucket);bucket.put=async(k,v,o)=>{const answer=await put(k,v,o);if(k===key)throw new Error('fixture_write_ack_lost');return answer;};vi.stubGlobal('fetch',net.fetch);expect((await pulseWatchdog(env)).outcome).toBe('degraded');expect(net.dispatched).toBeNull();expect(bucket.values.has(key)).toBe(true);});
  it('interrupted running task reconciles using the time after lease-freeze IO',async()=>{
    const {bucket,env}=fixture(),net=network({lost:true}),put=bucket.put.bind(bucket);let blockFinish=true;
    bucket.put=async(k,v,o)=>{if(k.startsWith('operations/tasks/')&&JSON.parse(String(v)).state==='recovery_required'){
      if(blockFinish)throw new Error('fixture_interrupted_before_finish');vi.setSystemTime(Date.now()+5);
    }return put(k,v,o);};vi.stubGlobal('fetch',net.fetch);await pulseWatchdog(env);
    blockFinish=false;vi.setSystemTime(now+100_000);expect((await pulseWatchdog(env)).reason).toBe('original_dispatch_confirmed');
    expect(net.fetch.mock.calls.filter(([url])=>String(url).endsWith('/dispatches'))).toHaveLength(1);
  });
});
