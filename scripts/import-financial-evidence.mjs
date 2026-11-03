#!/usr/bin/env node
// Import-only, offline. No credential lookup, provider call, funds operation,
// order mutation or implicit source verification. Archive files are create-only.
import {mkdir,lstat,open,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {readLocalInventory} from './retention-dry-run.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const PREFIX='operations/financial-evidence/sources/';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function importFinancialEvidence(input,storeDirectory){
  if(!input||Object.keys(input).sort().join(',')!=='schema,sources'||input.schema!=='delta-financial-evidence-import/v1'||
    !Array.isArray(input.sources)||!input.sources.length||input.sources.length>50)throw Error('financial_import_invalid');
  const directory=resolve(storeDirectory);
  try{await mkdir(directory,{recursive:false,mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const directoryInfo=await lstat(directory);if(!directoryInfo.isDirectory()||directoryInfo.isSymbolicLink())throw Error('financial_store_invalid');
  const fileFor=key=>{const match=/^operations\/financial-evidence\/sources\/([0-9a-f]{64})\.json$/.exec(key);if(!match)throw Error('financial_store_key_invalid');return resolve(directory,`${match[1]}.json`);};
  const bundle=await build({entryPoints:[resolve(root,'src/financial-evidence.ts')],bundle:true,platform:'node',format:'esm',target:'node24',write:false,logLevel:'silent'});
  const {retainFinancialSource}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const env={PROOFS:{
    get:async key=>{const path=fileFor(key);let info;
      try{info=await lstat(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}
      if(!info.isFile()||info.isSymbolicLink()||info.size>32000)throw Error('financial_store_object_invalid');
      const handle=await open(path,'r');let bytes;
      try{const size=(await handle.stat()).size;if(size>32000)throw Error('financial_store_object_invalid');bytes=Buffer.alloc(size);let used=0;
        while(used<size){const part=await handle.read(bytes,used,size-used,used);if(!part.bytesRead)throw Error('financial_store_object_invalid');used+=part.bytesRead;}
        if((await handle.stat()).size!==size)throw Error('financial_store_object_invalid');
      }finally{await handle.close();}
      return{size:bytes.length,etag:digest(bytes),body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}})};},
    put:async(key,value,options)=>{if(options?.onlyIf?.etagDoesNotMatch!=='*')throw Error('financial_store_create_only');
      const path=fileFor(key),bytes=Buffer.from(String(value));if(bytes.length>32000)throw Error('financial_store_object_invalid');
      try{await writeFile(path,bytes,{flag:'wx',mode:0o600});return{etag:digest(bytes)};}catch(error){if(error.code==='EEXIST')return null;throw error;}
    }
  }};
  const receipts=[];
  for(const candidate of input.sources){
    if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))throw Error('financial_import_invalid');
    // Caller-supplied provenance cannot impersonate a live provider connector.
    const source={...candidate,collection:candidate.collection==='synthetic_fixture'?'synthetic_fixture':'local_import'};
    receipts.push(await retainFinancialSource(env,source));
  }
  return{schema:'delta-financial-evidence-import-result/v1',state:receipts.every(r=>r.state==='retained')?'retained':'unconfirmed',
    source_count:receipts.length,receipts,provider_verification_performed:false,financial_recognition_performed:false,actual_variable_cost_raw:null};
}
export async function main(args=process.argv.slice(2)){
  if(args.length!==6||args[0]!=='--input'||args[2]!=='--store'||args[4]!=='--output')throw Error('financial_import_arguments_invalid');
  const inputPath=resolve(args[1]),outputPath=resolve(args[5]);if(inputPath===outputPath)throw Error('financial_output_must_be_new');
  const bytes=await readLocalInventory(inputPath),input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  const result=await importFinancialEvidence(input,args[3]);await writeFile(outputPath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  return{ok:result.state==='retained',scope:'offline_import_only',source_count:result.source_count,actual_variable_cost_raw:null};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{console.log(JSON.stringify(await main()));}catch{console.error(JSON.stringify({ok:false,state:'unknown',error:'financial_import_failed'}));process.exitCode=1;}
}
