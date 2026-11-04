// Bounded consumer of existing owner-alert episodes. Never payment/customer
// delivery authority, never a provider registration or activation operation.
import type {RuntimeEnv} from './env';
import {sha256,stableJson} from './crypto';
import {createClaim,commitClaim} from './claims';
import {createOrderReadSnapshot,readOrderMetadata} from './order-storage';
import {withinDeadline} from './deadline';
import {readOperatingAlert,enqueueOperatingAlert,processOperatingAlert,ALERT_OUTBOX_PREFIX,type AlertOutboxRecord} from './operating-alert-outbox';
import {createResendAlertAdapter,type ResendAlertConfig} from './operating-alert-resend';

export type OwnerAlertDeliveryEnv=RuntimeEnv&{OPERATIONS_ALERT_DELIVERY_ENABLED?:string;OPERATIONS_ALERT_RESEND_API_KEY?:string;
  OPERATIONS_ALERT_RESEND_FROM?:string;OPERATIONS_ALERT_RESEND_TO?:string;OPERATIONS_ALERT_RESEND_APPROVED_CONFIGURATION_DIGEST?:string;
  OPERATIONS_ALERT_RESEND_APPROVAL_EVIDENCE_REF?:string};
export const ALERT_DELIVERY_PREFIX='operations/alerts/delivery/';
export const ALERT_DELIVERY_LIMITS={scan:32,active:8,provider_calls:48,storage_reads:160,storage_bytes:2_000_000,work_ms:35000,total_ms:50000} as const;
type Cursor={schema:'delta-alert-delivery-cursor/v1';version:number;cursor:string|null;run_id:string;updated_at:string};
type HolePhase='reference_read'|'source_validation'|'destination_binding'|'dispatch'|'result_readback';
type ReferenceHole={schema:'delta-alert-delivery-reference-hole/v1';run_id:string;original_key:string;reference_hash:string;observed_at:string;
  phase:HolePhase;reason:'original_reference_unresolved';source_etag_hash:string|null;source_content_hash:string|null;
  original_notification_id:string|null;original_payload_hash:string|null;dispatch_authority:false;retry_authority:false;recipient_acknowledged:false};
const ISO=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const UUID=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const validCursor=(v:unknown):v is string|null=>v===null||typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\u0000-\u001f\u007f]/.test(v);
const oldest=(previous:string|null,current:string)=>previous===null||current<previous?current:previous;
function validCheckpoint(r:Cursor){return !!r&&Object.keys(r).sort().join(',')==='cursor,run_id,schema,updated_at,version'&&
  r.schema==='delta-alert-delivery-cursor/v1'&&Number.isSafeInteger(r.version)&&r.version>0&&validCursor(r.cursor)&&UUID(r.run_id)&&ISO(r.updated_at);}
export function ownerAlertDeliveryConfiguration(source:OwnerAlertDeliveryEnv):ResendAlertConfig{
  return{enabled:source.OPERATIONS_CLOUD_ENABLED==='true'&&source.OPERATIONS_ALERT_OUTBOX_ENABLED==='true'&&source.OPERATIONS_ALERT_DELIVERY_ENABLED==='true',
    api_key:source.OPERATIONS_ALERT_RESEND_API_KEY??'',from:source.OPERATIONS_ALERT_RESEND_FROM??'',to:source.OPERATIONS_ALERT_RESEND_TO??'',
    destination_id:source.OPERATIONS_ALERT_DESTINATION_ID??'',destination_digest:source.OPERATIONS_ALERT_DESTINATION_DIGEST??'',
    approved_configuration_digest:source.OPERATIONS_ALERT_RESEND_APPROVED_CONFIGURATION_DIGEST??'',approval_evidence_ref:source.OPERATIONS_ALERT_RESEND_APPROVAL_EVIDENCE_REF??''};
}
export async function processOwnerAlertQueue(source:OwnerAlertDeliveryEnv,options:{fetch?:typeof fetch}={}){
  const config=ownerAlertDeliveryConfiguration(source);
  const counts={scanned:0,processed:0,provider_accepted:0,delivered:0,failed:0,unknown:0,skipped:0,terminal_delivered:0,acknowledged:0};
  if(!config.enabled)return{state:'disabled',counts,provider_calls:0,notification_delivered:null};
  const startedAt=Date.now(),controller=new AbortController();let storageReads=0,storageBytes=0;
  const boundedSource={...source,PROOFS:{
    get:async(key:string)=>{if(controller.signal.aborted||storageReads>=ALERT_DELIVERY_LIMITS.storage_reads)throw Error('alert_delivery_read_budget');storageReads++;
      const object=await source.PROOFS.get(key);
      if(controller.signal.aborted){void object?.body?.cancel().catch(()=>{});throw Error('alert_delivery_deadline');}
      if(object){if(!Number.isSafeInteger(object.size)||object.size<0||object.size>32000||storageBytes+object.size>ALERT_DELIVERY_LIMITS.storage_bytes){
        void object.body?.cancel().catch(()=>{});throw Error('alert_delivery_read_budget');}storageBytes+=object.size;}
      return object;},
    put:(...args:Parameters<R2Bucket['put']>)=>{if(controller.signal.aborted)throw Error('alert_delivery_deadline');return source.PROOFS.put(...args);},
  } as unknown as R2Bucket};
  const snapshot=createOrderReadSnapshot(boundedSource,32000),env=snapshot.env;
  const stop=()=>{controller.abort();snapshot.cancel();};
  const check=()=>{snapshot.assertActive();if(controller.signal.aborted)throw Error('alert_delivery_deadline');};
  let providerCalls=0;
  const fetcher=options.fetch??fetch;
  const wrappedFetch:typeof fetch=async(input,init)=>{check();if(init?.signal?.aborted||providerCalls>=ALERT_DELIVERY_LIMITS.provider_calls)throw Error('alert_delivery_provider_budget');providerCalls++;
    const child=new AbortController(),abort=()=>child.abort();controller.signal.addEventListener('abort',abort,{once:true});init?.signal?.addEventListener('abort',abort,{once:true});
    try{const response=await fetcher(input,{...init,signal:child.signal});check();return response;}
    finally{controller.signal.removeEventListener('abort',abort);init?.signal?.removeEventListener('abort',abort);}
  };
  try{return await withinDeadline((async()=>{
    const adapter=await createResendAlertAdapter(boundedSource,config,{fetch:wrappedFetch});check();if(!adapter)throw Error('alert_delivery_disabled');
    const cursorKey=`${ALERT_DELIVERY_PREFIX}cursor.json`,prior=await readOrderMetadata<Cursor>(env,cursorKey);check();
    if(prior&&!validCheckpoint(prior.record))throw Error('alert_delivery_cursor_invalid');
    let continuation=prior?.record.cursor??null,hasMore=true,pages=0,activeAttempts=0,budgetLimited=false;
    let oldestPendingAt:string|null=null;
    const visited=new Set<string>(),pageCursors=new Set<string>();if(continuation)pageCursors.add(continuation);
    const runId=crypto.randomUUID();
    // A hole is immutable evidence of a missing observation, not a replacement
    // alert, queue, send grant, ACK, or claim on the original episode. A later
    // pass wraps to the same original reference and rechecks its original ID.
    const holes:{key:string;hole_hash:string;reference_hash:string}[]=[];
    let complete=true,cursorReady=true,unresolvedReferences=0;
    const retainHole=async(input:Omit<ReferenceHole,'schema'|'run_id'|'reference_hash'|'observed_at'|'reason'|'dispatch_authority'|'retry_authority'|'recipient_acknowledged'>)=>{
      const holeSnapshot=createOrderReadSnapshot(boundedSource,8192),holeEnv=holeSnapshot.env;
      const cancel=()=>holeSnapshot.cancel(),holeCheck=()=>{check();holeSnapshot.assertActive();};
      controller.signal.addEventListener('abort',cancel,{once:true});
      try{return await withinDeadline((async()=>{
        holeCheck();const referenceHash=await sha256(input.original_key);
        const row:ReferenceHole={schema:'delta-alert-delivery-reference-hole/v1',run_id:runId,...input,reference_hash:referenceHash,
          observed_at:new Date().toISOString(),reason:'original_reference_unresolved',dispatch_authority:false,retry_authority:false,recipient_acknowledged:false};
        const holeKey=`${ALERT_DELIVERY_PREFIX}holes/${runId}/${referenceHash.slice(7)}.json`;
        holeCheck();try{await createClaim(holeEnv,holeKey,row);}catch{/* only exact original hole-key readback; never repeat PUT */}
        holeCheck();const actual=await readOrderMetadata<ReferenceHole>(holeEnv,holeKey,8192);holeCheck();
        if(!actual||stableJson(actual.record)!==stableJson(row))return null;
        return{key:holeKey,hole_hash:await sha256(stableJson(row)),reference_hash:referenceHash};
      })(),4000,'alert_delivery_hole_deadline',cancel);}catch{return null;}
      finally{cancel();controller.signal.removeEventListener('abort',cancel);}
    };
    // Traverse bounded pages in the same existing consumer. Historical terminal
    // rows consume scan capacity, never scarce active send/readback capacity.
    while(counts.scanned<ALERT_DELIVERY_LIMITS.scan&&activeAttempts<ALERT_DELIVERY_LIMITS.active&&Date.now()-startedAt<ALERT_DELIVERY_LIMITS.work_ms){
    check();const limit=Math.min(2,ALERT_DELIVERY_LIMITS.scan-counts.scanned,ALERT_DELIVERY_LIMITS.active-activeAttempts);
    const page=await source.PROOFS.list({prefix:`${ALERT_OUTBOX_PREFIX}episodes/`,limit,...(continuation?{cursor:continuation}:{})});check();pages++;
    if(!page||!Array.isArray(page.objects)||page.objects.length>limit||typeof page.truncated!=='boolean'||page.delimitedPrefixes?.length||
      page.objects.some(o=>!/^operations\/alerts\/episodes\/[0-9a-f]{64}\.json$/.test(o.key)||visited.has(o.key))||new Set(page.objects.map(o=>o.key)).size!==page.objects.length||
      page.truncated&&(!page.objects.length||!validCursor(page.cursor)||page.cursor===null||pageCursors.has(page.cursor))||
      !page.truncated&&'cursor'in page&&page.cursor!==undefined)throw Error('alert_delivery_inventory_invalid');
    if(page.truncated)pageCursors.add(page.cursor!);hasMore=page.truncated;let pageDone=true;
    for(const item of page.objects){
      check();if(Date.now()-startedAt>=ALERT_DELIVERY_LIMITS.work_ms){budgetLimited=true;pageDone=false;complete=false;break;}
      visited.add(item.key);counts.scanned++;const itemSnapshot=createOrderReadSnapshot(boundedSource,32000),itemEnv=itemSnapshot.env,itemController=new AbortController();
      let phase:HolePhase='reference_read',sourceEtagHash:string|null=null,sourceContentHash:string|null=null;
      let originalNotificationId:string|null=null,originalPayloadHash:string|null=null;
      const cancelItem=()=>{itemController.abort();itemSnapshot.cancel();};
      const itemCheck=()=>{check();itemSnapshot.assertActive();};
      const withItemSignal=async<T>(signal:AbortSignal,work:(signal:AbortSignal)=>Promise<T>)=>{
        itemCheck();const combined=new AbortController(),abort=()=>combined.abort();
        signal.addEventListener('abort',abort,{once:true});itemController.signal.addEventListener('abort',abort,{once:true});controller.signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted||itemController.signal.aborted||controller.signal.aborted)combined.abort();
        try{return await work(combined.signal);}finally{signal.removeEventListener('abort',abort);itemController.signal.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',abort);}
      };
      const scopedAdapter={...adapter,send:(operation:Parameters<typeof adapter.send>[0],signal:AbortSignal)=>withItemSignal(signal,combined=>adapter.send(operation,combined)),
        readOriginal:(operation:Parameters<typeof adapter.readOriginal>[0],signal:AbortSignal)=>withItemSignal(signal,combined=>adapter.readOriginal(operation,combined))};
      try{
        await withinDeadline((async()=>{
        const original=await readOrderMetadata<AlertOutboxRecord>(itemEnv,item.key);itemCheck();
        if(original){sourceEtagHash=await sha256(original.etag);sourceContentHash=await sha256(stableJson(original.record));itemCheck();}
        phase='source_validation';
        if(!original||!original.record.episode||item.key!==`${ALERT_OUTBOX_PREFIX}episodes/${(await sha256(original.record.episode.dedupe_key)).slice(7)}.json`)throw Error('alert_delivery_original_invalid');
        let row=await readOperatingAlert(itemEnv,original.record.episode.dedupe_key);itemCheck();if(!row)throw Error('alert_delivery_original_missing');
        originalNotificationId=row.notification_id;originalPayloadHash=row.payload_hash;
        if(row.acknowledgment||row.state==='delivered'){counts.skipped++;if(row.acknowledgment)counts.acknowledged++;if(row.state==='delivered')counts.terminal_delivered++;return;}
        oldestPendingAt=oldest(oldestPendingAt,row.created_at);
        if(row.state==='failed'){counts.failed++;return;}
        activeAttempts++;
        if(row.state==='blocked'){
          phase='destination_binding';
          const bound=await enqueueOperatingAlert(itemEnv,row.episode,adapter.destination);itemCheck();
          if(bound.state!=='queued')throw Error('alert_delivery_binding_unconfirmed');row=await readOperatingAlert(itemEnv,row.episode.dedupe_key);itemCheck();if(!row)throw Error('alert_delivery_original_missing');
        }
        const identity={notification_id:row.notification_id,payload_hash:row.payload_hash};
        phase='dispatch';
        const result=await processOperatingAlert(itemEnv,row.episode.dedupe_key,scopedAdapter);itemCheck();counts.processed++;
        phase='result_readback';
        const actual=await readOperatingAlert(itemEnv,row.episode.dedupe_key);itemCheck();
        if(!actual||actual.notification_id!==identity.notification_id||actual.payload_hash!==identity.payload_hash)throw Error('alert_delivery_readback_unconfirmed');
        if(result.state==='delivered'&&actual.state==='delivered')counts.delivered++;
        else if(result.state==='provider_accepted'&&actual.state==='provider_accepted')counts.provider_accepted++;
        else if(result.state==='failed'&&actual.state==='failed')counts.failed++;
        else if(['unconfirmed','sending','provider_accepted'].includes(actual.state))counts.unknown++;
        else if(actual.acknowledgment)counts.skipped++;
        else throw Error('alert_delivery_readback_unconfirmed');
        })(),Math.max(1,Math.min(15000,ALERT_DELIVERY_LIMITS.work_ms-(Date.now()-startedAt))),'alert_delivery_item_deadline',cancelItem);
      }catch{
        check();complete=false;counts.unknown++;unresolvedReferences++;cancelItem();
        const hole=await retainHole({original_key:item.key,phase,source_etag_hash:sourceEtagHash,source_content_hash:sourceContentHash,
          original_notification_id:originalNotificationId,original_payload_hash:originalPayloadHash});
        check();if(hole)holes.push(hole);else cursorReady=false;
      }finally{cancelItem();}
    }
    // Partial pages are retried by their original input cursor; already-applied
    // effects can only be read back under their original notification identity.
    if(pageDone&&cursorReady)continuation=page.truncated?page.cursor!:null;
    if(!pageDone)hasMore=true;
    if(!pageDone||!cursorReady||!page.truncated)break;
    }
    if(hasMore&&(counts.scanned>=ALERT_DELIVERY_LIMITS.scan||activeAttempts>=ALERT_DELIVERY_LIMITS.active||Date.now()-startedAt>=ALERT_DELIVERY_LIMITS.work_ms))budgetLimited=true;
    const at=new Date().toISOString(),observation={schema:'delta-owner-alert-delivery-run/v1',run_id:runId,observed_at:at,
      counts,provider_calls:providerCalls,page_complete:complete,cursor_ready:cursorReady,unresolved_reference_count:unresolvedReferences,
      hole_refs:holes,inventory_complete:false,notification_delivered:null,counts_scope:'this_run_observations_not_cumulative',
      active_attempts:activeAttempts,pages,scan_budget_limited:budgetLimited,remaining_inventory:hasMore?'not_yet_scanned':'end_of_current_sweep',oldest_pending_observed_at:oldestPendingAt,
      storage_reads:storageReads,storage_bytes:storageBytes};
    const runKey=`${ALERT_DELIVERY_PREFIX}runs/${runId}.json`;
    // Create once and independently verify the original observation. Unknown
    // storage retains the input cursor. Unresolved references may be passed
    // only after their immutable hole and this original run are read back.
    const saved=await createClaim(env,runKey,observation);check();if(!saved)throw Error('alert_delivery_observation_conflict');
    const receipt=await readOrderMetadata<typeof observation>(env,runKey);check();if(!receipt||stableJson(receipt.record)!==stableJson(observation))throw Error('alert_delivery_observation_unconfirmed');
    let cursorState='retained';
    if(cursorReady){
      const next:Cursor={schema:'delta-alert-delivery-cursor/v1',version:(prior?.record.version??0)+1,cursor:continuation,run_id:runId,updated_at:at};
      if(!Number.isSafeInteger(next.version))throw Error('alert_delivery_cursor_exhausted');
      try{const updated=prior?await commitClaim(env,cursorKey,prior,next):await createClaim(env,cursorKey,next);check();cursorState=updated?'advanced':'conflict';}
      catch{check();const actual=await readOrderMetadata<Cursor>(env,cursorKey);check();cursorState=actual&&validCheckpoint(actual.record)&&stableJson(actual.record)===stableJson(next)?'advanced':'unconfirmed';}
    }
    return{state:complete&&counts.unknown===0&&counts.failed===0&&!budgetLimited&&!['conflict','unconfirmed'].includes(cursorState)?'observed':'degraded',counts,provider_calls:providerCalls,
      run_id:runId,cursor_state:cursorState,page_complete:complete,unresolved_reference_count:unresolvedReferences,hole_refs:holes,
      inventory_complete:false,notification_delivered:null,counts_scope:'this_run_observations_not_cumulative',active_attempts:activeAttempts,pages,
      scan_budget_limited:budgetLimited,remaining_inventory:hasMore?'not_yet_scanned':'end_of_current_sweep',oldest_pending_observed_at:oldestPendingAt,
      storage_reads:storageReads,storage_bytes:storageBytes};
  })(),ALERT_DELIVERY_LIMITS.total_ms,'alert_delivery_deadline',stop);}catch{return{state:'unavailable',counts,provider_calls:providerCalls,notification_delivered:null,storage_reads:storageReads,storage_bytes:storageBytes};}finally{stop();}
}
