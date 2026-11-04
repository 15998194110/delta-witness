// Signed receipt custody only. This receiver never sends, acknowledges, pays,
// retries a provider operation, or promotes an Outbox/business state.
import {sha256,stableJson} from './crypto';
import {createClaim} from './claims';
import {createOrderReadSnapshot,readOrderMetadata} from './order-storage';
import {withinDeadline} from './deadline';
import {ownerAlertDeliveryConfiguration,type OwnerAlertDeliveryEnv} from './operating-alert-delivery';
import {readResendAlertWebhookBinding} from './operating-alert-resend';

export const ALERT_WEBHOOK_PREFIX='operations/alerts/resend-webhooks/';
export type AlertWebhookEnv=OwnerAlertDeliveryEnv&{OPERATIONS_ALERT_WEBHOOK_ENABLED?:string;OPERATIONS_ALERT_RESEND_WEBHOOK_SECRET?:string};
const MAX_BODY=16384;
const EVENTS=['email.sent','email.delivered','email.bounced','email.failed','email.suppressed','email.delivery_delayed','email.opened','email.clicked','email.complained'];
const encode=new TextEncoder();
function decodeBase64(value:string){
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(value)||value.length>256)throw Error('signature_invalid');
  return Uint8Array.from(atob(value),c=>c.charCodeAt(0));
}
// Raw request bytes, not reserialized JSON. WebCrypto verification supplies a
// constant-time MAC comparison. At most four rotation signatures are allowed.
export async function verifyResendWebhookSignature(body:Uint8Array,headers:Headers,secret:string,now=Date.now()){
  const id=headers.get('svix-id')??'',timestamp=headers.get('svix-timestamp')??'',signatures=headers.get('svix-signature')??'';
  if(body.byteLength>MAX_BODY||!/^msg_[A-Za-z0-9_-]{1,100}$/.test(id)||!/^\d{1,12}$/.test(timestamp)||!Number.isFinite(now)||
    Math.abs(now/1000-Number(timestamp))>300||signatures.length>512||!secret.startsWith('whsec_'))return false;
  try{
    const keyBytes=decodeBase64(secret.slice(6));if(keyBytes.byteLength<16||keyBytes.byteLength>64)return false;
    const key=await crypto.subtle.importKey('raw',keyBytes,{name:'HMAC',hash:'SHA-256'},false,['verify']);
    const prefix=encode.encode(`${id}.${timestamp}.`),content=new Uint8Array(prefix.byteLength+body.byteLength);content.set(prefix);content.set(body,prefix.byteLength);
    const versions=signatures.split(' ');if(!versions.length||versions.length>4)return false;
    let valid=false;
    for(const signature of versions){if(!signature.startsWith('v1,'))continue;const mac=decodeBase64(signature.slice(3));
      if(mac.byteLength===32&&await crypto.subtle.verify('HMAC',key,mac,content))valid=true;}
    return valid;
  }catch{return false;}
}
const answer=(status:number,state:string)=>Response.json({state,recipient_acknowledged:false,dispatch_authority:false},{status,headers:{'cache-control':'no-store'}});
type Custody={schema:'delta-resend-webhook-custody/v1';event_id_hash:string;body_hash:string;event_type:string;event_created_at:string;
  notification_id:string;payload_hash:string;destination_digest:string;provider_email_id:string;received_at:string;
  authenticated_source:'resend_svix_hmac';outbox_transition_authority:false;recipient_acknowledged:false};

export async function receiveResendAlertWebhook(source:AlertWebhookEnv,request:Request):Promise<Response>{
  const config=ownerAlertDeliveryConfiguration(source);
  if(source.OPERATIONS_ALERT_WEBHOOK_ENABLED!=='true'||!config.enabled)return answer(404,'disabled');
  if(request.method!=='POST'||new URL(request.url).search||request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return answer(400,'invalid_request');
  const secret=source.OPERATIONS_ALERT_RESEND_WEBHOOK_SECRET;
  if(!secret)return answer(503,'configuration_unavailable');
  const snapshot=createOrderReadSnapshot(source,8192);let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const cancel=()=>{snapshot.cancel();if(reader)void reader.cancel().catch(()=>{});};
  try{return await withinDeadline((async()=>{
    const length=request.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>MAX_BODY)||!request.body)return answer(413,'invalid_payload');
    reader=request.body.getReader();const bytes=new Uint8Array(MAX_BODY);let size=0,reads=0;
    const raw=await withinDeadline((async()=>{while(true){const part=await reader!.read();snapshot.assertActive();if(part.done)break;
      if(++reads>256||size+part.value.byteLength>MAX_BODY)return null;bytes.set(part.value,size);size+=part.value.byteLength;}return bytes.slice(0,size);})(),2000,'webhook_body_deadline',cancel);
    if(!raw)return answer(413,'invalid_payload');
    if(!await verifyResendWebhookSignature(raw,request.headers,secret))return answer(401,'signature_rejected');
    snapshot.assertActive();
    let event:any;try{event=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(raw));}catch{return answer(400,'invalid_payload');}
    if(!event||!EVENTS.includes(event.type)||typeof event.created_at!=='string'||!Number.isFinite(Date.parse(event.created_at))||Date.parse(event.created_at)>Date.now())return answer(400,'unsupported_event');
    const binding=await readResendAlertWebhookBinding(snapshot.env,config,event.data);snapshot.assertActive();
    if(!binding||Date.parse(event.created_at)<Date.parse(binding.original_created_at)-5000)return answer(409,'original_identity_unconfirmed');
    const eventIdHash=await sha256(request.headers.get('svix-id')!),bodyHash=await sha256(raw),key=`${ALERT_WEBHOOK_PREFIX}${eventIdHash.slice(7)}.json`;
    const previous=await readOrderMetadata<Custody>(snapshot.env,key,8192);snapshot.assertActive();
    const core={schema:'delta-resend-webhook-custody/v1' as const,event_id_hash:eventIdHash,body_hash:bodyHash,event_type:event.type,event_created_at:event.created_at,
      notification_id:binding.notification_id,payload_hash:binding.payload_hash,destination_digest:binding.destination_digest,provider_email_id:binding.provider_email_id!,
      authenticated_source:'resend_svix_hmac' as const,outbox_transition_authority:false as const,recipient_acknowledged:false as const};
    const same=(value:Custody)=>!!value&&typeof value.received_at==='string'&&Number.isFinite(Date.parse(value.received_at))&&Date.parse(value.received_at)<=Date.now()&&
      stableJson(value)===stableJson({...core,received_at:value.received_at});
    if(previous)return answer(same(previous.record)?200:409,same(previous.record)?'duplicate_recorded':'event_identity_conflict');
    const row:Custody={...core,received_at:new Date().toISOString()};snapshot.assertActive();
    try{await createClaim(snapshot.env,key,row);}catch{/* same immutable key readback only; no repeat PUT */}
    snapshot.assertActive();const actual=await readOrderMetadata<Custody>(snapshot.env,key,8192);snapshot.assertActive();
    return actual&&same(actual.record)?answer(200,'signed_evidence_recorded'):answer(503,'custody_unconfirmed');
  })(),10000,'webhook_deadline',cancel);}catch{return answer(503,'receipt_unavailable');}finally{cancel();}
}
