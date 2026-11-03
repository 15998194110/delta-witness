// LOCAL ONLY. Exact prior Git files, fresh output, network-denied Wrangler
// dry-run. Never invoke this as a deployment, rollback, or migration command.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, symlink, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, sep } from 'node:path';

const commit = process.argv[3] ?? 'd85b36705c413f2e3c2579dc0bc6f9210d064875';
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('exact_reviewed_local_commit_required');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2] || !process.env.NODE_OPTIONS?.includes('offline-guard.cjs')) throw new Error('fresh_output_and_offline_runner_required');
const output = resolve(process.argv[2]);
await mkdir(output, { recursive:false });
const git = (...args) => execFileSync('git',['-C',repository,...args],{maxBuffer:20_000_000});
if (git('rev-parse',`${commit}^{commit}`).toString().trim() !== commit) throw new Error('exact_reviewed_local_commit_required');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const lock = await readFile(resolve(repository,'package-lock.json'));
const priorLock = git('show',`${commit}:package-lock.json`);
if (JSON.stringify(JSON.parse(lock.toString())) !== JSON.stringify(JSON.parse(priorLock.toString()))) throw new Error('fallback_dependency_lock_drift');
const configBytes = git('show',`${commit}:wrangler.jsonc`), config = JSON.parse(configBytes.toString());
// Reject build hooks, container builds, asset traversal and optional features
// before passing the exact public config to the reviewed CLI dry-run branch.
const allowed = new Set(['$schema','name','main','compatibility_date','compatibility_flags','workers_dev','observability','browser','r2_buckets','d1_databases','vars','triggers']);
if (Object.keys(config).some(key=>!allowed.has(key)) || config.main !== 'src/index.ts' || config.name !== 'delta-witness-api') throw new Error('unreviewed_fallback_config');
const entries = git('ls-tree','-rz',commit,'src').toString('utf8').split('\0').filter(Boolean);
const sources = entries.map(entry=>{
  const match = /^(100644) blob ([a-f0-9]{40})\t(src\/[a-zA-Z0-9_./-]+\.ts)$/.exec(entry);
  if (!match) throw new Error('unsupported_source_entry');
  return {path:match[3],git_blob:match[2]};
});
sources.push(...['wrangler.jsonc','package.json','package-lock.json'].map(path=>({path})));
// Core reuses the original pure Treasury validators instead of forking them.
// Copy only these explicitly reviewed Git objects; never broad-copy scripts,
// credentials, local state or the caller's working tree into an artifact.
for(const path of ['scripts/treasury-reconciliation.mjs','scripts/treasury-checkpoint-store.mjs']){
  if(git('ls-tree',commit,'--',path).toString().trim())sources.push({path});
}
const sourceFiles = [];
for (const source of sources) {
  const path = source.path, destination = resolve(output,path);
  if (path.split('/').includes('..') || !destination.startsWith(output+sep)) throw new Error('unsafe_source_path');
  const bytes = path === 'wrangler.jsonc' ? configBytes : git('show',`${commit}:${path}`);
  await mkdir(dirname(destination),{recursive:true});
  await writeFile(destination,bytes,{flag:'wx'});
  sourceFiles.push({...source,sha256:digest(bytes)});
}
// Reuse already installed locked dependencies, without installs/lifecycle scripts.
await symlink(resolve(repository,'node_modules'),resolve(output,'node_modules'),process.platform==='win32'?'junction':'dir');
const isolatedHome = resolve(output,'isolated-home');
await mkdir(isolatedHome);
const preload = resolve(output,'isolated-home.cjs');
await writeFile(preload,`const os = require('node:os');\nos.homedir = () => ${JSON.stringify(isolatedHome)};\nrequire('node:module').syncBuiltinESMExports();\n`,{flag:'wx'});
const env = {...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS} --require=${JSON.stringify(preload)}`,
  XDG_CONFIG_HOME:resolve(isolatedHome,'config'), XDG_CACHE_HOME:resolve(isolatedHome,'cache'),
  WRANGLER_SEND_METRICS:'false', CI:'true' };
for (const key of Object.keys(env)) if (/TOKEN|SECRET|PRIVATE_KEY|MNEMONIC|PASSWORD|API_KEY|CLOUDFLARE|WALLET/i.test(key)) delete env[key];
const cli = resolve(repository,'node_modules/wrangler/bin/wrangler.js');
const artifactDir = resolve(output,'worker');
const args = [cli,'deploy','--dry-run','--config',resolve(output,'wrangler.jsonc'),'--outdir',artifactDir];
const log = execFileSync(process.execPath,args,{cwd:output,env,maxBuffer:5_000_000});
await writeFile(resolve(output,'wrangler-dry-run.log'),log,{flag:'wx'});
if (!log.toString().includes('--dry-run: exiting now.')) throw new Error('dry_run_exit_not_confirmed');
const artifacts = [];
for (const entry of await readdir(artifactDir,{withFileTypes:true})) {
  if (!entry.isFile()) throw new Error('unexpected_worker_artifact');
  const bytes = await readFile(resolve(artifactDir,entry.name));
  artifacts.push({path:`worker/${entry.name}`,bytes:bytes.length,sha256:digest(bytes)});
}
if (!artifacts.some(entry=>entry.path==='worker/index.js')) throw new Error('worker_module_missing');
const wranglerVersion = JSON.parse(await readFile(resolve(repository,'node_modules/wrangler/package.json'),'utf8')).version;
const evidence = { schema:'delta-worker-fallback-build/v1',commit,wrangler_version:wranglerVersion,
  git_dependency_lock_sha256:digest(priorLock),installed_checkout_lock_sha256:digest(lock),dependency_lock_content_equal:true,
  source_files:sourceFiles,artifacts,log_sha256:digest(log),dry_run:true,network_policy:'offline-guard.cjs inherited by CLI; metrics disabled',
  config_policy:'exact prior public config; isolated home and no secrets copied',
  deployment_authorized:false,remote_uploads:0,
  qualification:'Worker-compatible local build only; mixed-version runtime tests use separately hashed Node bundle. Not Cloudflare runtime/rollback acceptance. Approved deployment must retain original recovery TTL/policy and bindings; prior config alone does not enable scoped recovery.' };
await writeFile(resolve(output,'build-evidence.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({commit,wrangler_version:wranglerVersion,artifacts,dry_run:true,remote_uploads:0}));
