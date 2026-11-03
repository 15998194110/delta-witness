import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {enqueueOperatingAlert,readOperatingAlert,acknowledgeOperatingAlert,processOperatingAlert,ALERT_OUTBOX_PREFIX,
  type AlertObservation,type AlertAdapter,type AlertReceipt} from '../src/operating-alert-outbox';
import {MemoryBucket,orderRuntime} from './helpers/order-runtime';
const now=Date.parse('2026-11-03T12:00:00.000Z');
const episode:AlertObservation={dedupe_key:'delta:paid_undelivered:order-1:episode-1',code:'paid_undelivered',subject:'order-1',severity:'SEV1',stage:'initial',first_seen_at:new Date(now-600000).toISOString(),evidence_ref:'original-paid-condition'};
const dest={id:'approved-owner-channel',digest:`sha256:${'a'.repeat(64)}`};
function fixture(){const bucket=new MemoryBucket(),env=orderRuntime(bucket);return{bucket,env};}
function adapter(status:AlertReceipt['status']='delivered'):AlertAdapter{return{destination:dest,permission:{state:'available',observed_at:new Date().toISOString(),evidence_ref:'provider-permission'},
  send:vi.fn(async operation=>({...operation,status,receipt_id:'provider-original-receipt',observed_at:new Date().toISOString()})),readOriginal:vi.fn(async()=>null)} as AlertAdapter;}
// Providers expose an exact receipt; extra send fields cannot be trusted as a
// receipt (no copying request blobs or provider error text into stored output).
function exactAdapter(status:AlertReceipt['status']='delivered'){
  const a=adapter(status);a.send=vi.fn(async op=>({notification_id:op.notification_id,payload_hash:op.payload_hash,destination_digest:op.destination_digest,
    status,receipt_id:'provider-original-receipt',observed_at:new Date().toISOString()}));return a;
}
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('no-network');}));});
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('persists a blocked episode without a destination and cannot recursively notify notification failures',async()=>{
  const s=fixture();expect(await enqueueOperatingAlert(s.env,episode)).toMatchObject({state:'blocked'});
  const r=await readOperatingAlert(s.env,episode.dedupe_key);expect(r).toMatchObject({state:'blocked',destination:null,receipt:null,acknowledgment:null,generation:0});
  await expect(enqueueOperatingAlert(s.env,{...episode,code:'notification_unconfirmed' as any})).rejects.toThrow('alert_input_invalid');
  expect(s.env.BROWSER.quickAction).not.toHaveBeenCalled();expect([...s.bucket.values.keys()].every(k=>k.startsWith(ALERT_OUTBOX_PREFIX))).toBe(true);
});
it('concurrent and repeated observations preserve one original intent, payload and history',async()=>{
  const s=fixture();await Promise.all([enqueueOperatingAlert(s.env,episode,dest),enqueueOperatingAlert(s.env,episode,dest)]);
  const before=await readOperatingAlert(s.env,episode.dedupe_key);for(let n=0;n<5;n++)await enqueueOperatingAlert(s.env,episode,dest);
  expect(await readOperatingAlert(s.env,episode.dedupe_key)).toEqual(before);expect(s.bucket.values.size).toBe(1);expect(before?.history).toHaveLength(1);
});
it('an unattempted blocked original may bind a destination without creating a second notification identity',async()=>{
  const s=fixture();await enqueueOperatingAlert(s.env,episode);const before=await readOperatingAlert(s.env,episode.dedupe_key);
  await enqueueOperatingAlert(s.env,episode,dest);const after=await readOperatingAlert(s.env,episode.dedupe_key);
  expect(after?.notification_id).toBe(before?.notification_id);expect(after?.state).toBe('queued');expect(after?.history[0].destination).toBeNull();
});
it('two dispatchers have a single conditional permission and acceptance does not prove delivery',async()=>{
  const s=fixture();await enqueueOperatingAlert(s.env,episode,dest);const a=exactAdapter('provider_accepted');
  await Promise.all([processOperatingAlert(s.env,episode.dedupe_key,a),processOperatingAlert(s.env,episode.dedupe_key,a)]);
  expect(a.send).toHaveBeenCalledTimes(1);const r=await readOperatingAlert(s.env,episode.dedupe_key);expect(r).toMatchObject({state:'provider_accepted',acknowledgment:null});
  a.readOriginal=vi.fn(async()=>({...r!.receipt!,status:'delivered' as const}));
  expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'delivered',recipient_acknowledged:false});expect(a.send).toHaveBeenCalledTimes(1);
});
it('explicit ACK binds exact episode, notification, payload and owner evidence',async()=>{
  const s=fixture();await enqueueOperatingAlert(s.env,episode,dest);const r=(await readOperatingAlert(s.env,episode.dedupe_key))!;
  const input={notification_id:r.notification_id,payload_hash:r.payload_hash,actor_ref:'owner-authorized-api',evidence_ref:'explicit-owner-ack',observed_at:new Date().toISOString()};
  await expect(acknowledgeOperatingAlert(s.env,episode.dedupe_key,{...input,payload_hash:`sha256:${'b'.repeat(64)}`})).rejects.toThrow();
  expect(await acknowledgeOperatingAlert(s.env,episode.dedupe_key,input)).toMatchObject({state:'acknowledged'});
  expect(await enqueueOperatingAlert(s.env,episode,dest)).toMatchObject({state:'suppressed'});
  const a=exactAdapter();await processOperatingAlert(s.env,episode.dedupe_key,a);expect(a.send).not.toHaveBeenCalled();
});
it('unknown send preserves the original operation and absence of provider receipt never permits resending',async()=>{
  const s=fixture();await enqueueOperatingAlert(s.env,episode,dest);const a=exactAdapter();a.send=vi.fn(async()=>{throw new Error('provider-secret-must-not-escape');});
  expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'unconfirmed'});
  for(let n=0;n<3;n++)expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'unconfirmed'});
  expect(a.send).toHaveBeenCalledTimes(1);expect(a.readOriginal).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(await readOperatingAlert(s.env,episode.dedupe_key))).not.toContain('provider-secret');
});
it('send timeout fences late writes and later exact-original readback may confirm delivery',async()=>{
  vi.useRealTimers();vi.useFakeTimers();vi.setSystemTime(now);const s=fixture();await enqueueOperatingAlert(s.env,episode,dest);const a=exactAdapter();
  let release!:(r:AlertReceipt)=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
  a.send=vi.fn(async()=>{entered();return new Promise<AlertReceipt>(resolve=>{release=resolve;});});
  const pending=processOperatingAlert(s.env,episode.dedupe_key,a);await ready;await vi.advanceTimersByTimeAsync(10001);expect(await pending).toMatchObject({state:'unconfirmed'});
  const r=(await readOperatingAlert(s.env,episode.dedupe_key))!,receipt:AlertReceipt={notification_id:r.notification_id,payload_hash:r.payload_hash,destination_digest:dest.digest,status:'delivered',receipt_id:'verified-original',observed_at:new Date().toISOString()};
  release(receipt);await vi.advanceTimersByTimeAsync(1);expect((await readOperatingAlert(s.env,episode.dedupe_key))?.state).toBe('unconfirmed');
  a.readOriginal=vi.fn(async()=>receipt);expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'delivered'});expect(a.send).toHaveBeenCalledTimes(1);
});
it('lost claim ACK grants no send and an expired sending lease only permits original readback',async()=>{
  const s=fixture();await enqueueOperatingAlert(s.env,episode,dest);const put=s.bucket.put.bind(s.bucket);let lost=true;
  s.bucket.put=async(k,v,o)=>{const saved=await put(k,v,o);if(lost&&JSON.parse(String(v)).state==='sending'){lost=false;throw new Error('lost-claim');}return saved;};
  const a=exactAdapter();await expect(processOperatingAlert(s.env,episode.dedupe_key,a)).rejects.toThrow();expect(a.send).not.toHaveBeenCalled();
  vi.setSystemTime(now+15001);a.permission.observed_at=new Date().toISOString();expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'unconfirmed'});
  expect(a.send).not.toHaveBeenCalled();expect(a.readOriginal).toHaveBeenCalledTimes(1);
});
it('a final receipt write with lost ACK is read back without sending again',async()=>{
  const s=fixture();await enqueueOperatingAlert(s.env,episode,dest);const put=s.bucket.put.bind(s.bucket);let lost=true;
  s.bucket.put=async(k,v,o)=>{const saved=await put(k,v,o);if(lost&&JSON.parse(String(v)).state==='delivered'){lost=false;throw new Error('lost-final');}return saved;};
  const a=exactAdapter();expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'delivered'});expect(a.send).toHaveBeenCalledTimes(1);
});
it('worsening waits for uncertain original delivery, and retained history preserves prior message identity',async()=>{
  const s=fixture(),initial={...episode,severity:'SEV3' as const};await enqueueOperatingAlert(s.env,initial,dest);const a=exactAdapter('provider_accepted');await processOperatingAlert(s.env,episode.dedupe_key,a);
  const before=(await readOperatingAlert(s.env,episode.dedupe_key))!;
  expect(await enqueueOperatingAlert(s.env,{...episode,stage:'escalated'},dest)).toMatchObject({reason:'original_operation_requires_readback'});
  a.readOriginal=vi.fn(async()=>({...before.receipt!,status:'delivered' as const}));await processOperatingAlert(s.env,episode.dedupe_key,a);
  await enqueueOperatingAlert(s.env,{...episode,stage:'escalated'},dest);const after=(await readOperatingAlert(s.env,episode.dedupe_key))!;
  expect(after.notification_id).not.toBe(before.notification_id);expect(after.state).toBe('queued');expect(after.history.some(h=>h.notification_id===before.notification_id&&h.receipt?.status==='delivered')).toBe(true);
});
it.each(['extra','wrong-id','wrong-destination','future'])('rejects unverified provider receipt %s without accepting it',async kind=>{
  const s=fixture();await enqueueOperatingAlert(s.env,episode,dest);const a=exactAdapter(),send=a.send;
  a.send=vi.fn(async(op,signal)=>{const r:any=await send(op,signal);if(kind==='extra')r.secret='not-persisted';if(kind==='wrong-id')r.notification_id=crypto.randomUUID();if(kind==='wrong-destination')r.destination_digest=`sha256:${'b'.repeat(64)}`;if(kind==='future')r.observed_at=new Date(now+1).toISOString();return r;});
  await expect(processOperatingAlert(s.env,episode.dedupe_key,a)).rejects.toThrow();expect((await readOperatingAlert(s.env,episode.dedupe_key))?.state).toBe('sending');
});
it('provider proof of non-application records failure distinctly and never automatically creates another send',async()=>{
  const s=fixture();await enqueueOperatingAlert(s.env,episode,dest);const a=exactAdapter('not_applied');await processOperatingAlert(s.env,episode.dedupe_key,a);
  expect((await readOperatingAlert(s.env,episode.dedupe_key))?.state).toBe('failed');await processOperatingAlert(s.env,episode.dedupe_key,a);expect(a.send).toHaveBeenCalledTimes(1);
});
it('native delivery failure remains distinct from provider non-application and never automatically resends',async()=>{
  const s=fixture();await enqueueOperatingAlert(s.env,episode,dest);const a=exactAdapter('failed');
  expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'failed'});
  expect((await readOperatingAlert(s.env,episode.dedupe_key))?.receipt?.status).toBe('failed');
  await processOperatingAlert(s.env,episode.dedupe_key,a);expect(a.send).toHaveBeenCalledTimes(1);
});
