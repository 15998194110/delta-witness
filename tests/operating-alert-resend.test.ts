import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createResendAlertAdapter,resendAlertConfigurationDigest,RESEND_ALERT_PREFIX,type ResendAlertConfig} from '../src/operating-alert-resend';
import {enqueueOperatingAlert,processOperatingAlert,readOperatingAlert,type AlertObservation,type TreasuryNotificationObservation} from '../src/operating-alert-outbox';
import {MemoryBucket,orderRuntime} from './helpers/order-runtime';
import {processOwnerAlertQueue,type OwnerAlertDeliveryEnv,ALERT_DELIVERY_PREFIX,ALERT_DELIVERY_LIMITS} from '../src/operating-alert-delivery';
import {receiveResendAlertWebhook,ALERT_WEBHOOK_PREFIX} from '../src/operating-alert-webhook';

const now=Date.parse('2026-11-04T00:00:00.000Z');
const episode:AlertObservation={dedupe_key:'delta:paid_undelivered:order-1:episode-1',code:'paid_undelivered',subject:'order-1',severity:'SEV1',stage:'initial',
  first_seen_at:new Date(now-600000).toISOString(),evidence_ref:'original-paid-order'};
const providerID='11111111-1111-4111-8111-111111111111';
function receiptEpisode():TreasuryNotificationObservation{const tx=`0x${'1'.repeat(64)}`;
  return{dedupe_key:'delta:treasury_received:receipt-1:observation-1',code:'treasury_received',subject:'receipt-1',severity:'INFO',stage:'initial',
    first_seen_at:new Date(now-1000).toISOString(),evidence_ref:'custody-original-1',receipt:{network:'eip155:8453',occurrence:'initial_observation',asset:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      treasury:'0x1990e21bc219696ff7fbc26527dbaed335ac6367',receipt_id:`eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:${tx}:2`,tx_hash:tx,log_index:2,
      block_number:123456,block_hash:`0x${'2'.repeat(64)}`,raw_amount:'1000001',usdc_decimal:'1.000001',confirmation_depth:12,observed_at:new Date(now-1000).toISOString(),
      custody_revision:1,custody_digest:'a'.repeat(64),payer_classification:'unclassified',customer_revenue:'UNKNOWN',actual_cost:'UNKNOWN',contribution_margin:'UNKNOWN',fulfillment:'UNKNOWN',correction:null}};
}
const webhookSecret=`whsec_${btoa('isolated-synthetic-key-32-bytes!!!')}`;
async function webhookRequest(value:unknown,id='msg_original_event',time=Math.floor(Date.now()/1000),secret=webhookSecret){
  const body=JSON.stringify(value),key=await crypto.subtle.importKey('raw',Uint8Array.from(atob(secret.slice(6)),c=>c.charCodeAt(0)),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const mac=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${id}.${time}.${body}`)));
  return new Request('https://delta.example/internal/operations/alerts/resend-webhook',{method:'POST',headers:{'content-type':'application/json','svix-id':id,'svix-timestamp':String(time),'svix-signature':`v1,${btoa(String.fromCharCode(...mac))}`},body});
}
function webhookEnv(s:Awaited<ReturnType<typeof fixture>>){return {...s.env,OPERATIONS_CLOUD_ENABLED:'true',OPERATIONS_ALERT_OUTBOX_ENABLED:'true',OPERATIONS_ALERT_DELIVERY_ENABLED:'true',OPERATIONS_ALERT_WEBHOOK_ENABLED:'true',OPERATIONS_ALERT_RESEND_WEBHOOK_SECRET:webhookSecret,
  OPERATIONS_ALERT_RESEND_FROM:s.config.from,OPERATIONS_ALERT_RESEND_TO:s.config.to,OPERATIONS_ALERT_DESTINATION_ID:s.config.destination_id,OPERATIONS_ALERT_DESTINATION_DIGEST:s.config.destination_digest,
  OPERATIONS_ALERT_RESEND_APPROVED_CONFIGURATION_DIGEST:s.config.approved_configuration_digest,OPERATIONS_ALERT_RESEND_APPROVAL_EVIDENCE_REF:s.config.approval_evidence_ref};}
function webhookEvent(s:Awaited<ReturnType<typeof fixture>>){const e=s.emails.get(providerID);return {type:'email.delivered',created_at:new Date().toISOString(),data:{email_id:providerID,created_at:e.created_at,from:e.from,to:e.to,subject:e.subject,tags:Object.fromEntries(e.tags.map((t:any)=>[t.name,t.value]))}};}
async function fixture(){
  const bucket=new MemoryBucket(),env=orderRuntime(bucket),emails=new Map<string,any>(),posts:any[]=[];
  const config:ResendAlertConfig={enabled:true,api_key:'re_fixture_private_runtime_only',from:'alerts@delta.example',to:'owner@inbox.example',destination_id:'approved-owner-email',
    destination_digest:'',approved_configuration_digest:'',approval_evidence_ref:'owner-approval-private-reference'};
  config.destination_digest=await resendAlertConfigurationDigest(config);config.approved_configuration_digest=config.destination_digest;
  const native=(id:string,input:any,event='sent')=>({object:'email',id,...input,html:null,cc:[],bcc:[],reply_to:[],created_at:new Date().toISOString(),last_event:event});
  const network=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input);expect(url.startsWith('https://api.resend.com/')).toBe(true);expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${config.api_key}`);
    if(url.endsWith('/domains?limit=100'))return Response.json({object:'list',has_more:false,data:[{name:'delta.example',status:'verified',capabilities:{sending:'enabled'}}]});
    if(url.endsWith('/emails?limit=1'))return Response.json({object:'list',has_more:emails.size>1,data:[...emails.values()].slice(0,1)});
    if(url.includes('/emails?limit=100'))return Response.json({object:'list',has_more:false,data:[...emails.values()].map(({id,from,to,subject,created_at,last_event})=>({id,from,to,subject,created_at,last_event}))});
    if(init?.method==='POST'){
      const body=JSON.parse(String(init.body));posts.push(body);expect(new Headers(init.headers).get('idempotency-key')).toMatch(/^delta-alert\/[0-9a-f-]{36}$/);
      const id=emails.size===0?providerID:`22222222-2222-4222-8222-${String(posts.length).padStart(12,'0')}`;
      emails.set(id,native(id,body));return Response.json({id});
    }
    const email=emails.get(url.split('/').at(-1)!);return email?Response.json(email):Response.json({name:'not_found'},{status:404});
  });
  const adapter=()=>createResendAlertAdapter(env,config,{fetch:network as typeof fetch});
  const enqueue=()=>enqueueOperatingAlert(env,episode,{id:config.destination_id,digest:config.destination_digest});
  return{bucket,env,emails,posts,config,network,adapter,enqueue,native};
}
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);vi.stubGlobal('fetch',vi.fn(()=>{throw Error('unexpected_real_transport');}));});
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});

it('legacy fault message bytes, request hash and original ID remain compatible with a54d095',async()=>{
  const s=await fixture();await s.enqueue();const a=(await s.adapter())!;await processOperatingAlert(s.env,episode.dedupe_key,a);
  const row=JSON.parse([...s.bucket.values.entries()].find(([key])=>key.startsWith(RESEND_ALERT_PREFIX))![1].text);
  expect(row.notification_id).toBe('4159cdbe-5d0f-5272-ad95-d778e097434c');
  expect(row.payload_hash).toBe('sha256:8662fc1be5b87570b03a32c5fac3945b54ce453f3d0b8e4c159cda4fa41ecd8a');
  expect(row.request_hash).toBe('sha256:b9200621f1ae7a6fb5e35f872a3bdfcf5389f08bf34322bf85e3db99a5920850');
  s.emails.get(providerID).last_event='delivered';expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'delivered'});expect(s.posts).toHaveLength(1);
});
it('normal receipt email states exact public funds evidence and UNKNOWN revenue without a fault label',async()=>{
  const s=await fixture(),e=receiptEpisode();await enqueueOperatingAlert(s.env,e,{id:s.config.destination_id,digest:s.config.destination_digest});const a=(await s.adapter())!;
  expect(await processOperatingAlert(s.env,e.dedupe_key,a)).toMatchObject({state:'provider_accepted',recipient_acknowledged:false});const body=s.posts[0];
  expect(body.subject).toContain('Treasury observed 1.000001 USDC receipt');expect(body.subject).not.toMatch(/SEV|alert|incident/);
  for(const text of ['1000001 raw, 6 decimals',e.receipt.treasury,`https://basescan.org/tx/${e.receipt.tx_hash}`,'Log index: 2','not absolute finality',
    'Buyer attribution: UNKNOWN','Fulfillment: UNKNOWN','Customer revenue: UNKNOWN','Actual cost: UNKNOWN','Contribution margin: UNKNOWN'])expect(body.text).toContain(text);
  expect(body.text).not.toContain('https://delta-witness-api');s.emails.get(providerID).last_event='delivered';
  expect(await processOperatingAlert(s.env,e.dedupe_key,a)).toMatchObject({state:'delivered',recipient_acknowledged:false});expect(s.posts).toHaveLength(1);
  const stored=JSON.stringify([...s.bucket.values.values()]);expect(stored).not.toContain(s.config.api_key);expect(stored).not.toContain(s.config.to);
});
it.each(['unclassified','payapi_platform_verification'] as const)('re-observed receipt is expressly not another payment with %s attribution',async payer_classification=>{
  const s=await fixture(),e=receiptEpisode();e.receipt.occurrence='reobserved_after_removal';e.receipt.custody_revision=3;e.receipt.payer_classification=payer_classification;
  e.receipt.customer_revenue=payer_classification==='unclassified'?'UNKNOWN':'EXCLUDED';e.dedupe_key='delta:treasury_received:receipt-1:observation-3';
  await enqueueOperatingAlert(s.env,e,{id:s.config.destination_id,digest:s.config.destination_digest});const a=(await s.adapter())!;
  await processOperatingAlert(s.env,e.dedupe_key,a);const body=s.posts[0];
  expect(body.subject).toContain('re-observed previous receipt - NOT another payment');expect(body.text).toContain('restored / re-observed previous receipt - NOT another payment');
  expect(body.text).toContain('Observed amount: 1.000001 USDC');expect(body.text).toContain('Deduplicate payments by network/token/transaction/log index, not notification ID.');
  expect(body.text).toContain(`Customer revenue: ${e.receipt.customer_revenue}`);expect(body.text).toContain('Actual cost: UNKNOWN');expect(body.text).toContain('Contribution margin: UNKNOWN');
  expect(body.text).toContain(`https://basescan.org/tx/${e.receipt.tx_hash}`);s.emails.get(providerID).last_event='delivered';
  expect(await processOperatingAlert(s.env,e.dedupe_key,a)).toMatchObject({state:'delivered',recipient_acknowledged:false});expect(s.posts).toHaveLength(1);
});
it.each(['removed','replaced'] as const)('receipt %s mail is an explicit correction, never a second receipt or revenue',async kind=>{
  const s=await fixture(),e=receiptEpisode(),previous=e.receipt.block_hash;
  e.code='treasury_receipt_corrected';e.dedupe_key='delta:treasury_receipt_corrected:receipt-1:correction-1';
  e.receipt.correction={kind,previous_block_hash:previous,previous_raw_amount:e.receipt.raw_amount};if(kind==='replaced')e.receipt.block_hash=`0x${'3'.repeat(64)}`;
  await enqueueOperatingAlert(s.env,e,{id:s.config.destination_id,digest:s.config.destination_digest});await processOperatingAlert(s.env,e.dedupe_key,(await s.adapter())!);
  expect(s.posts[0].subject).toContain('receipt correction');expect(s.posts[0].subject).not.toContain('Treasury received');
  expect(s.posts[0].text).toContain('NOT a new incoming payment');expect(s.posts[0].text).toContain(`Correction: ${kind}`);expect(s.posts[0].text).toContain(previous);
  expect(s.posts[0].text).toContain('Customer revenue: UNKNOWN');expect(s.posts[0].text).toContain(kind==='removed'?'historical, not a current receipt':'do not count it as another payment');
});
it('receipt email lost POST response resolves exact original content without a new send',async()=>{
  const s=await fixture(),e=receiptEpisode(),normal=s.network.getMockImplementation()!;
  await enqueueOperatingAlert(s.env,e,{id:s.config.destination_id,digest:s.config.destination_digest});
  s.network.mockImplementation(async(input,init)=>{const response=await normal(input,init);if(init?.method==='POST')throw Error('lost-receipt-ACK');return response;});
  const a=(await s.adapter())!;expect(await processOperatingAlert(s.env,e.dedupe_key,a)).toMatchObject({state:'unconfirmed'});
  s.emails.get(providerID).last_event='delivered';expect(await processOperatingAlert(s.env,e.dedupe_key,a)).toMatchObject({state:'delivered'});expect(s.posts).toHaveLength(1);
});
it('receipt event retains the same authenticated provider webhook binding and no automatic owner ACK',async()=>{
  const s=await fixture(),e=receiptEpisode();await enqueueOperatingAlert(s.env,e,{id:s.config.destination_id,digest:s.config.destination_digest});
  await processOperatingAlert(s.env,e.dedupe_key,(await s.adapter())!);
  const response=await receiveResendAlertWebhook(webhookEnv(s),await webhookRequest(webhookEvent(s)));
  expect(response.status).toBe(200);expect((await readOperatingAlert(s.env,e.dedupe_key))?.acknowledgment).toBeNull();expect(s.posts).toHaveLength(1);
});
it.each(['nohumans_platform_verification','payapi_platform_verification'] as const)('known %s receipt is disclosed and excluded from customer revenue',async payer_classification=>{
  const s=await fixture(),e=receiptEpisode();e.receipt.payer_classification=payer_classification;e.receipt.customer_revenue='EXCLUDED';
  await enqueueOperatingAlert(s.env,e,{id:s.config.destination_id,digest:s.config.destination_digest});await processOperatingAlert(s.env,e.dedupe_key,(await s.adapter())!);
  expect(s.posts[0].text).toContain(`Buyer attribution: ${payer_classification}`);expect(s.posts[0].text).toContain('platform verification; excluded from customer revenue');
  expect(s.posts[0].text).toContain('Customer revenue: EXCLUDED');expect(s.posts[0].text).toContain('Actual cost: UNKNOWN');expect(s.posts[0].text).toContain('Contribution margin: UNKNOWN');
});

it('disabled or unapproved transport never sends, reads credentials from disk or invents provider permission',async()=>{
  const s=await fixture();s.config.enabled=false;expect(await s.adapter()).toBeNull();expect(s.network).not.toHaveBeenCalled();expect(s.bucket.values.size).toBe(0);
  s.config.enabled=true;s.config.approved_configuration_digest=`sha256:${'a'.repeat(64)}`;
  await expect(s.adapter()).rejects.toThrow('resend_alert_approval_missing');expect(s.network).not.toHaveBeenCalled();
});
it.each(['invalid-token','recipient-change','sender-injection'])('invalid exact approved configuration fails before transport (%s)',async kind=>{
  const s=await fixture();if(kind==='invalid-token')s.config.api_key='not-valid';if(kind==='recipient-change')s.config.to='different@inbox.example';if(kind==='sender-injection')s.config.from='owner@delta.example\nBcc: other@inbox.example';
  await expect(s.adapter()).rejects.toThrow();expect(s.network).not.toHaveBeenCalled();
});
it.each(['permission-denied','unverified-domain','sending-disabled'])('native provider %s blocks sending',async kind=>{
  const s=await fixture(),normal=s.network.getMockImplementation()!;
  s.network.mockImplementation(async(input,init)=>{
    if(kind==='permission-denied')return Response.json({name:'restricted_api_key'},{status:401});
    if(String(input).includes('/domains'))return Response.json({object:'list',has_more:false,data:[{name:'delta.example',status:kind==='unverified-domain'?'pending':'verified',capabilities:{sending:kind==='sending-disabled'?'disabled':'enabled'}}]});
    return normal(input,init);
  });await expect(s.adapter()).rejects.toThrow();expect(s.posts).toHaveLength(0);
});
it('persists intent before a real-shaped provider POST and keeps accepted, delivered and owner ACK separate',async()=>{
  const s=await fixture();await s.enqueue();const a=(await s.adapter())!;
  expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'provider_accepted',recipient_acknowledged:false});
  expect(s.posts).toHaveLength(1);const original=await readOperatingAlert(s.env,episode.dedupe_key);
  expect(original?.receipt?.status).toBe('provider_accepted');s.emails.get(providerID).last_event='delivered';
  expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'delivered',recipient_acknowledged:false});expect(s.posts).toHaveLength(1);
  const stored=JSON.stringify([...s.bucket.values.values()]);expect(stored).not.toContain(s.config.api_key);expect(stored).not.toContain(s.config.from);expect(stored).not.toContain(s.config.to);
  expect([...s.bucket.values.keys()].filter(k=>k.startsWith(RESEND_ALERT_PREFIX))).toHaveLength(1);expect(s.env.BROWSER.quickAction).not.toHaveBeenCalled();
});
it('two concrete dispatchers cannot produce a second provider POST',async()=>{
  const s=await fixture();await s.enqueue();const a=(await s.adapter())!;
  await Promise.all([processOperatingAlert(s.env,episode.dedupe_key,a),processOperatingAlert(s.env,episode.dedupe_key,a)]);expect(s.posts).toHaveLength(1);
});
it('lost POST ACK is recovered by bounded native list and exact original content without another POST',async()=>{
  const s=await fixture(),normal=s.network.getMockImplementation()!;await s.enqueue();
  s.network.mockImplementation(async(input,init)=>{const response=await normal(input,init);if(init?.method==='POST')throw Error('simulated-lost-ACK-provider-secret');return response;});
  const a=(await s.adapter())!;expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'unconfirmed'});
  s.emails.get(providerID).last_event='delivered';expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'delivered'});expect(s.posts).toHaveLength(1);
  expect(JSON.stringify([...s.bucket.values.values()])).not.toContain('provider-secret');
});
it('a missing or truncated original after unknown POST never authorizes retry, including after key expiry',async()=>{
  const s=await fixture(),normal=s.network.getMockImplementation()!;await s.enqueue();
  s.network.mockImplementation(async(input,init)=>{if(init?.method==='POST'){s.posts.push(JSON.parse(String(init.body)));throw Error('transport-unknown');}return normal(input,init);});
  let a=(await s.adapter())!;await processOperatingAlert(s.env,episode.dedupe_key,a);for(let n=0;n<3;n++)expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'unconfirmed'});
  vi.setSystemTime(now+25*3600000);a=(await s.adapter())!;expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'unconfirmed'});expect(s.posts).toHaveLength(1);
});
it.each(['text','tags','recipient','cc','future-created','duplicate'])('native original mismatch cannot confirm delivery (%s)',async kind=>{
  const s=await fixture();await s.enqueue();const a=(await s.adapter())!;await processOperatingAlert(s.env,episode.dedupe_key,a);
  const value=s.emails.get(providerID);value.last_event='delivered';if(kind==='text')value.text+=' altered';if(kind==='tags')value.tags[0].value=crypto.randomUUID();
  if(kind==='recipient')value.to=['other@inbox.example'];if(kind==='cc')value.cc=['other@inbox.example'];if(kind==='future-created')value.created_at=new Date(now+1).toISOString();
  if(kind==='duplicate'){const key=[...s.bucket.values.keys()].find(k=>k.startsWith(RESEND_ALERT_PREFIX))!,stored=s.bucket.values.get(key)!;
    const record=JSON.parse(stored.text);record.provider_email_id=null;record.state='unknown';await s.bucket.put(key,JSON.stringify(record));
    s.emails.set('22222222-2222-4222-8222-222222222222',{...value,id:'22222222-2222-4222-8222-222222222222'});}
  expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'unconfirmed'});expect(s.posts).toHaveLength(1);expect((await readOperatingAlert(s.env,episode.dedupe_key))?.state).toBe('provider_accepted');
});
it.each(['bounced','failed','canceled','suppressed'])('native %s is delivery failure, not non-application or automatic resend',async event=>{
  const s=await fixture();await s.enqueue();const a=(await s.adapter())!;await processOperatingAlert(s.env,episode.dedupe_key,a);s.emails.get(providerID).last_event=event;
  expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'failed'});
  const row=await readOperatingAlert(s.env,episode.dedupe_key);expect(row?.receipt?.status).toBe('failed');await processOperatingAlert(s.env,episode.dedupe_key,a);expect(s.posts).toHaveLength(1);
});
it('native opened/clicked does not become human acknowledgment',async()=>{
  const s=await fixture();await s.enqueue();const a=(await s.adapter())!;await processOperatingAlert(s.env,episode.dedupe_key,a);s.emails.get(providerID).last_event='opened';
  expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'provider_accepted',recipient_acknowledged:false});expect((await readOperatingAlert(s.env,episode.dedupe_key))?.acknowledgment).toBeNull();
});
it('one explicit rate rejection can retry only the same payload/key after original GET readback',async()=>{
  const s=await fixture(),normal=s.network.getMockImplementation()!;await s.enqueue();let first=true;
  s.network.mockImplementation(async(input,init)=>{if(init?.method==='POST'&&first){first=false;s.posts.push(JSON.parse(String(init.body)));return Response.json({name:'rate_limit_exceeded'},{status:429,headers:{'retry-after':'0'}});}return normal(input,init);});
  const a=(await s.adapter())!;expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'provider_accepted'});expect(s.posts).toHaveLength(2);expect(s.posts[0]).toEqual(s.posts[1]);
  const paths=s.network.mock.calls.map(([input,init])=>[String(input),init?.method]);const firstPost=paths.findIndex(([,method])=>method==='POST');
  expect(paths.slice(firstPost+1,-1).some(([path])=>String(path).includes('/emails?limit=100'))).toBe(true);
});
it.each(['rate_limit_exceeded','daily_quota_exceeded','monthly_quota_exceeded'])('explicit %s retries are bounded and never upgrade quota',async name=>{
  const s=await fixture(),normal=s.network.getMockImplementation()!;await s.enqueue();s.network.mockImplementation(async(input,init)=>{
    if(init?.method==='POST'){s.posts.push(JSON.parse(String(init.body)));return Response.json({name},{status:429,headers:{'retry-after':'0'}});}return normal(input,init);});
  const a=(await s.adapter())!;expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'failed'});expect(s.posts).toHaveLength(name==='rate_limit_exceeded'?2:1);
  expect((await readOperatingAlert(s.env,episode.dedupe_key))?.receipt?.status).toBe('not_applied');await processOperatingAlert(s.env,episode.dedupe_key,a);expect(s.posts).toHaveLength(name==='rate_limit_exceeded'?2:1);
});
it.each([409,500,503])('HTTP %s remains unknown and is never blindly re-POSTed',async status=>{
  const s=await fixture(),normal=s.network.getMockImplementation()!;await s.enqueue();s.network.mockImplementation(async(input,init)=>{
    if(init?.method==='POST'){s.posts.push(JSON.parse(String(init.body)));return Response.json({name:status===409?'concurrent_idempotent_requests':'application_error',message:'private-provider-text'},{status});}return normal(input,init);});
  const a=(await s.adapter())!;await processOperatingAlert(s.env,episode.dedupe_key,a);await processOperatingAlert(s.env,episode.dedupe_key,a);expect(s.posts).toHaveLength(1);
  expect(JSON.stringify([...s.bucket.values.values()])).not.toContain('private-provider-text');
});
it('lost transport POST-claim ACK grants no network POST and no fresh identity',async()=>{
  const s=await fixture();await s.enqueue();const put=s.bucket.put.bind(s.bucket);let once=true;
  s.bucket.put=async(k,v,o)=>{const saved=await put(k,v,o);if(once&&k.startsWith(RESEND_ALERT_PREFIX)&&JSON.parse(String(v)).state==='posting'){once=false;throw Error('lost-transport-claim');}return saved;};
  const a=(await s.adapter())!;await processOperatingAlert(s.env,episode.dedupe_key,a);await processOperatingAlert(s.env,episode.dedupe_key,a);expect(s.posts).toHaveLength(0);
});
it('late POST response after local deadline cannot persist delivery or create another send',async()=>{
  const s=await fixture(),normal=s.network.getMockImplementation()!;await s.enqueue();const a=(await s.adapter())!;
  let release!:(response:Response)=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
  s.network.mockImplementation(async(input,init)=>{if(init?.method==='POST'){await normal(input,init);entered();return new Promise(resolve=>{release=resolve;});}return normal(input,init);});
  vi.useRealTimers();vi.useFakeTimers();vi.setSystemTime(now);const pending=processOperatingAlert(s.env,episode.dedupe_key,a);await ready;
  await vi.advanceTimersByTimeAsync(2001);expect(await pending).toMatchObject({state:'unconfirmed'});release(Response.json({id:providerID}));await vi.advanceTimersByTimeAsync(1);
  expect((await readOperatingAlert(s.env,episode.dedupe_key))?.state).toBe('unconfirmed');s.emails.get(providerID).last_event='delivered';
  expect(await processOperatingAlert(s.env,episode.dedupe_key,a)).toMatchObject({state:'delivered'});expect(s.posts).toHaveLength(1);
});
it.each(['redirect','non-json','oversized'])('native %s is rejected without disclosing token or provider body',async kind=>{
  const s=await fixture();s.network.mockImplementation(async()=>kind==='redirect'?new Response(null,{status:302,headers:{location:'https://other.example'}}):
    kind==='non-json'?new Response('provider private detail'):new Response(' '.repeat(131073),{headers:{'content-type':'application/json'}}));
  await expect(s.adapter()).rejects.toThrow('resend_alert_http_unconfirmed');expect(s.posts).toHaveLength(0);
});

function deliveryEnv(s:Awaited<ReturnType<typeof fixture>>):OwnerAlertDeliveryEnv{
  Object.assign(s.env.PROOFS,{list:async(options:R2ListOptions={})=>{
    const all=[...s.bucket.values.keys()].filter(key=>key.startsWith(options.prefix??'')).sort(),offset=options.cursor?Number(options.cursor.split(':')[1]):0;
    const selected=all.slice(offset,offset+(options.limit??1000)),truncated=offset+selected.length<all.length;
    return{objects:selected.map(key=>({key})),truncated,...(truncated?{cursor:`fixture:${offset+selected.length}`}:{})};
  }});
  return{...s.env,OPERATIONS_CLOUD_ENABLED:'true',OPERATIONS_ALERT_OUTBOX_ENABLED:'true',OPERATIONS_ALERT_DELIVERY_ENABLED:'true',
    OPERATIONS_ALERT_RESEND_API_KEY:s.config.api_key,OPERATIONS_ALERT_RESEND_FROM:s.config.from,OPERATIONS_ALERT_RESEND_TO:s.config.to,
    OPERATIONS_ALERT_DESTINATION_ID:s.config.destination_id,OPERATIONS_ALERT_DESTINATION_DIGEST:s.config.destination_digest,
    OPERATIONS_ALERT_RESEND_APPROVED_CONFIGURATION_DIGEST:s.config.approved_configuration_digest,OPERATIONS_ALERT_RESEND_APPROVAL_EVIDENCE_REF:s.config.approval_evidence_ref};
}
it('actual queue consumer stays default-off without provider or storage IO',async()=>{
  const s=await fixture(),env=deliveryEnv(s);delete env.OPERATIONS_ALERT_DELIVERY_ENABLED;const get=vi.spyOn(s.bucket,'get');
  expect(await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch})).toMatchObject({state:'disabled',provider_calls:0});
  expect(get).not.toHaveBeenCalled();expect(s.network).not.toHaveBeenCalled();expect(s.bucket.values.size).toBe(0);
});
it('queue consumer crosses bounded pages and later readback confirms original deliveries without new sends',async()=>{
  const s=await fixture(),env=deliveryEnv(s);for(let n=1;n<=3;n++)await enqueueOperatingAlert(env,{...episode,subject:`order-${n}`,dedupe_key:`delta:paid_undelivered:order-${n}:episode-${n}`},
    {id:s.config.destination_id,digest:s.config.destination_digest});
  expect(await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch})).toMatchObject({state:'observed',counts:{scanned:3,processed:3,provider_accepted:3},cursor_state:'advanced',notification_delivered:null});
  expect(await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch})).toMatchObject({state:'observed',counts:{scanned:3,processed:3,provider_accepted:3},cursor_state:'advanced'});
  expect(s.posts).toHaveLength(3);const cursor=JSON.parse(s.bucket.values.get(`${ALERT_DELIVERY_PREFIX}cursor.json`)!.text);expect(cursor).toMatchObject({version:2,cursor:null});
  for(const value of s.emails.values())value.last_event='delivered';
  expect(await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch})).toMatchObject({counts:{delivered:3},notification_delivered:null});expect(s.posts).toHaveLength(3);
  expect(await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch})).toMatchObject({counts:{delivered:0,terminal_delivered:3},counts_scope:'this_run_observations_not_cumulative'});
});
async function manyQueued(s:Awaited<ReturnType<typeof fixture>>,count:number){
  const env=deliveryEnv(s);for(let n=0;n<count;n++)await enqueueOperatingAlert(env,{...episode,subject:`batch-${n}`,dedupe_key:`delta:paid_undelivered:batch-${n}:original`},
    {id:s.config.destination_id,digest:s.config.destination_digest});
  return{env,rows:[...s.bucket.values.entries()].filter(([key])=>key.includes('/episodes/')).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>({key,row:JSON.parse(value.text)}))};
}
async function terminalRows(s:Awaited<ReturnType<typeof fixture>>,rows:Array<{row:any}>){
  const a={destination:{id:s.config.destination_id,digest:s.config.destination_digest},permission:{state:'available' as const,observed_at:new Date().toISOString(),evidence_ref:'synthetic-delivery-evidence'},
    send:async(op:any)=>({notification_id:op.notification_id,payload_hash:op.payload_hash,destination_digest:op.destination_digest,status:'delivered' as const,receipt_id:'synthetic-original-receipt',observed_at:new Date().toISOString()}),readOriginal:async()=>null};
  for(const {row} of rows)await processOperatingAlert(s.env,row.episode.dedupe_key,a);
}
it('twenty historical delivered records no longer consume the active budget ahead of four new notifications',async()=>{
  const s=await fixture(),{env,rows}=await manyQueued(s,24);await terminalRows(s,rows.slice(0,20));
  const result=await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch});
  expect(result).toMatchObject({state:'observed',counts:{scanned:24,processed:4,terminal_delivered:20,provider_accepted:4},active_attempts:4,scan_budget_limited:false});
  expect(s.posts).toHaveLength(4);expect(result.provider_calls).toBeLessThanOrEqual(ALERT_DELIVERY_LIMITS.provider_calls);
  expect('storage_reads'in result&&result.storage_reads).toBeLessThanOrEqual(ALERT_DELIVERY_LIMITS.storage_reads);
  expect('storage_bytes'in result&&result.storage_bytes).toBeLessThanOrEqual(ALERT_DELIVERY_LIMITS.storage_bytes);
});
it('active-send limit checkpoints the original page and subsequent invocation advances without repeating POST',async()=>{
  const s=await fixture(),{env}=await manyQueued(s,12);
  expect(await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch})).toMatchObject({state:'degraded',counts:{scanned:8,processed:8},active_attempts:8,scan_budget_limited:true,cursor_state:'advanced',remaining_inventory:'not_yet_scanned'});
  const first=new Set(s.posts.map(p=>p.tags.find((t:any)=>t.name==='delta_notification').value));expect(first.size).toBe(8);
  expect(await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch})).toMatchObject({state:'observed',counts:{scanned:4,processed:4},active_attempts:4,cursor_state:'advanced'});
  expect(s.posts).toHaveLength(12);expect(new Set(s.posts.map(p=>p.tags.find((t:any)=>t.name==='delta_notification').value)).size).toBe(12);
  expect(JSON.parse(s.bucket.values.get(`${ALERT_DELIVERY_PREFIX}cursor.json`)!.text)).toMatchObject({schema:'delta-alert-delivery-cursor/v1',version:2,cursor:null});
});
it('terminal history scanning itself remains bounded and does not masquerade as cumulative delivered totals',async()=>{
  const s=await fixture(),{env,rows}=await manyQueued(s,40);await terminalRows(s,rows);
  expect(await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch})).toMatchObject({state:'degraded',counts:{scanned:32,processed:0,terminal_delivered:32,delivered:0},active_attempts:0,scan_budget_limited:true,counts_scope:'this_run_observations_not_cumulative'});
  expect(await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch})).toMatchObject({state:'observed',counts:{scanned:8,processed:0,terminal_delivered:8,delivered:0}});
  expect(s.posts).toHaveLength(0);
});
it('working deadline preserves the partially examined page and late source reads cannot dispatch',async()=>{
  const s=await fixture(),{env,rows}=await manyQueued(s,5),get=s.bucket.get.bind(s.bucket),blocked=new Set(rows.slice(0,3).map(x=>x.key));
  const starts:Array<()=>void>=[],ready=Array.from({length:3},(_,n)=>new Promise<void>(resolve=>{starts[n]=resolve;})),releases:Array<()=>void>=[];let entered=0;
  s.bucket.get=async key=>{if(blocked.has(key)){starts[entered++]?.();await new Promise<void>(resolve=>releases.push(resolve));}return get(key);};
  vi.useRealTimers();vi.useFakeTimers();vi.setSystemTime(now);
  const pending=processOwnerAlertQueue(env,{fetch:s.network as typeof fetch});await ready[0];await vi.advanceTimersByTimeAsync(15001);
  await ready[1];await vi.advanceTimersByTimeAsync(15001);await ready[2];await vi.advanceTimersByTimeAsync(5001);
  const result=await pending;expect(result).toMatchObject({state:'degraded',scan_budget_limited:true,cursor_state:'advanced',counts:{unknown:3,processed:0},remaining_inventory:'not_yet_scanned'});
  expect(JSON.parse(s.bucket.values.get(`${ALERT_DELIVERY_PREFIX}cursor.json`)!.text).cursor).toBe('fixture:2');expect(s.posts).toHaveLength(0);
  blocked.clear();for(const release of releases)release();await vi.advanceTimersByTimeAsync(1);expect(s.posts).toHaveLength(0);
  expect(await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch})).toMatchObject({counts:{processed:3,provider_accepted:3},cursor_state:'advanced'});expect(s.posts).toHaveLength(3);
});
it('cyclic provider inventory cannot silently loop and preserves the original cursor',async()=>{
  const s=await fixture(),{env,rows}=await manyQueued(s,3);await terminalRows(s,rows);
  let calls=0;Object.assign(s.bucket,{list:async()=>({objects:[{key:rows[Math.min(calls++,2)].key}],truncated:true,cursor:'cyclic'})});
  expect(await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch})).toMatchObject({state:'unavailable'});
  expect(calls).toBe(2);expect(s.bucket.values.has(`${ALERT_DELIVERY_PREFIX}cursor.json`)).toBe(false);expect(s.posts).toHaveLength(0);
});
it('aggregate metadata byte limit retains progress uncertainty without removing valid oversized-history records',async()=>{
  const s=await fixture(),{env,rows}=await manyQueued(s,40);await terminalRows(s,rows);
  for(const {key} of rows){const value=s.bucket.values.get(key)!;s.bucket.values.set(key,{...value,text:value.text.padEnd(31999,' ')});}
  const originals=rows.map(({key})=>s.bucket.values.get(key)!.text),result=await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch});
  expect(result).toMatchObject({state:'degraded',notification_delivered:null});expect(result.counts.unknown).toBeGreaterThan(0);
  expect('storage_bytes'in result&&result.storage_bytes).toBeLessThanOrEqual(ALERT_DELIVERY_LIMITS.storage_bytes);
  expect('storage_reads'in result&&result.storage_reads).toBeLessThanOrEqual(ALERT_DELIVERY_LIMITS.storage_reads);
  expect('hole_refs'in result&&result.hole_refs.length).toBeGreaterThan(0);expect(rows.map(({key})=>s.bucket.values.get(key)!.text)).toEqual(originals);expect(s.posts).toHaveLength(0);
});
it('a temporary native permission/read rejection retains the cursor and recovers on a later invocation',async()=>{
  const s=await fixture(),env=deliveryEnv(s),normal=s.network.getMockImplementation()!;await s.enqueue();let unavailable=true;
  s.network.mockImplementation(async(input,init)=>unavailable?Response.json({name:'service_unavailable'},{status:503}):normal(input,init));
  expect(await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch})).toMatchObject({state:'unavailable'});
  expect(s.bucket.values.has(`${ALERT_DELIVERY_PREFIX}cursor.json`)).toBe(false);expect(s.posts).toHaveLength(0);unavailable=false;
  expect(await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch})).toMatchObject({state:'observed',counts:{provider_accepted:1}});expect(s.posts).toHaveLength(1);
});
it('native failed delivery remains degraded on later scans until explicit acknowledgment, without resending',async()=>{
  const s=await fixture(),env=deliveryEnv(s);await s.enqueue();
  await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch});s.emails.get(providerID).last_event='bounced';
  for(let n=0;n<2;n++)expect(await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch})).toMatchObject({state:'degraded',counts:{failed:1},notification_delivered:null});
  expect(s.posts).toHaveLength(1);expect((await readOperatingAlert(env,episode.dedupe_key))?.state).toBe('failed');
});
it('consumer revisits durable original unknowns without creating another notification or provider send',async()=>{
  const s=await fixture(),env=deliveryEnv(s),normal=s.network.getMockImplementation()!;await s.enqueue();
  s.network.mockImplementation(async(input,init)=>{if(init?.method==='POST'){s.posts.push(JSON.parse(String(init.body)));throw Error('unknown-post');}return normal(input,init);});
  for(let n=0;n<2;n++)expect(await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch})).toMatchObject({state:'degraded',counts:{unknown:1},notification_delivered:null});
  expect(s.posts).toHaveLength(1);expect((await readOperatingAlert(env,episode.dedupe_key))?.state).toBe('unconfirmed');
});
it('uncertain consumer observation write retains the input cursor and later retries only original readback',async()=>{
  const s=await fixture(),env=deliveryEnv(s);await s.enqueue();const put=s.bucket.put.bind(s.bucket);let once=true;
  s.bucket.put=async(k,v,o)=>{const saved=await put(k,v,o);if(once&&k.startsWith(`${ALERT_DELIVERY_PREFIX}runs/`)){once=false;throw Error('lost-run-observation-ack');}return saved;};
  expect(await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch})).toMatchObject({state:'unavailable'});
  expect(s.bucket.values.has(`${ALERT_DELIVERY_PREFIX}cursor.json`)).toBe(false);expect(s.posts).toHaveLength(1);
  expect(await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch})).toMatchObject({counts:{provider_accepted:1},cursor_state:'advanced'});expect(s.posts).toHaveLength(1);
});
it('confirmed immutable holes let the third episode progress and a later wrap recovers the same original identity',async()=>{
  const s=await fixture(),env=deliveryEnv(s);for(let n=1;n<=3;n++)await enqueueOperatingAlert(env,{...episode,subject:`order-${n}`,dedupe_key:`delta:paid_undelivered:order-${n}:episode-${n}`},
    {id:s.config.destination_id,digest:s.config.destination_digest});
  const first=[...s.bucket.values.keys()].filter(k=>k.includes('/episodes/')).sort()[0],get=s.bucket.get.bind(s.bucket);
  const original=s.bucket.values.get(first)!.text,originalIdentity=JSON.parse(original).notification_id;let stalled=true;
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});s.bucket.get=async key=>{
    if(stalled&&key===first){entered();await new Promise<void>(resolve=>{release=resolve;});}return get(key);};
  vi.useRealTimers();vi.useFakeTimers();vi.setSystemTime(now);const pending=processOwnerAlertQueue(env,{fetch:s.network as typeof fetch});await ready;
  await vi.advanceTimersByTimeAsync(15001);const firstPass=await pending;
  expect(firstPass).toMatchObject({state:'degraded',counts:{scanned:3,provider_accepted:2,unknown:1},cursor_state:'advanced',page_complete:false,unresolved_reference_count:1,inventory_complete:false});
  expect(firstPass).toHaveProperty('hole_refs');if(!('hole_refs'in firstPass))throw Error('missing-hole-evidence');expect(firstPass.hole_refs).toHaveLength(1);
  const holeText=s.bucket.values.get(firstPass.hole_refs[0].key)!.text,hole=JSON.parse(holeText);
  expect(hole).toMatchObject({original_key:first,phase:'reference_read',original_notification_id:null,original_payload_hash:null,dispatch_authority:false,retry_authority:false,recipient_acknowledged:false});
  expect(s.bucket.values.get(first)!.text).toBe(original);
  // The third original episode now progresses in this same bounded invocation.
  expect(s.posts).toHaveLength(2);
  release();await vi.advanceTimersByTimeAsync(1);expect(s.posts).toHaveLength(2);
  expect(s.bucket.values.get(first)!.text).toBe(original);stalled=false;
  expect(await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch})).toMatchObject({counts:{scanned:3,provider_accepted:3},cursor_state:'advanced'});
  const healed=JSON.parse(s.bucket.values.get(first)!.text);expect(healed.notification_id).toBe(originalIdentity);expect(healed.state).toBe('provider_accepted');
  expect(s.posts).toHaveLength(3);expect(new Set(s.posts.map(p=>p.tags.find((t:any)=>t.name==='delta_notification').value)).size).toBe(3);
  expect(s.bucket.values.get(firstPass.hole_refs[0].key)!.text).toBe(holeText);expect(s.env.BROWSER.quickAction).not.toHaveBeenCalled();
});
it.each(['write_not_applied','write_ack_lost','readback_unavailable'])('hole %s permits progress only after exact immutable readback',async mode=>{
  const s=await fixture(),env=deliveryEnv(s);for(let n=1;n<=3;n++)await enqueueOperatingAlert(env,{...episode,subject:`order-${n}`,dedupe_key:`delta:paid_undelivered:order-${n}:episode-${n}`},
    {id:s.config.destination_id,digest:s.config.destination_digest});
  const first=[...s.bucket.values.keys()].filter(k=>k.includes('/episodes/')).sort()[0],original=s.bucket.values.get(first)!;
  const corrupt=JSON.stringify({...JSON.parse(original.text),schema:'corrupt-original',extra:'must-not-copy-to-hole'});s.bucket.values.set(first,{...original,text:corrupt});
  const put=s.bucket.put.bind(s.bucket),get=s.bucket.get.bind(s.bucket);let holeWrites=0;
  s.bucket.put=async(k,v,o)=>{if(k.startsWith(`${ALERT_DELIVERY_PREFIX}holes/`)){holeWrites++;if(mode==='write_not_applied')return null;
    const saved=await put(k,v,o);if(mode==='write_ack_lost')throw Error('simulated-hole-ACK-loss-private-detail');return saved;}return put(k,v,o);};
  s.bucket.get=async k=>{if(mode==='readback_unavailable'&&k.startsWith(`${ALERT_DELIVERY_PREFIX}holes/`))throw Error('hole-storage-unavailable');return get(k);};
  const result=await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch});
  expect(result).toMatchObject({state:'degraded',page_complete:false,unresolved_reference_count:1,inventory_complete:false,cursor_state:mode==='write_ack_lost'?'advanced':'retained'});
  expect(holeWrites).toBe(1);expect(s.bucket.values.get(first)!.text).toBe(corrupt);expect(s.posts).toHaveLength(mode==='write_ack_lost'?2:1);
  if(!('hole_refs'in result))throw Error('missing-hole-result');expect(result.hole_refs).toHaveLength(mode==='write_ack_lost'?1:0);
  const holes=[...s.bucket.values.entries()].filter(([key])=>key.startsWith(`${ALERT_DELIVERY_PREFIX}holes/`));
  expect(JSON.stringify(holes)).not.toContain('must-not-copy-to-hole');expect(JSON.stringify(holes)).not.toContain('private-detail');
  if(mode==='write_ack_lost')expect(await processOwnerAlertQueue(env,{fetch:s.network as typeof fetch})).toMatchObject({counts:{scanned:3,provider_accepted:2,unknown:1}});
  else expect(s.bucket.values.has(`${ALERT_DELIVERY_PREFIX}cursor.json`)).toBe(false);
});
it('four-second hole timeout retains cursor and a late create cannot retroactively advance it',async()=>{
  const s=await fixture(),env=deliveryEnv(s);await s.enqueue();const first=[...s.bucket.values.keys()].find(k=>k.includes('/episodes/'))!,original=s.bucket.values.get(first)!;
  s.bucket.values.set(first,{...original,text:JSON.stringify({...JSON.parse(original.text),schema:'corrupt-original'})});
  const put=s.bucket.put.bind(s.bucket);let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
  s.bucket.put=async(k,v,o)=>{if(k.startsWith(`${ALERT_DELIVERY_PREFIX}holes/`)){entered();await new Promise<void>(resolve=>{release=resolve;});}return put(k,v,o);};
  vi.useRealTimers();vi.useFakeTimers();vi.setSystemTime(now);const pending=processOwnerAlertQueue(env,{fetch:s.network as typeof fetch});await ready;
  await vi.advanceTimersByTimeAsync(4001);expect(await pending).toMatchObject({state:'degraded',cursor_state:'retained',page_complete:false,hole_refs:[]});
  expect(s.bucket.values.has(`${ALERT_DELIVERY_PREFIX}cursor.json`)).toBe(false);release();await vi.advanceTimersByTimeAsync(1);
  expect(s.bucket.values.has(`${ALERT_DELIVERY_PREFIX}cursor.json`)).toBe(false);expect(s.posts).toHaveLength(0);
});

it('signed webhook records original provider evidence once, without sending, ACK or outbox promotion',async()=>{
  const s=await fixture();await s.enqueue();await processOperatingAlert(s.env,episode.dedupe_key,(await s.adapter())!);
  const original=await readOperatingAlert(s.env,episode.dedupe_key),event=webhookEvent(s),env=webhookEnv(s);s.network.mockClear();
  const responses=await Promise.all([receiveResendAlertWebhook(env,await webhookRequest(event)),receiveResendAlertWebhook(env,await webhookRequest(event))]);
  expect(responses.map(r=>r.status)).toEqual([200,200]);
  const keys=[...s.bucket.values.keys()].filter(k=>k.startsWith(ALERT_WEBHOOK_PREFIX));expect(keys).toHaveLength(1);
  expect(await readOperatingAlert(s.env,episode.dedupe_key)).toEqual(original);expect(s.network).not.toHaveBeenCalled();expect(s.posts).toHaveLength(1);
  const before=s.bucket.values.get(keys[0])!.text;vi.setSystemTime(now+60000);
  expect(await (await receiveResendAlertWebhook(env,await webhookRequest(event))).json()).toMatchObject({state:'duplicate_recorded'});
  expect(s.bucket.values.get(keys[0])!.text).toBe(before);
  for(const secret of [webhookSecret,s.config.from,s.config.to,s.config.api_key])expect(before).not.toContain(secret);
  expect(JSON.parse(before)).toMatchObject({event_type:'email.delivered',outbox_transition_authority:false,recipient_acknowledged:false});
});
it.each(['tamper','old','future','wrong-key','wrong-email','wrong-destination','wrong-tags'])('rejects untrusted signed receipt %s',async kind=>{
  const s=await fixture();await s.enqueue();await processOperatingAlert(s.env,episode.dedupe_key,(await s.adapter())!);const event=webhookEvent(s);
  if(kind==='wrong-email')event.data.email_id=crypto.randomUUID();if(kind==='wrong-destination')event.data.to=['different@example.test'];if(kind==='wrong-tags')event.data.tags.delta_payload='b'.repeat(64);
  const request=await webhookRequest(event,'msg_original_event',Math.floor(now/1000)+(kind==='old'?-301:kind==='future'?301:0),kind==='wrong-key'?`whsec_${btoa('other-isolated-synthetic-key!!!!')}`:webhookSecret);
  const altered=kind==='tamper'?new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify({...event,type:'email.failed'})}):request;
  expect((await receiveResendAlertWebhook(webhookEnv(s),altered)).status).toBe(kind.startsWith('wrong-')&&kind!=='wrong-key'?409:401);
  expect([...s.bucket.values.keys()].filter(k=>k.startsWith(ALERT_WEBHOOK_PREFIX))).toHaveLength(0);expect(s.posts).toHaveLength(1);
});
it('same signed event ID with changed body conflicts without replacing prior evidence',async()=>{
  const s=await fixture();await s.enqueue();await processOperatingAlert(s.env,episode.dedupe_key,(await s.adapter())!);const event=webhookEvent(s),env=webhookEnv(s);
  expect((await receiveResendAlertWebhook(env,await webhookRequest(event))).status).toBe(200);
  const key=[...s.bucket.values.keys()].find(k=>k.startsWith(ALERT_WEBHOOK_PREFIX))!,prior=s.bucket.values.get(key)!.text;
  expect((await receiveResendAlertWebhook(env,await webhookRequest({...event,type:'email.failed'}))).status).toBe(409);expect(s.bucket.values.get(key)!.text).toBe(prior);
});
it('lost webhook custody write ACK reads original identity instead of rewriting or dispatching',async()=>{
  const s=await fixture();await s.enqueue();await processOperatingAlert(s.env,episode.dedupe_key,(await s.adapter())!);const put=s.bucket.put.bind(s.bucket);let writes=0;
  s.bucket.put=async(k,v,o)=>{const answer=await put(k,v,o);if(k.startsWith(ALERT_WEBHOOK_PREFIX)){writes++;throw Error('lost-ack');}return answer;};
  expect((await receiveResendAlertWebhook(webhookEnv(s),await webhookRequest(webhookEvent(s)))).status).toBe(200);expect(writes).toBe(1);expect(s.posts).toHaveLength(1);
});
it('webhook off, unsigned oversized body and unavailable storage cannot create accepted evidence',async()=>{
  const s=await fixture(),env=webhookEnv(s);expect((await receiveResendAlertWebhook({...env,OPERATIONS_ALERT_WEBHOOK_ENABLED:'false'},await webhookRequest({}))).status).toBe(404);
  expect(s.bucket.values.size).toBe(0);
  expect((await receiveResendAlertWebhook(env,new Request('https://delta.example/receive',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(16385)}))).status).toBe(413);
  await s.enqueue();await processOperatingAlert(s.env,episode.dedupe_key,(await s.adapter())!);s.bucket.get=async()=>{throw Error('storage-down');};
  expect((await receiveResendAlertWebhook(env,await webhookRequest(webhookEvent(s)))).status).toBe(503);
});
it('real app route isolates provider signature authority from admin, browser and payment authority',async()=>{
  const {app}=await import('../src/index');const s=await fixture(),env=webhookEnv(s);
  expect((await app.fetch(await webhookRequest({}),s.env)).status).toBe(404);
  await s.enqueue();await processOperatingAlert(s.env,episode.dedupe_key,(await s.adapter())!);
  expect((await app.fetch(await webhookRequest(webhookEvent(s)),env)).status).toBe(200);
  for(const header of ['origin','authorization','payment-signature','x-payment']){const r=await webhookRequest(webhookEvent(s));r.headers.set(header,'synthetic-forbidden');expect((await app.fetch(r,env)).status).toBe(400);}
  const request=await webhookRequest(webhookEvent(s));request.headers.set('svix-signature','v1,invalid');expect((await app.fetch(request,env)).status).toBe(401);
  expect(s.posts).toHaveLength(1);expect([...s.bucket.values.keys()].filter(k=>k.startsWith(ALERT_WEBHOOK_PREFIX))).toHaveLength(1);
});
