// Local-only reviewed source composition. No deploy, installs or remote reads.
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,symlink,readdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const consumer='149c302d278ce83c9faeae4d058f318777a97e0c';
const mode=process.argv[3]??'compatible';if(!['compatible','candidate'].includes(mode))throw Error('invalid_composition_mode');
const base=mode==='compatible'?'0dbf2b3963ff56641b96e95b8f358591514cb3c4':consumer;
const output=resolve(process.argv[2]??'');
if(!process.argv[2]||!process.env.NODE_OPTIONS?.includes('offline-guard.cjs'))throw Error('fresh_output_and_offline_runner_required');
await mkdir(output,{recursive:false});
const git=(...args)=>execFileSync('git',['-C',repo,...args],{maxBuffer:20_000_000});
const sha=b=>createHash('sha256').update(b).digest('hex');
const files=[],patches=[];
const currentOrders=(await readFile(join(repo,'src/orders.ts'),'utf8')).replace(/\r\n/g,'\n');
const emptyInputGuard=currentOrders.match(/async function assertEmptyRecoveryInput\(request: Request\): Promise<void> \{[\s\S]*?\n\}\n/ )?.[0];
if(!emptyInputGuard)throw Error('reviewed_zero_byte_input_guard_missing');
const oldInputGuard='if (request.headers.has("payment-signature") || request.headers.has("x-payment") || request.body !== null) throw new OrderAccessError("order_recovery_input_forbidden", 400);';
async function save(path,bytes,source){await mkdir(dirname(join(output,path)),{recursive:true});await writeFile(join(output,path),bytes,{flag:'wx'});files.push({path,source,sha256:sha(bytes)});}
const paths=git('ls-tree','-r','--name-only',base,'src').toString().trim().split('\n');
for(const path of [...paths,'package.json','package-lock.json','worker-configuration.d.ts','tsconfig.json','scripts/treasury-reconciliation.mjs',...(mode==='candidate'?['scripts/treasury-checkpoint-store.mjs']:[])]){
  if(!/^(src\/[\w./-]+\.ts|package(?:-lock)?\.json|worker-configuration\.d\.ts|tsconfig\.json|scripts\/treasury-(reconciliation|checkpoint-store)\.mjs)$/.test(path))throw Error('unreviewed_source');
  let bytes=git('show',`${base}:${path}`);
  let source=base;
  if(path==='src/env.ts'&&mode==='compatible'){bytes=Buffer.from(bytes.toString().replace('export type RuntimeEnv = Env & {','export type RuntimeEnv = Env & {\n  OPERATIONS_CLOUD_ENABLED?: string;\n  PAID_ORDER_DRAFT_RECOVERY_ENABLED?: string;'));source=`${base}+two_optional_type_fields`;}
  if(path==='src/orders.ts'){
    const original=bytes,text=bytes.toString(),entry='export async function orderStatusResponse(';
    if(text.split(oldInputGuard).length!==2||text.split(entry).length!==2)throw Error('original_input_guard_drift');
    bytes=Buffer.from(text.replace(oldInputGuard,'await assertEmptyRecoveryInput(request);').replace(entry,`${emptyInputGuard}\n${entry}`));
    patches.push({path,kind:'zero_byte_recovery_input_guard',original_sha256:sha(original),helper_sha256:sha(emptyInputGuard),patched_sha256:sha(bytes)});
    source=`${base}+zero_byte_recovery_input_guard`;
  }
  await save(path,bytes,source);
}
const currentLock=JSON.parse(await readFile(join(repo,'package-lock.json'),'utf8'));
if(JSON.stringify(currentLock)!==JSON.stringify(JSON.parse(git('show',`${base}:package-lock.json`))))throw Error('dependency_lock_drift');
if(mode==='compatible'){
  for(const name of ['paid-order-recovery.ts','paid-recovery-priority.ts','paid-recovery-control.ts'])await save(`src/${name}`,git('show',`${consumer}:src/${name}`),consumer);
  await save('src/rollback-continuity.ts',await readFile(join(repo,'src/rollback-continuity.ts')),'reviewed_local_adapter');
  await save('src/rollback/index.ts',Buffer.from("import original from '../index';\nimport {withPaidRecoveryContinuity} from '../rollback-continuity';\nexport default withPaidRecoveryContinuity(original);\n"),'default_handler_composition');
}
const config=JSON.parse(git('show',`${base}:wrangler.jsonc`));if(mode==='compatible')config.main='src/rollback/index.ts';
await save('wrangler.jsonc',Buffer.from(JSON.stringify(config,null,2)+'\n'),mode==='compatible'?`${base}+local_build_entry_only`:base);
await symlink(join(repo,'node_modules'),join(output,'node_modules'),process.platform==='win32'?'junction':'dir');
const isolated=join(output,'isolated-home');await mkdir(isolated);
await save('isolated-home.cjs',Buffer.from(`require('node:os').homedir=()=>${JSON.stringify(isolated)};require('node:module').syncBuiltinESMExports();`),'local_build_guard');
const env={...process.env,NODE_OPTIONS:`${process.env.NODE_OPTIONS} --require=${JSON.stringify(join(output,'isolated-home.cjs'))}`,XDG_CONFIG_HOME:isolated,WRANGLER_SEND_METRICS:'false',CI:'true'};
for(const key of Object.keys(env))if(/TOKEN|SECRET|PRIVATE_KEY|MNEMONIC|PASSWORD|API_KEY|CLOUDFLARE|WALLET/i.test(key))delete env[key];
const log=execFileSync(process.execPath,[join(repo,'node_modules/wrangler/bin/wrangler.js'),'deploy','--dry-run','--config',join(output,'wrangler.jsonc'),'--outdir',join(output,'worker')],{cwd:output,env,maxBuffer:5_000_000});
if(!log.toString().includes('--dry-run: exiting now.'))throw Error('dry_run_not_confirmed');
await writeFile(join(output,'build.log'),log,{flag:'wx'});
const artifacts=[];for(const name of await readdir(join(output,'worker'))){const bytes=await readFile(join(output,'worker',name));artifacts.push({path:`worker/${name}`,sha256:sha(bytes),bytes:bytes.length});}
const report={schema:'delta-rollback-continuity-build/v1',mode,base_commit:base,consumer_commit:consumer,source_files:files,source_patches:patches,artifacts,config_flags_unchanged:true,
  deployed:false,remote_uploads:0,network:'offline-guard',scope:mode==='compatible'?'old_product_plus_original_scoped_paid_recovery_and_zero_byte_input_guard':'baseline_plus_zero_byte_input_guard',production_qualified:false};
await writeFile(join(output,'build-evidence.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({base,consumer,artifacts,remote_uploads:0}));
