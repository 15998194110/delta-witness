import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {app} from '../src/index';
import {operatingStatus,persistOperatingAlertCandidates} from '../src/operating-control';
import {readPaidAlertSource,checkpointPaidAlertSource,PAID_ALERT_SOURCE_PREFIX} from '../src/operating-paid-alert-source';
import {enqueuePaidRecoveryPriority,drainPaidRecoveryPriority,PAID_RECOVERY_PRIORITY_PREFIX} from '../src/paid-recovery-priority';
import {MemoryBucket,orderRuntime,orderRequest,mockOrderNetwork,TEST_ORDER_ID} from './helpers/order-runtime';
const now=Date.parse('2026-11-04T03:00:00.000Z');
class Bucket extends MemoryBucket{
  list=vi.fn(async(options:R2ListOptions)=>{
    const keys=[...this.values.keys()].filter(key=>key.startsWith(options.prefix??'')).sort(),start=Number(options.cursor??0),end=start+(options.limit??3);
    return {objects:keys.slice(start,end).map(key=>({key})),truncated:end<keys.length,...(end<keys.length?{cursor:String(end)}:{})} as R2Objects;
  });
}
function fixture(){const bucket=new Bucket(),env=orderRuntime(bucket),network=mockOrderNetwork();vi.stubGlobal('fetch',network);
  Object.assign(env,{OPERATIONS_CLOUD_ENABLED:'true',OPERATIONS_ALERT_OUTBOX_ENABLED:'true'});return{bucket,env,network};}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now);vi.spyOn(console,'error').mockImplementation(()=>{});});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('valid original proof larger than cursor metadata bounds keeps Core artifact integrity limits',async()=>{
  const s=fixture(),browser=s.env.BROWSER.quickAction as any,original=browser.getMockImplementation();
  browser.mockImplementation(async(...args:unknown[])=>{const response=await original(...args),body=await response.json();
    body.result.content='<h1>'+('valid original public bytes '.repeat(1000))+'</h1>';return Response.json(body,{headers:response.headers});});
  expect((await app.fetch(orderRequest(),s.env)).status).toBe(200);
  const key=[...s.bucket.values.keys()].find(key=>key.startsWith('fulfillments/'))!,value=s.bucket.values.get(key)!;
  s.bucket.values.set(key,{...value,text:JSON.stringify({...JSON.parse(value.text),state:'processing'})});
  s.network.mockClear();browser.mockClear();const page=await readPaidAlertSource(s.env);
  expect(page.observation?.items[0].summary).toMatchObject({state:'pending_original_delivery',reason:'original_delivery_recoverable'});
  expect(page.issues).toHaveLength(1);expect(s.network).not.toHaveBeenCalled();expect(browser).not.toHaveBeenCalled();
});
it('original confirmed unpaid-delivery debt survives quarantine and later healthy scans as one stable incident',async()=>{
  const s=fixture();vi.setSystemTime(now-600_000);
  expect((await app.fetch(orderRequest(),s.env)).status).toBe(200);
  const fulfillment=[...s.bucket.values.keys()].find(key=>key.startsWith('fulfillments/'))!,v=s.bucket.values.get(fulfillment)!;
  s.bucket.values.set(fulfillment,{...v,text:JSON.stringify({...JSON.parse(v.text),state:'processing'})});
  await enqueuePaidRecoveryPriority(s.env,TEST_ORDER_ID);
  const orderKey=`orders/${TEST_ORDER_ID}.json`,order=s.bucket.values.get(orderKey)!;
  s.bucket.values.set(orderKey,{...order,text:JSON.stringify({...JSON.parse(order.text),revoked_at:new Date().toISOString()})});
  expect(await drainPaidRecoveryPriority(s.env)).toMatchObject({counts:{quarantined:1}});
  expect(JSON.parse(s.bucket.values.get(`${PAID_RECOVERY_PRIORITY_PREFIX}pending.json`)!.text).entries).toEqual([]);
  s.network.mockClear();vi.mocked(s.env.BROWSER.quickAction).mockClear();vi.setSystemTime(now);
  const originals=()=>[...s.bucket.values].filter(([key])=>!key.startsWith('operations/alerts/'));const before=structuredClone(originals());
  const status=await operatingStatus(s.env),alert=status.report.alerts.find(row=>row.code==='paid_undelivered');
  expect(alert).toMatchObject({subject:`order-${TEST_ORDER_ID}`,severity:'SEV1',first_seen_at:new Date(now-600_000).toISOString()});
  expect(status.cloud.paid_alert_source).toMatchObject({state:'observed',selected:1,inventory_complete:false});
  expect(await persistOperatingAlertCandidates(s.env)).toMatchObject({selected:1,paid_source_checkpoint:{state:'advanced'}});
  vi.setSystemTime(now+900_000);expect(await persistOperatingAlertCandidates(s.env)).toMatchObject({selected:1,paid_source_checkpoint:{state:'advanced'}});
  const incidents=[...s.bucket.values].filter(([key])=>key.startsWith('operations/alerts/episodes/'));
  expect(incidents).toHaveLength(1);expect(JSON.parse(incidents[0][1].text)).toMatchObject({state:'blocked',receipt:null,acknowledgment:null});
  expect(originals()).toEqual(before);expect(s.network).not.toHaveBeenCalled();expect(s.env.BROWSER.quickAction).not.toHaveBeenCalled();
});
it('cycles bounded original pages with immutable observations; concurrent stale readers cannot skip a page',async()=>{
  const s=fixture();for(let n=1;n<=7;n++)await s.bucket.put(`orders/11111111-1111-4111-8111-${String(n).padStart(12,'0')}.json`,'{}');
  const a=await readPaidAlertSource(s.env),b=await readPaidAlertSource(s.env);expect(a.observation?.items).toHaveLength(3);
  expect(await checkpointPaidAlertSource(s.env,a)).toMatchObject({state:'advanced'});
  expect(await checkpointPaidAlertSource(s.env,b)).toMatchObject({state:'advanced'}); // same immutable page + exact readback
  const next=await readPaidAlertSource(s.env);expect(next.observation?.input_cursor).toBe('3');await checkpointPaidAlertSource(s.env,next);
  const last=await readPaidAlertSource(s.env);expect(last.observation?.items).toHaveLength(1);await checkpointPaidAlertSource(s.env,last);
  expect((await readPaidAlertSource(s.env)).observation?.input_cursor).toBeNull();
  expect([...s.bucket.values.keys()].filter(key=>key.startsWith(`${PAID_ALERT_SOURCE_PREFIX}pages/`))).toHaveLength(3);
  expect(s.bucket.list.mock.calls.every(([options])=>options.limit===3)).toBe(true);
});
it('storage outages and invalid inventory remain unknown; neither creates success nor discards an existing incident',async()=>{
  const s=fixture();s.bucket.list.mockRejectedValueOnce(new Error('fixture R2 unavailable'));
  const unknown=await readPaidAlertSource(s.env);expect(unknown).toMatchObject({state:'unknown',inventory_complete:false,issues:[]});
  expect(await checkpointPaidAlertSource(s.env,unknown)).toMatchObject({state:'retained'});expect(s.bucket.values.size).toBe(0);
  s.bucket.list.mockResolvedValueOnce({objects:[{key:'private/unrelated'}],truncated:false} as R2Objects);
  expect(await readPaidAlertSource(s.env)).toMatchObject({state:'unknown'});expect(s.bucket.values.size).toBe(0);
});
it('persisted page is required before cursor movement; lost cursor ACK uses original readback',async()=>{
  const s=fixture(),page=await readPaidAlertSource(s.env),put=s.bucket.put.bind(s.bucket);
  s.bucket.put=async(key,value,options)=>{if(key.includes('/pages/'))throw new Error('fixture write rejection');return put(key,value,options);};
  expect(await checkpointPaidAlertSource(s.env,page)).toMatchObject({state:'retained'});expect(s.bucket.values.size).toBe(0);
  s.bucket.put=async(key,value,options)=>{const saved=await put(key,value,options);if(key===`${PAID_ALERT_SOURCE_PREFIX}cursor.json`)throw new Error('fixture response loss');return saved;};
  expect(await checkpointPaidAlertSource(s.env,page)).toMatchObject({state:'advanced'});
});
