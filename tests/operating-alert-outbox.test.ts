import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {enqueueOperatingAlert,readOperatingAlert,acknowledgeOperatingAlert,processOperatingAlert,ALERT_OUTBOX_PREFIX,
  type AlertObservation,type AlertAdapter,type AlertReceipt,type TreasuryNotificationObservation,validOperatingNotification} from '../src/operating-alert-outbox';
import {MemoryBucket,orderRuntime} from './helpers/order-runtime';
const now=Date.parse('2026-11-03T12:00:00.000Z');
const episode:AlertObservation={dedupe_key:'delta:paid_undelivered:order-1:episode-1',code:'paid_undelivered',subject:'order-1',severity:'SEV1',stage:'initial',first_seen_at:new Date(now-600000).toISOString(),evidence_ref:'original-paid-condition'};
const dest={id:'approved-owner-channel',digest:`sha256:${'a'.repeat(64)}`};
function treasuryEpisode():TreasuryNotificationObservation{const tx=`0x${'1'.repeat(64)}`;
  return{dedupe_key:'delta:treasury_received:receipt-1:observation-1',code:'treasury_received',subject:'receipt-1',severity:'INFO',stage:'initial',
    first_seen_at:new Date(now-1000).toISOString(),evidence_ref:'custody-original-1',receipt:{network:'eip155:8453',occurrence:'initial_observation',asset:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      treasury:'0x1990e21bc219696ff7fbc26527dbaed335ac6367',receipt_id:`eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:${tx}:2`,tx_hash:tx,log_index:2,
      block_number:123456,block_hash:`0x${'2'.repeat(64)}`,raw_amount:'1000001',usdc_decimal:'1.000001',confirmation_depth:12,observed_at:new Date(now-1000).toISOString(),
      custody_revision:1,custody_digest:'a'.repeat(64),payer_classification:'unclassified',customer_revenue:'UNKNOWN',actual_cost:'UNKNOWN',contribution_margin:'UNKNOWN',fulfillment:'UNKNOWN',correction:null}};
}
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
it('many unchanged accepted polls preserve transition capacity for eventual delivery and explicit ACK',async()=>{
  const s=fixture();await enqueueOperatingAlert(s.env,episode,dest);const a=exactAdapter('provider_accepted');
  await processOperatingAlert(s.env,episode.dedupe_key,a);const original=(await readOperatingAlert(s.env,episode.dedupe_key))!;
  a.readOriginal=vi.fn(async()=>({...original.receipt!,observed_at:new Date().toISOString()}));
  for(let n=0;n<40;n++){vi.setSystemTime(now+n*1000);expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'provider_accepted',reason:'original_receipt_unchanged'});}
  expect(await readOperatingAlert(s.env,episode.dedupe_key)).toEqual(original);
  a.readOriginal=vi.fn(async()=>({...original.receipt!,status:'delivered' as const,observed_at:new Date().toISOString()}));
  expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'delivered',recipient_acknowledged:false});
  expect(await acknowledgeOperatingAlert(s.env,episode.dedupe_key,{notification_id:original.notification_id,payload_hash:original.payload_hash,actor_ref:'owner',evidence_ref:'owner-confirmation',observed_at:new Date().toISOString()})).toMatchObject({state:'acknowledged'});
  expect(a.send).toHaveBeenCalledTimes(1);expect((await readOperatingAlert(s.env,episode.dedupe_key))?.history).toHaveLength(original.history.length+2);
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

it('ordinary Treasury receipts use INFO and the original queue, delivery and ACK identity',async()=>{
  const s=fixture(),e=treasuryEpisode();await enqueueOperatingAlert(s.env,e,dest);const original=(await readOperatingAlert(s.env,e.dedupe_key))!;
  expect(original.episode.severity).toBe('INFO');const a=exactAdapter('provider_accepted');await processOperatingAlert(s.env,e.dedupe_key,a);
  const accepted=(await readOperatingAlert(s.env,e.dedupe_key))!;a.readOriginal=vi.fn(async()=>({...accepted.receipt!,status:'delivered' as const}));
  expect(await processOperatingAlert(s.env,e.dedupe_key,a)).toMatchObject({state:'delivered',recipient_acknowledged:false});
  const delivered=(await readOperatingAlert(s.env,e.dedupe_key))!;expect(delivered.notification_id).toBe(original.notification_id);expect(delivered.payload_hash).toBe(original.payload_hash);
  await acknowledgeOperatingAlert(s.env,e.dedupe_key,{notification_id:delivered.notification_id,payload_hash:delivered.payload_hash,actor_ref:'owner',evidence_ref:'explicit-ack',observed_at:new Date().toISOString()});
  expect(await enqueueOperatingAlert(s.env,e,dest)).toMatchObject({state:'suppressed'});expect(a.send).toHaveBeenCalledTimes(1);
  expect('receipt'in delivered.episode&&delivered.episode.receipt.customer_revenue).toBe('UNKNOWN');
});
it('a receipt replay cannot silently replace original financial evidence, even after ACK',async()=>{
  const s=fixture(),e=treasuryEpisode();await enqueueOperatingAlert(s.env,e,dest);const r=(await readOperatingAlert(s.env,e.dedupe_key))!;
  await acknowledgeOperatingAlert(s.env,e.dedupe_key,{notification_id:r.notification_id,payload_hash:r.payload_hash,actor_ref:'owner',evidence_ref:'ack',observed_at:new Date().toISOString()});
  await expect(enqueueOperatingAlert(s.env,{...e,receipt:{...e.receipt,block_hash:`0x${'3'.repeat(64)}`}},dest)).rejects.toThrow('notification_receipt_conflict');
  expect((await readOperatingAlert(s.env,e.dedupe_key))?.payload_hash).toBe(r.payload_hash);
});
it('corrections have a separate message identity and cannot rewrite the original receipt',async()=>{
  const s=fixture(),e=treasuryEpisode();await enqueueOperatingAlert(s.env,e,dest);const original=(await readOperatingAlert(s.env,e.dedupe_key))!;
  const correction:TreasuryNotificationObservation={...e,code:'treasury_receipt_corrected',dedupe_key:'delta:treasury_receipt_corrected:receipt-1:correction-1',receipt:{...e.receipt,
    custody_revision:2,block_hash:`0x${'3'.repeat(64)}`,correction:{kind:'replaced',previous_block_hash:e.receipt.block_hash,previous_raw_amount:e.receipt.raw_amount}}};
  await enqueueOperatingAlert(s.env,correction,dest);const revised=(await readOperatingAlert(s.env,correction.dedupe_key))!;
  expect(revised.notification_id).not.toBe(original.notification_id);expect(await readOperatingAlert(s.env,e.dedupe_key)).toEqual(original);
});
it('re-observation preserves payment identity but creates an explicit separately deduplicated observation',async()=>{
  const s=fixture(),initial=treasuryEpisode();await enqueueOperatingAlert(s.env,initial,dest);const original=(await readOperatingAlert(s.env,initial.dedupe_key))!;
  const restored:TreasuryNotificationObservation={...initial,dedupe_key:'delta:treasury_received:receipt-1:observation-3',receipt:{...initial.receipt,
    occurrence:'reobserved_after_removal',custody_revision:3,custody_digest:'c'.repeat(64)}};
  await enqueueOperatingAlert(s.env,restored,dest);const row=(await readOperatingAlert(s.env,restored.dedupe_key))!;
  expect(row.notification_id).not.toBe(original.notification_id);expect('receipt'in row.episode&&row.episode.receipt.receipt_id).toBe(initial.receipt.receipt_id);
  await enqueueOperatingAlert(s.env,restored,dest);expect(await readOperatingAlert(s.env,restored.dedupe_key)).toEqual(row);
  expect(await readOperatingAlert(s.env,initial.dedupe_key)).toEqual(original);
});
it.each(['missing','invalid','correction'])('receipt occurrence fails closed for %s metadata',async kind=>{
  const s=fixture(),e:any=treasuryEpisode();
  if(kind==='missing')delete e.receipt.occurrence;if(kind==='invalid')e.receipt.occurrence='new_payment';
  if(kind==='correction'){e.code='treasury_receipt_corrected';e.receipt.occurrence='reobserved_after_removal';
    e.receipt.correction={kind:'removed',previous_block_hash:e.receipt.block_hash,previous_raw_amount:e.receipt.raw_amount};}
  await expect(enqueueOperatingAlert(s.env,e,dest)).rejects.toThrow('alert_input_invalid');expect(s.bucket.values.size).toBe(0);
});
it.each(['extra','chain','asset','recipient','tx','receipt-id','amount','decimal','over-uint256','negative-log','unsafe-block','confirmations','future-source','unbounded-ref','fake-revenue','fake-cost','fake-margin','severity','stage','bad-correction'])('receipt allowlist rejects %s before storage',async kind=>{
  const s=fixture(),e:any=treasuryEpisode(),r=e.receipt;
  if(kind==='extra')r.private_url='https://private.example/order';if(kind==='chain')r.network='eip155:84532';if(kind==='asset')r.asset=`0x${'f'.repeat(40)}`;
  if(kind==='recipient')r.treasury=`0x${'f'.repeat(40)}`;if(kind==='tx')r.tx_hash+='\nsecret';if(kind==='receipt-id')r.receipt_id+='different';
  if(kind==='amount')r.raw_amount='01';if(kind==='decimal')r.usdc_decimal='1.000000';if(kind==='over-uint256')r.raw_amount=(1n<<256n).toString();
  if(kind==='negative-log')r.log_index=-1;if(kind==='unsafe-block')r.block_number=Number.MAX_SAFE_INTEGER+1;if(kind==='confirmations')r.confirmation_depth=0;
  if(kind==='future-source')r.observed_at=new Date(now+1).toISOString();if(kind==='unbounded-ref')e.evidence_ref='https://private.example';
  if(kind==='fake-revenue')r.customer_revenue='1';if(kind==='fake-cost')r.actual_cost='0';if(kind==='fake-margin')r.contribution_margin='1';
  if(kind==='severity')e.severity='SEV1';if(kind==='stage')e.stage='escalated';if(kind==='bad-correction')r.correction={kind:'removed',previous_block_hash:r.block_hash,previous_raw_amount:r.raw_amount};
  await expect(enqueueOperatingAlert(s.env,e,dest)).rejects.toThrow('alert_input_invalid');expect(s.bucket.values.size).toBe(0);
});
it('uint256 amounts retain exact six-decimal precision beyond Number safe integer',()=>{
  const e=treasuryEpisode(),raw=((1n<<256n)-1n).toString();e.receipt.raw_amount=raw;e.receipt.usdc_decimal=`${BigInt(raw)/1000000n}.${(BigInt(raw)%1000000n).toString().padStart(6,'0')}`;
  expect(validOperatingNotification(e)).toBe(true);e.receipt.usdc_decimal=String(Number(raw)/1000000);expect(validOperatingNotification(e)).toBe(false);
});
it('a removed receipt describes only the prior observation and receipt data cannot enter a fault record',()=>{
  const e=treasuryEpisode();e.code='treasury_receipt_corrected';e.dedupe_key='delta:treasury_receipt_corrected:receipt-1:correction-1';
  e.receipt.correction={kind:'removed',previous_block_hash:e.receipt.block_hash,previous_raw_amount:e.receipt.raw_amount};
  expect(validOperatingNotification(e)).toBe(true);e.receipt.raw_amount='0';e.receipt.usdc_decimal='0.000000';expect(validOperatingNotification(e)).toBe(false);
  expect(validOperatingNotification({...episode,receipt:e.receipt})).toBe(false);expect(validOperatingNotification({...episode,severity:'INFO'})).toBe(false);
});
it.each(['nohumans_platform_verification','payapi_platform_verification'] as const)('known %s is explicitly excluded, never UNKNOWN or recognized revenue',payer_classification=>{
  const e=treasuryEpisode();e.receipt.payer_classification=payer_classification;
  expect(validOperatingNotification(e)).toBe(false);e.receipt.customer_revenue='EXCLUDED';expect(validOperatingNotification(e)).toBe(true);
  e.receipt.payer_classification='unclassified';expect(validOperatingNotification(e)).toBe(false);
  (e.receipt as any).payer_classification='independent_customer';expect(validOperatingNotification(e)).toBe(false);
});
