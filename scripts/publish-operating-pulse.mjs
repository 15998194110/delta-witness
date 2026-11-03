import { open, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { fetchTextBounded } from './bounded-http.mjs';
const URL_ROOT='https://delta-witness-api.ruphussten.workers.dev/internal/operations/pulse';
const MAX_BYTES=65_536;
export async function publishOperatingPulse(input,{enabled=false,secret,fetchImpl=fetch}={}){
  if(!enabled)return {ok:true,state:'disabled',stored:false};
  if(typeof secret!=='string'||!secret||!input||input.schema!=='delta-pulse-status/v1'||input.reporting?.phase!=='final'||
    !/^[1-9][0-9]{0,18}$/.test(String(input.run?.id))||!/^[0-9a-f]{40}$/.test(input.run?.source_sha??''))throw new Error('operating_publication_configuration_invalid');
  const body=JSON.stringify(input);if(Buffer.byteLength(body)>MAX_BYTES)throw new Error('operating_publication_body_limit');
  const sourceHash=`sha256:${createHash('sha256').update(body).digest('hex')}`;
  const headers={authorization:`Bearer ${secret}`,accept:'application/json'};
  // At most one POST. The readback confirms the original event and pointer;
  // a lost acknowledgement never starts a replacement upload or business run.
  try{await fetchTextBounded(fetchImpl,URL_ROOT,{method:'POST',redirect:'error',headers:{...headers,'content-type':'application/json'},body},{timeoutMs:12_000,maxBytes:8_192});}
  catch{/* Preserve ambiguity and query the exact original run below. */}
  const {response,text}=await fetchTextBounded(fetchImpl,`${URL_ROOT}/${input.run.id}`,{redirect:'error',headers},{timeoutMs:12_000,maxBytes:8_192});
  let answer;try{answer=JSON.parse(text);}catch{throw new Error('operating_readback_unconfirmed');}
  if(!response.ok||answer?.ok!==true||answer.recorded!==true||answer.run_id!==String(input.run.id)||answer.source_sha!==input.run.source_sha||
    answer.observed_at!==input.observed_at||answer.source_payload_hash!==sourceHash||answer.latest_projection_at_or_after_run!==true||input.outcome==='success'&&answer.last_success_at_or_after_run!==true)
    throw new Error('operating_readback_unconfirmed');
  return {ok:true,state:'stored_and_read_back',stored:true,run_id:answer.run_id,source_sha:answer.source_sha,scope:'operational_observation_only',notification_delivered:null};
}
async function main(){
  if(process.env.DELTA_OPERATIONS_CLOUD_ENABLED!=='true'){console.log(JSON.stringify({ok:true,state:'disabled',stored:false}));return;}
  if(!process.argv[2])throw new Error('operating_report_path_required');
  const file=await open(process.argv[2],'r');let input;
  try{
    const before=await file.stat();if(!before.isFile()||before.size<1||before.size>MAX_BYTES)throw new Error('operating_publication_body_limit');
    const buffer=Buffer.alloc(MAX_BYTES+1);let at=0;while(at<buffer.length){const {bytesRead}=await file.read(buffer,at,buffer.length-at,null);if(!bytesRead)break;at+=bytesRead;}
    if(at!==before.size||at>MAX_BYTES)throw new Error('operating_report_changed');
    input=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(buffer.subarray(0,at)));
  }finally{await file.close();}
  const result=await publishOperatingPulse(input,{enabled:true,secret:process.env.DELTA_OPERATIONS_ADMIN_SECRET});
  if(process.argv[3])await writeFile(process.argv[3],JSON.stringify(result,null,2),{flag:'wx'});
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main().catch(()=>{
  console.error(JSON.stringify({ok:false,state:'unconfirmed',stored:null,error:'operating_publication_unconfirmed',notification_delivered:null}));process.exitCode=1;
});
