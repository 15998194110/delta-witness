// Bounded read-only original-order projection for the existing alert consumer.
// Unlike the recovery pending index, original orders retain quarantined debt.
// This cursor is observation progress only: it never grants fulfillment work.
import type {RuntimeEnv} from './env';
import {readOrderRemediationSummary} from './orders';
import {createOrderReadSnapshot,readOrderMetadata} from './order-storage';
import {createClaim,commitClaim} from './claims';
import {sha256,stableJson} from './crypto';
import {withinDeadline} from './deadline';

export const PAID_ALERT_SOURCE_PREFIX='operations/alerts/sources/paid/';
const KEY=`${PAID_ALERT_SOURCE_PREFIX}cursor.json`,MAX_BYTES=16_384;
const ORDER=/^orders\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
type Cursor={schema:'delta-paid-alert-cursor/v1';version:number;cursor:string|null;page_hash:string;observed_at:string};
const validCursor=(v:unknown):v is string|null=>v===null||typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\u0000-\u001f\u007f]/.test(v);
function valid(r:Cursor){return r&&Object.keys(r).sort().join(',')==='cursor,observed_at,page_hash,schema,version'&&r.schema==='delta-paid-alert-cursor/v1'&&
  Number.isSafeInteger(r.version)&&r.version>0&&validCursor(r.cursor)&&/^sha256:[0-9a-f]{64}$/.test(r.page_hash)&&
  typeof r.observed_at==='string'&&Number.isFinite(Date.parse(r.observed_at))&&new Date(r.observed_at).toISOString()===r.observed_at;}
export async function readPaidAlertSource(source:RuntimeEnv){
  const snapshot=createOrderReadSnapshot(source,MAX_BYTES),env=snapshot.env;
  try{return await withinDeadline((async()=>{
    const prior=await readOrderMetadata<Cursor>(env,KEY,MAX_BYTES);snapshot.assertActive();
    if(prior&&!valid(prior.record))throw new Error('paid_alert_cursor_invalid');
    const input=prior?.record.cursor??null;
    const page=await source.PROOFS.list({prefix:'orders/',limit:3,...(input?{cursor:input}:{})});snapshot.assertActive();
    if(!page||!Array.isArray(page.objects)||page.objects.length>3||typeof page.truncated!=='boolean'||
      page.objects.some(row=>!row||!ORDER.test(row.key))||new Set(page.objects.map(row=>row.key)).size!==page.objects.length||
      page.truncated&&(!validCursor(page.cursor)||!page.cursor||page.cursor===input))throw new Error('paid_alert_page_invalid');
    const ids=page.objects.map(row=>ORDER.exec(row.key)![1]);
    // Core owns separate proof-size limits and its own five-second read fence.
    // Do not route artifact reads through this smaller cursor-metadata view.
    const summaries=await Promise.all(ids.map(id=>readOrderRemediationSummary(source,id)));snapshot.assertActive();
    const observation={schema:'delta-paid-alert-page/v1',observed_at:new Date().toISOString(),inventory_complete:false as const,
      input_cursor:input,next_cursor:page.truncated?page.cursor:null,truncated:page.truncated,
      items:ids.map((id,i)=>({order_id:id,summary:summaries[i],meaning:summaries[i]?'original_obligation_observation':'no_confirmed_open_obligation_established'}))};
    return {state:'observed' as const,scope:'bounded_original_order_page',inventory_complete:false as const,prior,observation,
      issues:summaries.filter((row):row is NonNullable<typeof row>=>!!row&&row.state!=='unknown').map(row=>({id:`order-${row.order_id}`,
        since:row.first_seen_at,confirmed:{value:true,observed_at:row.observed_at,evidence_id:`paid-${row.episode_id.slice(7)}`}}))};
  })(),7_000,'paid_alert_source_deadline',snapshot.cancel);}catch{return {state:'unknown' as const,scope:'bounded_original_order_page',inventory_complete:false as const,
    prior:null,observation:null,issues:[]};}finally{snapshot.cancel();}
}
export type PaidAlertSource=Awaited<ReturnType<typeof readPaidAlertSource>>;
// Called only after the selected alert intents are durably established. Persist
// the immutable readback first, then CAS the exact original cursor. A timeout,
// missing receipt or competing consumer cannot advance this page by guesswork.
export async function checkpointPaidAlertSource(source:RuntimeEnv,page:PaidAlertSource){
  if(page.state!=='observed'||!page.observation)return {state:'retained',reason:'source_unknown'};
  const snapshot=createOrderReadSnapshot(source,MAX_BYTES),env=snapshot.env;
  try{return await withinDeadline((async()=>{
    const hash=await sha256(stableJson(page.observation)),key=`${PAID_ALERT_SOURCE_PREFIX}pages/${hash.slice(7)}.json`;
    try{await createClaim(env,key,page.observation);}catch{/* exact immutable readback */}
    snapshot.assertActive();const saved=await readOrderMetadata(env,key,MAX_BYTES);snapshot.assertActive();
    if(!saved||stableJson(saved.record)!==stableJson(page.observation))return {state:'retained',reason:'page_write_unconfirmed'};
    const version=page.prior?.record.version??0;if(version>=Number.MAX_SAFE_INTEGER)throw new Error('paid_alert_cursor_exhausted');
    const next:Cursor={schema:'delta-paid-alert-cursor/v1',version:version+1,cursor:page.observation.next_cursor,page_hash:hash,observed_at:page.observation.observed_at};
    try{if(page.prior)await commitClaim(env,KEY,page.prior,next);else await createClaim(env,KEY,next);}catch{/* readback only */}
    snapshot.assertActive();const actual=await readOrderMetadata<Cursor>(env,KEY,MAX_BYTES);snapshot.assertActive();
    return actual&&valid(actual.record)&&stableJson(actual.record)===stableJson(next)?{state:'advanced',reason:'page_and_cursor_verified'}:{state:'retained',reason:'cursor_conflict_or_unconfirmed'};
  })(),5_000,'paid_alert_checkpoint_deadline',snapshot.cancel);}catch{return {state:'retained',reason:'checkpoint_unavailable'};}finally{snapshot.cancel();}
}
