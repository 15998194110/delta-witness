import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import worker,{app} from '../src/index';
import {scheduledPaidOrderRecovery,paidOrderRecoveryStatus,PAID_RECOVERY_PREFIX} from '../src/paid-recovery-control';
import {operatingStatus} from '../src/operating-control';
import {sha256,stableJson} from '../src/crypto';
import {MemoryBucket,orderRuntime,orderRequest,mockOrderNetwork,TEST_ORDER_ID} from './helpers/order-runtime';

class Bucket extends MemoryBucket{
  interrupt=false;lists:R2ListOptions[]=[];completedWrites=0;
  override async put(key:string,value:unknown,options?:R2PutOptions){
    const final=key.startsWith('fulfillments/')&&JSON.parse(String(value)).state==='complete';
    if(final&&this.interrupt){this.interrupt=false;throw new Error('synthetic_final_interruption');}
    const saved=await super.put(key,value,options);if(saved&&final)this.completedWrites++;return saved;
  }
  async list(options:R2ListOptions={}){
    this.lists.push(options);const all=[...this.values.keys()].filter(k=>k.startsWith(options.prefix??'')).sort();
    const offset=options.cursor?Number(options.cursor.slice(8)):0,selected=all.slice(offset,offset+(options.limit??1000));
    const truncated=offset+selected.length<all.length;
    return {objects:selected.map(key=>({key})),truncated,...(truncated?{cursor:`fixture:${offset+selected.length}`}:{})};
  }
}
function fixture(){const bucket=new Bucket(),env=orderRuntime(bucket),network=mockOrderNetwork();
  Object.assign(env,{OPERATIONS_CLOUD_ENABLED:'true',PAID_ORDER_DRAFT_RECOVERY_ENABLED:'true',OPERATIONS_ADMIN_SECRET:'isolated-admin'});
  vi.stubGlobal('fetch',network);return{bucket,env,network};}
async function draft(s:ReturnType<typeof fixture>,n=1){
  s.bucket.interrupt=true;const id=n===1?TEST_ORDER_ID:`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;
  const response=await app.fetch(orderRequest({orderId:id,nonce:`0x${n.toString(16).padStart(64,'0')}`}),s.env);
  expect(response.status).toBe(503);s.network.mockClear();vi.mocked(s.env.BROWSER.quickAction).mockClear();return id;
}
const event=Date.parse('2026-11-03T12:00:00.000Z');
beforeEach(()=>{vi.spyOn(console,'error').mockImplementation(()=>{});vi.spyOn(console,'log').mockImplementation(()=>{});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('default-off recovery performs no inventory, provider or storage operation',async()=>{
  const s=fixture();delete s.env.PAID_ORDER_DRAFT_RECOVERY_ENABLED;const get=vi.spyOn(s.bucket,'get');
  expect(await scheduledPaidOrderRecovery(s.env,event)).toMatchObject({outcome:'skipped',reason:'not_enabled'});
  expect(get).not.toHaveBeenCalled();expect(s.bucket.values.size).toBe(0);expect(s.bucket.lists).toHaveLength(0);expect(s.network).not.toHaveBeenCalled();
});
it('same Cron event has one reservation; original draft completes once and financial facts remain unknown',async()=>{
  const s=fixture();await draft(s);const before=new Map([...s.bucket.values].filter(([key])=>!key.startsWith('fulfillments/')).map(([key,v])=>[key,v.text]));
  const results=await Promise.all([scheduledPaidOrderRecovery(s.env,event),scheduledPaidOrderRecovery(s.env,event)]);
  expect(results.filter(r=>r.outcome==='success')).toHaveLength(1);expect(s.bucket.completedWrites).toBe(1);
  expect(s.bucket.lists.filter(r=>r.prefix==='orders/')).toHaveLength(1);
  const after=new Map([...s.bucket.values].filter(([key])=>before.has(key)).map(([key,v])=>[key,v.text]));expect(after).toEqual(before);
  const status=await paidOrderRecoveryStatus(s.env);expect(status).toMatchObject({inventory_complete:false,customer_revenue:null,new_captures:false,settlement_retries:false});
  expect(status.latest?.result?.counts.recovered).toBe(1);expect(status.cursor_checkpoint?.version).toBe(1);
  await scheduledPaidOrderRecovery(s.env,event);expect(s.bucket.lists.filter(r=>r.prefix==='orders/')).toHaveLength(1);
  expect(s.network).not.toHaveBeenCalled();expect(s.env.BROWSER.quickAction).not.toHaveBeenCalled();
});
it('bounded pages persist the original cursor and a fresh invocation continues without repeated capture',async()=>{
  const s=fixture();for(let n=1;n<=6;n++)await draft(s,n);
  expect(await scheduledPaidOrderRecovery(s.env,event)).toMatchObject({outcome:'success',counts:{selected:5,recovered:5}});
  expect(await scheduledPaidOrderRecovery(s.env,event+900000)).toMatchObject({outcome:'success',counts:{selected:1,recovered:1}});
  expect(s.bucket.lists.filter(r=>r.prefix==='orders/').map(r=>r.cursor??null)).toEqual([null,'fixture:5']);
  const status=await paidOrderRecoveryStatus(s.env);expect(status.cursor_checkpoint?.version).toBe(2);expect(status.inventory_complete).toBe(false);
  expect(s.bucket.completedWrites).toBe(6);expect(s.network).not.toHaveBeenCalled();expect(s.env.BROWSER.quickAction).not.toHaveBeenCalled();
});
it('lost final observation ACK is reconciled by the exact original record before cursor advancement',async()=>{
  const s=fixture();await draft(s);const original=s.bucket.put.bind(s.bucket);let lost=true;
  s.bucket.put=async(key,value,options)=>{const saved=await original(key,value,options);
    if(lost&&key.startsWith(`${PAID_RECOVERY_PREFIX}runs/`)&&JSON.parse(String(value)).state==='observed'){lost=false;throw new Error('synthetic_lost_ack');}return saved;};
  expect(await scheduledPaidOrderRecovery(s.env,event)).toMatchObject({outcome:'success',cursor_state:'advanced'});
  expect(s.bucket.completedWrites).toBe(1);expect((await paidOrderRecoveryStatus(s.env)).cursor_checkpoint?.version).toBe(1);
});
it('uncertain event reservation never grants execution; the next event safely reads the original obligation',async()=>{
  const s=fixture();await draft(s);const put=s.bucket.put.bind(s.bucket);let lost=true;
  s.bucket.put=async(key,value,options)=>{const saved=await put(key,value,options);
    if(lost&&key.startsWith(`${PAID_RECOVERY_PREFIX}runs/`)){lost=false;throw new Error('synthetic_reservation_ack_lost');}return saved;};
  expect(await scheduledPaidOrderRecovery(s.env,event)).toMatchObject({outcome:'degraded'});expect(s.bucket.lists).toHaveLength(0);
  expect(await scheduledPaidOrderRecovery(s.env,event)).toMatchObject({outcome:'degraded',reason:'original_event_recorded'});
  expect(await scheduledPaidOrderRecovery(s.env,event+900000)).toMatchObject({outcome:'success',counts:{recovered:1}});
  expect(s.bucket.completedWrites).toBe(1);expect(s.network).not.toHaveBeenCalled();
});
it('concurrent separate events cannot overwrite a cursor version or complete the original twice',async()=>{
  const s=fixture();await draft(s);const results=await Promise.all([scheduledPaidOrderRecovery(s.env,event),scheduledPaidOrderRecovery(s.env,event+900000)]);
  expect(s.bucket.completedWrites).toBe(1);expect((await paidOrderRecoveryStatus(s.env)).cursor_checkpoint?.version).toBe(1);
  expect(results.some(r=>'cursor_state'in r&&r.cursor_state==='conflict')).toBe(true);expect(s.network).not.toHaveBeenCalled();
});
it('an invalid inventory retains the cursor and leaves an independently readable degraded observation',async()=>{
  const s=fixture();s.bucket.list=async()=>({objects:[{key:'orders/unexpected.txt'}],truncated:false});
  expect(await scheduledPaidOrderRecovery(s.env,event)).toMatchObject({outcome:'degraded',cursor_state:'retained'});
  const status=await paidOrderRecoveryStatus(s.env);expect(status.cursor_checkpoint).toBeNull();expect(status.latest?.result?.reason).toBe('inventory_invalid');
  expect(status.customer_revenue).toBeNull();
});
it('the total page deadline prevents late inventory from completing a draft or advancing the cursor',async()=>{
  const s=fixture();await draft(s);vi.useFakeTimers();let release!:(page:any)=>void,entered!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;});s.bucket.list=async()=>{entered();return new Promise(resolve=>{release=resolve;});};
  const pending=scheduledPaidOrderRecovery(s.env,event);await ready;await vi.advanceTimersByTimeAsync(60001);
  expect(await pending).toMatchObject({outcome:'degraded',cursor_state:'retained'});
  release({objects:[{key:`orders/${TEST_ORDER_ID}.json`}],truncated:false});await vi.advanceTimersByTimeAsync(1);
  expect(s.bucket.completedWrites).toBe(0);expect((await paidOrderRecoveryStatus(s.env)).cursor_checkpoint).toBeNull();
});
it('the existing scheduler connects the opt-in consumer only on its original fifteen-minute event',async()=>{
  const s=fixture();await draft(s);const invoke=async(cron:string,time:number)=>{const pending:Promise<unknown>[]=[];
    await worker.scheduled({cron,scheduledTime:time} as ScheduledController,s.env,{waitUntil(p:Promise<unknown>){pending.push(p);}} as ExecutionContext);await Promise.all(pending);};
  await invoke('*/3 * * * *',event);expect(s.bucket.completedWrites).toBe(0);
  await invoke('*/15 * * * *',event+900000);expect(s.bucket.completedWrites).toBe(1);expect(s.network).not.toHaveBeenCalled();
});
it('optional recovery reads begin concurrently and cannot erase valid primary observations on their own timeout',async()=>{
  const s=fixture(),get=s.bucket.get.bind(s.bucket);vi.useFakeTimers();
  s.bucket.get=async key=>{if(key.startsWith(PAID_RECOVERY_PREFIX))return new Promise(()=>{});
    await new Promise(resolve=>setTimeout(resolve,9000));return get(key);};
  const pending=operatingStatus(s.env);await vi.advanceTimersByTimeAsync(10001);const status=await pending;
  expect(status.ok).toBe(true);expect(status.cloud.paid_order_draft_recovery).toBeNull();expect(status.report.business.metrics.customer_revenue_usdc.value).toBeNull();
});
it('stored result corruption cannot add arbitrary fields to the protected status response',async()=>{
  const s=fixture();await draft(s);await scheduledPaidOrderRecovery(s.env,event);
  const key=`${PAID_RECOVERY_PREFIX}latest.json`,record=JSON.parse(s.bucket.values.get(key)!.text);
  record.result.items[0].unexpected='must-not-pass';record.result_hash=await sha256(stableJson(record.result));
  await s.bucket.put(key,JSON.stringify(record));await expect(paidOrderRecoveryStatus(s.env)).rejects.toThrow();
});
it('misplaced event identity is rejected and old valid observations are explicitly stale',async()=>{
  const s=fixture();await draft(s);await scheduledPaidOrderRecovery(s.env,event);
  const key=`${PAID_RECOVERY_PREFIX}runs/${event+900000}.json`,original=s.bucket.values.get(`${PAID_RECOVERY_PREFIX}runs/${event}.json`)!.text;
  await s.bucket.put(key,original);expect(await scheduledPaidOrderRecovery(s.env,event+900000)).toMatchObject({outcome:'degraded',reason:'control_unconfirmed'});
  const observed=await paidOrderRecoveryStatus(s.env);vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.parse(observed.latest!.result!.completed_at)+3600001);
  expect((await paidOrderRecoveryStatus(s.env)).observation_freshness).toBe('stale');expect((await operatingStatus(s.env)).cloud.background_paid_order_recovery_connected).toBe(false);
});
