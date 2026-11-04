import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import worker,{app} from '../src/index';
import {MemoryBucket,orderRuntime} from './helpers/order-runtime';
import {checkpointRevisionDigest} from '../scripts/treasury-checkpoint-store.mjs';
import {cronObservationStatus} from '../src/cron-observer';
import {operatingStatus} from '../src/operating-control';

const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
async function fixture(){
  const bucket=new MemoryBucket(),env=orderRuntime(bucket);
  Object.assign(bucket,{list:async()=>({objects:[],truncated:false})});
  Object.assign(env,{CRON_OBSERVER_ENABLED:'true',OPERATIONS_CLOUD_ENABLED:'true',OPERATIONS_ALERT_OUTBOX_ENABLED:'true',
    OPERATIONS_TREASURY_NOTIFICATIONS_ENABLED:'true',TREASURY_CUSTODY_ENABLED:'true',TREASURY_CUSTODY_ORIGIN_BLOCK:'1',
    TREASURY_CUSTODY_MINIMUM_VERSION:'1',OPERATIONS_ALERT_DESTINATION_ID:'fixture-owner',
    OPERATIONS_ALERT_DESTINATION_DIGEST:`sha256:${'a'.repeat(64)}`,OPERATIONS_ADMIN_SECRET:'synthetic-admin'});
  const asset='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',at=new Date(Date.now()-60000).toISOString();
  const transfer={receipt_id:`eip155:8453:${asset}:${h(1)}:0`,tx_hash:h(1),block_hash:h(2),block_number:2,log_index:0,
    from:'0x1111111111111111111111111111111111111111',to:env.PAY_TO,raw_amount:'1000000',usdc_decimal:'1.000000',
    usdc:1,treasury_received:true,payer_classification:'unclassified',customer_revenue:'unclassified'};
  const state={schema:'delta-treasury-checkpoint/v1',network:'eip155:8453',asset,treasury:env.PAY_TO,origin_block:1,
    checked_through_block:100,checked_through_hash:h(100),reorg_anchor:{number:90,hash:h(90)},confirmation_depth:12,
    checked_at:at,transfers:[transfer],corrections:[]};
  const digest=await checkpointRevisionDigest(state);env.TREASURY_CUSTODY_MINIMUM_DIGEST=digest;
  await bucket.put('operations/treasury/revisions/revision-0000000001.json',JSON.stringify({schema:'delta-treasury-revision/v1',version:1,previous_digest:null,digest,state}));
  return {bucket,env};
}
async function tick(env:ReturnType<typeof orderRuntime>,cron='*/15 * * * *'){
  const pending:Promise<unknown>[]=[];
  await worker.scheduled({cron,scheduledTime:Date.now()} as ScheduledController,env,{waitUntil(p:Promise<unknown>){pending.push(p);}} as ExecutionContext);
  return Promise.all(pending);
}
const receipts=(bucket:MemoryBucket)=>[...bucket.values].filter(([key])=>key.startsWith('operations/alerts/episodes/')).map(([,r])=>JSON.parse(r.text));
beforeEach(()=>{vi.spyOn(console,'log').mockImplementation(()=>{});vi.stubGlobal('fetch',vi.fn(()=>{throw Error('isolated-no-network');}));
  const original=crypto,subtle=new Proxy(original.subtle,{get(target,name){if(name==='timingSafeEqual')return(a:ArrayBuffer,b:ArrayBuffer)=>Buffer.from(a).equals(Buffer.from(b));
    const v=Reflect.get(target,name,target);return typeof v==='function'?v.bind(target):v;}});
  vi.stubGlobal('crypto',new Proxy(original,{get(target,name){if(name==='subtle')return subtle;const v=Reflect.get(target,name,target);return typeof v==='function'?v.bind(target):v;}}));
});
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('the actual existing Cron15 reaches the real producer using one canonical flag and never charges or sends',async()=>{
  const {bucket,env}=await fixture();await tick(env);
  const original=receipts(bucket);expect(original).toHaveLength(1);
  expect(original[0]).toMatchObject({state:'queued',receipt:null,episode:{code:'treasury_received',severity:'INFO',receipt:{usdc_decimal:'1.000000',customer_revenue:'UNKNOWN'}}});
  await tick(env);expect(receipts(bucket)).toEqual(original);
  const status=await operatingStatus(env);
  expect(status.cloud.treasury_receipt_notifications).toMatchObject({enabled:true,state:'observed',source_revision:1,freshness:'FRESH',notification_delivered:null});
  expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
});
it.each([undefined,'false'])('normal notifications stay disabled without exact opt-in (%s)',async flag=>{
  const {bucket,env}=await fixture();env.OPERATIONS_TREASURY_NOTIFICATIONS_ENABLED=flag;await tick(env);
  expect(receipts(bucket)).toHaveLength(0);expect((await operatingStatus(env)).cloud.treasury_receipt_notifications.state).toBe('disabled');
});
it('missing original custody anchor degrades Cron while unrelated work completes and original source stays intact',async()=>{
  const {bucket,env}=await fixture();const original=[...bucket.values.values()][0].text;env.TREASURY_CUSTODY_MINIMUM_DIGEST='b'.repeat(64);
  await expect(tick(env)).rejects.toThrow('cron_control_degraded');
  const status=await cronObservationStatus(env);if(!('tasks' in status))throw Error('missing cron evidence');
  expect(status.tasks[1].runs[0].outcome).toBe('degraded');expect(receipts(bucket)).toHaveLength(0);
  expect([...bucket.values.values()][0].text).toBe(original);expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
});
it.each(['treasury_received','treasury_receipt_corrected'])('generic admin observations cannot author financial notices (%s)',async code=>{
  const {bucket,env}=await fixture();const response=await app.fetch(new Request('https://delta.test/internal/operations/alerts/observe',{
    method:'POST',headers:{authorization:'Bearer synthetic-admin','content-type':'application/json'},body:JSON.stringify({code})}),env);
  expect(response.status).toBe(400);expect(await response.json()).toEqual({error:'treasury_notification_source_required'});expect(receipts(bucket)).toHaveLength(0);
});
