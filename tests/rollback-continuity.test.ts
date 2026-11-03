import {afterEach,expect,it,vi} from 'vitest';
import {withPaidRecoveryContinuity} from '../src/rollback-continuity';
import {app} from '../src/index';
import {MemoryBucket,mockOrderNetwork,orderRuntime,orderRequest} from './helpers/order-runtime';
class Bucket extends MemoryBucket {
  interrupt=true;completions=0;
  async list(options:R2ListOptions={}){return {objects:[...this.values.keys()].filter(key=>key.startsWith(options.prefix??'')).map(key=>({key})),truncated:false};}
  override async put(key:string,value:unknown,options?:R2PutOptions){
    const complete=key.startsWith('fulfillments/')&&JSON.parse(String(value)).state==='complete';
    if(complete&&this.interrupt){this.interrupt=false;throw Error('synthetic_original_completion_interrupted');}
    const saved=await super.put(key,value,options);if(saved&&complete)this.completions++;return saved;
  }
}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it('keeps original fetch authority and does no recovery when existing flags are disabled',async()=>{
  const bucket=new Bucket(),env=orderRuntime(bucket),scheduled=vi.fn(),fetch=vi.fn();
  const wrapped=withPaidRecoveryContinuity({fetch,scheduled}),pending:Promise<unknown>[]=[];
  expect(wrapped.fetch).toBe(fetch);
  await wrapped.scheduled!({cron:'*/15 * * * *',scheduledTime:Date.now()} as ScheduledController,env,{waitUntil(p){pending.push(p);}} as ExecutionContext);
  expect(scheduled).toHaveBeenCalledOnce();expect(pending).toEqual([]);expect(bucket.values.size).toBe(0);
});
it('old unrelated scheduled-lane failure does not strand a verified original draft; repeated event does not complete twice',async()=>{
  vi.spyOn(console,'error').mockImplementation(()=>{});
  const bucket=new Bucket(),env=orderRuntime(bucket),network=mockOrderNetwork();vi.stubGlobal('fetch',network);
  expect((await app.fetch(orderRequest(),env)).status).toBe(503);
  const originals=[...bucket.values].filter(([key])=>!key.startsWith('fulfillments/')).map(([key,v])=>[key,v.text]);
  network.mockClear();vi.mocked(env.BROWSER.quickAction).mockClear();
  Object.assign(env,{OPERATIONS_CLOUD_ENABLED:'true',PAID_ORDER_DRAFT_RECOVERY_ENABLED:'true'});
  const wrapped=withPaidRecoveryContinuity({scheduled(){throw Error('synthetic_old_lane_down');}}),at=Date.now();
  for(let n=0;n<2;n++){
    const pending:Promise<unknown>[]=[];
    await expect(wrapped.scheduled!({cron:'*/15 * * * *',scheduledTime:at} as ScheduledController,env,{waitUntil(p){pending.push(p);}} as ExecutionContext)).rejects.toThrow('synthetic_old_lane_down');
    await Promise.all(pending);
  }
  expect(bucket.completions).toBe(1);expect(network).not.toHaveBeenCalled();expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  expect([...bucket.values].filter(([key])=>originals.some(([original])=>original===key)).map(([key,v])=>[key,v.text])).toEqual(originals);
});
