// Build once, retain the exact public payload, and verify it before an approved
// release. Import-safe; tests inject a runner and never contact Cloudflare.
import { open, lstat, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertReleaseAuthorization } from './check-release-authorization.mjs';

const definitions = {
  core: { root: '.', config: 'wrangler.jsonc', entry: 'index.js', name: 'delta-witness-api' },
  gateway: { root: 'channels/partner-gateway', config: 'wrangler.jsonc', entry: 'index.js', name: 'delta-witness-partner-gateway' },
  pages: { root: 'channels/base-app', entry: 'index.html', name: 'delta-witness-app' },
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
async function readBounded(path, limit = 10_000_000) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail('invalid_cloudflare_artifact');
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    if (offset !== stat.size || (await file.stat()).size !== stat.size) fail('cloudflare_artifact_changed');
    return bytes.subarray(0, offset);
  } finally { await file.close(); }
}
function identity(kind, source) {
  const definition = Object.hasOwn(definitions, kind) ? definitions[kind] : null;
  if (!definition || !/^[a-f0-9]{40}$/.test(source ?? '') || /^0+$/.test(source)) fail('cloudflare_artifact_identity_required');
  return definition;
}
async function filesIn(directory, kind) {
  const files = []; let total = 0;
  async function visit(path, prefix = '') {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('invalid_cloudflare_artifact');
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix + entry.name;
      if (!/^[A-Za-z0-9_.\/-]+$/.test(relative) || relative.split('/').includes('..')) fail('invalid_cloudflare_artifact');
      if (entry.isDirectory()) {
        if (kind !== 'pages' || !['assets', '.well-known'].includes(relative)) fail('invalid_cloudflare_artifact');
        await visit(join(path, entry.name), relative + '/');
      } else {
        if (kind !== 'pages' && !['index.js', 'index.js.map', 'README.md'].includes(relative)) fail('invalid_cloudflare_artifact');
        if (kind === 'pages' && !(relative === '_headers' || relative === '.well-known/farcaster.json' ||
          /^(?:assets\/)?[A-Za-z0-9_-]+\.(?:(?:js|css)(?:\.map)?|html|png|svg|ico|webp|txt|xml|map)$/.test(relative))) fail('invalid_cloudflare_artifact');
        const bytes = await readBounded(join(path, entry.name)); total += bytes.length;
        if (files.length >= 1000 || total > 32_000_000) fail('cloudflare_artifact_limit');
        files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
      }
    }
  }
  await visit(directory);
  if (!files.some(file => file.path === definitions[kind].entry && file.bytes > 0)) fail('cloudflare_artifact_entry_missing');
  if (kind === 'pages' && !files.some(file => file.path === '.well-known/farcaster.json')) fail('cloudflare_manifest_missing');
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
async function metadata(repository, kind, source, files) {
  const def = identity(kind, source), root = resolve(repository, def.root);
  const lock = await readBounded(join(root, 'package-lock.json'));
  const installed = JSON.parse((await readBounded(join(root, 'node_modules/wrangler/package.json'), 64_000)).toString());
  const locked = JSON.parse(lock.toString()).packages?.['node_modules/wrangler']?.version;
  if (!locked || installed.version !== locked) fail('cloudflare_cli_lock_mismatch');
  const config = def.config ? await readBounded(join(root, def.config), 128_000) : null;
  if (config) {
    const parsed = JSON.parse(config.toString());
    const allowed = new Set(['$schema', 'name', 'main', 'compatibility_date', 'compatibility_flags', 'workers_dev', 'observability',
      ...(kind === 'core' ? ['browser', 'r2_buckets', 'd1_databases', 'vars', 'triggers'] : ['services', 'ratelimits', 'vars'])]);
    if (Object.keys(parsed).some(key => !allowed.has(key)) || parsed.name !== def.name || !['src/index.ts', 'src/entry/index.ts'].includes(parsed.main)) fail('unreviewed_cloudflare_build_config');
  }
  return { schema: 'delta-verified-cloudflare/v1', source_commit: source, kind, project_name: def.name,
    entry: def.entry, dependency_lock_sha256: hash(lock), wrangler_version: locked,
    config_sha256: config ? hash(config) : null, files };
}
export async function recordCloudflareArtifact({ directory, repository, kind, source }) {
  const def = identity(kind, source), build = resolve(repository, def.root, 'dist');
  const files = await filesIn(build, kind);
  const manifest = await metadata(repository, kind, source, files);
  await mkdir(directory, { recursive: false });
  await mkdir(join(directory, 'payload'));
  for (const item of files) {
    const bytes = await readBounded(join(build, item.path));
    if (hash(bytes) !== item.sha256 || bytes.length !== item.bytes) fail('cloudflare_artifact_changed');
    const parent = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
    if (parent) await mkdir(join(directory, 'payload', parent), { recursive: true });
    const file = await open(join(directory, 'payload', item.path), 'wx');
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  }
  const file = await open(join(directory, 'verified-artifact.json'), 'wx');
  try { await file.writeFile(JSON.stringify(manifest, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  await loadCloudflareArtifact({ directory, repository, kind, source });
  return manifest;
}
export async function loadCloudflareArtifact({ directory, repository, kind, source }) {
  identity(kind, source);
  const manifest = JSON.parse((await readBounded(join(directory, 'verified-artifact.json'), 256_000)).toString());
  const files = await filesIn(join(directory, 'payload'), kind);
  const expected = await metadata(repository, kind, source, files);
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) fail('cloudflare_artifact_mismatch');
  return manifest;
}
export async function deployCloudflareArtifact({ directory, repository, kind, source, authorization, run }) {
  assertReleaseAuthorization({ ...authorization, source });
  const manifest = await loadCloudflareArtifact({ directory, repository, kind, source });
  const def = definitions[kind], root = resolve(repository, def.root);
  const cli = join(root, 'node_modules/wrangler/bin/wrangler.js');
  const args = kind === 'pages'
    ? [cli, 'pages', 'deploy', resolve(directory, 'payload'), '--project-name', def.name, '--branch', 'master']
    : [cli, 'deploy', resolve(directory, 'payload', def.entry), '--no-bundle', '--config', join(root, def.config)];
  // Trusted isolated CI directory, not an arbitrary-writer filesystem CAS.
  // No build callback and no retry after an uncertain provider result.
  await run(process.execPath, args, { cwd: root });
  await loadCloudflareArtifact({ directory, repository, kind, source });
  return { submission_completed: true, online_acceptance: false, manifest };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, directory, kind] = process.argv.slice(2);
    const repository = fileURLToPath(new URL('..', import.meta.url));
    const input = { directory: resolve(directory), repository, kind, source: process.env.GITHUB_SHA };
    let result;
    if (mode === 'record') result = await recordCloudflareArtifact(input);
    else if (mode === 'verify') result = await loadCloudflareArtifact(input);
    else if (mode === 'deploy' && process.env.GITHUB_ACTIONS === 'true') result = await deployCloudflareArtifact({ ...input,
      authorization: { event: process.env.GITHUB_EVENT_NAME, execute: process.env.DELTA_EXECUTE_RELEASE,
        requested: process.env.DELTA_REQUESTED_SOURCE, approved: process.env.DELTA_APPROVED_SOURCE,
        rollbackSource: process.env.DELTA_ROLLBACK_SOURCE, rollbackArtifact: process.env.DELTA_ROLLBACK_ARTIFACT_SHA256 },
      run: async (exe, args, options) => { execFileSync(exe, args, { ...options, stdio: 'inherit', timeout: 180_000 }); } });
    else fail('approved_cloudflare_release_required');
    console.log(JSON.stringify(result));
  } catch { console.error(JSON.stringify({ ok: false, error: 'cloudflare_artifact_or_release_unconfirmed' })); process.exitCode = 1; }
}
