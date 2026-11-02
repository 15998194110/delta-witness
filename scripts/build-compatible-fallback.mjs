// LOCAL ONLY: compile exact prior Git source against the unchanged locked deps.
// No checkout/reset, install, remote state, secrets, deploy or migration.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, sep } from 'node:path';
import { build } from 'esbuild';

// Optional exact local commit is a separately reviewed backport, never a branch
// name, remote ref or implicit HEAD. Its identity is recorded with every input.
const commit = process.argv[3] ?? 'd85b36705c413f2e3c2579dc0bc6f9210d064875';
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('exact_reviewed_local_commit_required');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('fresh_local_output_directory_required');
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: false }); // Existing evidence is never replaced.
const git = (...args) => execFileSync('git', ['-C', repository, ...args], { maxBuffer: 20_000_000 });
if (git('rev-parse',`${commit}^{commit}`).toString().trim() !== commit) throw new Error('exact_reviewed_local_commit_required');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const lock = await readFile(resolve(repository,'package-lock.json'));
// Git's Windows checkout can change LF to CRLF; compare parsed lock content,
// while preserving both byte hashes in the evidence.
const priorLock = git('show', `${commit}:package-lock.json`);
if (JSON.stringify(JSON.parse(lock.toString())) !== JSON.stringify(JSON.parse(priorLock.toString()))) throw new Error('fallback_dependency_lock_drift');
const entries = git('ls-tree','-rz',commit,'src').toString('utf8').split('\0').filter(Boolean);
const files = [];
for (const entry of entries) {
  const match = /^(100644) blob ([a-f0-9]{40})\t(src\/[a-zA-Z0-9_./-]+\.ts)$/.exec(entry);
  if (!match) throw new Error('unsupported_source_entry');
  const relative = match[3];
  if (relative.split('/').includes('..')) throw new Error('unsafe_source_path');
  const destination = resolve(output, relative);
  if (!destination.startsWith(output+sep)) throw new Error('unsafe_source_path');
  const bytes = git('show',`${commit}:${relative}`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination,bytes,{flag:'wx'});
  files.push({path:relative,git_blob:match[2],sha256:digest(bytes)});
}
const artifact = resolve(output,'fallback-core.mjs');
await build({ entryPoints:[resolve(output,'src/index.ts')], bundle:true, platform:'node', format:'esm',
  target:'es2022', outfile:artifact, nodePaths:[resolve(repository,'node_modules')], logLevel:'silent' });
const evidence = { schema:'delta-isolated-fallback-build/v1', commit, dependency_lock_sha256:digest(lock),
  git_dependency_lock_sha256:digest(priorLock), dependency_lock_content_equal:true,
  artifact, artifact_sha256:digest(await readFile(artifact)), source_files:files,
  platform:'node', purpose:'isolated mixed-runtime compatibility only; not a deployable Worker artifact, deployment authorization or Cloudflare acceptance' };
await writeFile(resolve(output,'build-evidence.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({commit,artifact,artifact_sha256:evidence.artifact_sha256,source_files:files.length}));
