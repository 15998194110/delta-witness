// Import-safe release qualification. Local tests inject registry and publication
// callbacks; CLI publication is allowed only inside the separately approved job.
import { open, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const NAMES = new Set(['delta-witness-ruphussten', 'delta-witness-mcp']);
const SOURCE = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const fail = code => { throw new Error(code); };
async function boundedFile(path, max) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) fail('invalid_release_artifact');
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(stat.size + 1); let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await file.read(bytes, position, bytes.length - position, position);
      if (!bytesRead) break; position += bytesRead;
    }
    if (position !== stat.size || (await file.stat()).size !== stat.size) fail('release_artifact_changed_during_read');
    return bytes.subarray(0, position);
  } finally { await file.close(); }
}
function archivedPackage(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 50_000_000 });
  let found;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const str = (start, end) => header.subarray(start, end).toString('utf8').split('\0')[0];
    const name = [str(345, 500), str(0, 100)].filter(Boolean).join('/');
    const rawSize = str(124, 136).trim();
    if (!/^[0-7]+$/.test(rawSize) || !name.startsWith('package/') || name.split('/').includes('..') || name.includes('\\')) fail('invalid_npm_archive');
    const size = parseInt(rawSize, 8), type = str(156, 157);
    if (!Number.isSafeInteger(size) || !['', '0', '5'].includes(type) || offset + 512 + size > tar.length) fail('invalid_npm_archive');
    if (name === 'package/package.json') {
      if (found || size > 64_000 || type === '5') fail('invalid_npm_package_metadata');
      found = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString('utf8'));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!found || !NAMES.has(found.name) || !VERSION.test(found.version)) fail('invalid_npm_package_identity');
  return found;
}
function expectedIdentity(name, source) {
  if (!NAMES.has(name) || !SOURCE.test(source) || /^0+$/.test(source)) fail('approved_npm_identity_required');
}
export async function recordVerifiedNpmArtifact(directory, packageRoot, name, source) {
  expectedIdentity(name, source);
  const list = JSON.parse((await boundedFile(join(directory, 'pack.json'), 128_000)).toString('utf8'));
  const local = JSON.parse((await boundedFile(join(packageRoot, 'package.json'), 64_000)).toString('utf8'));
  if (!Array.isArray(list) || list.length !== 1 || !list[0] || local.name !== name || !VERSION.test(local.version)) fail('invalid_npm_pack_record');
  const packed = list[0], filename = `${name}-${local.version}.tgz`;
  if (packed.filename !== filename || packed.name !== name || packed.version !== local.version) fail('npm_pack_identity_mismatch');
  const bytes = await boundedFile(join(directory, filename), 16_000_000), metadata = archivedPackage(bytes);
  if (metadata.name !== name || metadata.version !== local.version || integrity(bytes) !== packed.integrity) fail('npm_pack_content_mismatch');
  const manifest = { schema: 'delta-verified-npm/v1', source_commit: source, package_name: name,
    version: local.version, filename, bytes: bytes.length, sha256: sha256(bytes), integrity: integrity(bytes) };
  const file = await open(join(directory, 'verified-artifact.json'), 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(manifest, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  return manifest;
}
export async function loadVerifiedNpmArtifact(directory, name, source) {
  expectedIdentity(name, source);
  const manifest = JSON.parse((await boundedFile(join(directory, 'verified-artifact.json'), 4096)).toString('utf8'));
  if (!manifest || manifest.schema !== 'delta-verified-npm/v1' || manifest.source_commit !== source || manifest.package_name !== name ||
      !VERSION.test(manifest.version) || manifest.filename !== `${name}-${manifest.version}.tgz` || basename(manifest.filename) !== manifest.filename) fail('verified_npm_identity_mismatch');
  const path = join(directory, manifest.filename), bytes = await boundedFile(path, 16_000_000), metadata = archivedPackage(bytes);
  if (metadata.name !== name || metadata.version !== manifest.version || manifest.bytes !== bytes.length ||
      manifest.sha256 !== sha256(bytes) || manifest.integrity !== integrity(bytes)) fail('verified_npm_artifact_mismatch');
  return { manifest, path };
}
export async function reconcileVerifiedNpmArtifact({ directory, name, source, lookup, publish }) {
  const { manifest, path } = await loadVerifiedNpmArtifact(directory, name, source);
  const matches = record => record && record.name === name && record.version === manifest.version && record.dist?.integrity === manifest.integrity;
  const existing = await lookup(name, manifest.version);
  if (existing !== null) {
    if (!matches(existing)) fail('existing_npm_version_has_different_artifact');
    return { ok: true, action: 'existing_exact_artifact', ...manifest };
  }
  // Only this callback may publish, exactly once. Uncertain publication/readback
  // fails this run; a later run checks the original immutable version again.
  // Revalidate after asynchronous registry I/O. This job requires a trusted,
  // isolated artifact directory; this check is not an arbitrary-writer FS CAS.
  const current = await loadVerifiedNpmArtifact(directory, name, source);
  if (current.path !== path || JSON.stringify(current.manifest) !== JSON.stringify(manifest)) fail('verified_npm_artifact_mismatch');
  await publish(path);
  if (!matches(await lookup(name, manifest.version))) fail('npm_publication_readback_unconfirmed');
  return { ok: true, action: 'published_exact_artifact', ...manifest };
}
export async function registryVersion(name, version, fetchImpl = fetch) {
  expectedIdentity(name, 'a'.repeat(40));
  if (!VERSION.test(version)) fail('invalid_npm_version');
  const controller = new AbortController(); let reader, timer;
  try {
    return await Promise.race([
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => {}); reject(new Error('npm_registry_unavailable')); }, 15_000); }),
      (async () => {
        const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, { redirect: 'error', signal: controller.signal });
        if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); fail('npm_registry_unavailable'); }
        if (response.status === 404) { void response.body?.cancel().catch(() => {}); return null; }
        if (response.status !== 200 || !response.body) { void response.body?.cancel().catch(() => {}); fail('npm_registry_unavailable'); }
        reader = response.body.getReader(); const chunks = []; let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) fail('npm_registry_unavailable');
          if (done) break;
          size += value.byteLength; if (size > 128_000) fail('npm_registry_response_limit'); chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      })(),
    ]);
  } finally { clearTimeout(timer); void reader?.cancel().catch(() => {}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, directory, name] = process.argv.slice(2), source = process.env.GITHUB_SHA;
    let result;
    if (mode === 'record') result = await recordVerifiedNpmArtifact(directory, process.cwd(), name, source);
    else if (mode === 'publish' && process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      process.env.DELTA_EXECUTE_RELEASE === 'true' && process.env.DELTA_APPROVED_SOURCE === source) {
      result = await reconcileVerifiedNpmArtifact({ directory, name, source, lookup: registryVersion,
        publish: async path => { execFileSync('npm', ['publish', path, '--access', 'public', '--provenance', '--ignore-scripts', '--registry=https://registry.npmjs.org'], { stdio: 'inherit', timeout: 120_000 }); } });
    } else fail('approved_npm_release_required');
    console.log(JSON.stringify(result));
  } catch (error) {
    const allowed = /^(approved_npm_identity_required|invalid_release_artifact|release_artifact_changed_during_read|invalid_npm_archive|invalid_npm_package_metadata|invalid_npm_package_identity|invalid_npm_pack_record|npm_pack_identity_mismatch|npm_pack_content_mismatch|verified_npm_identity_mismatch|verified_npm_artifact_mismatch|existing_npm_version_has_different_artifact|npm_publication_readback_unconfirmed|npm_registry_unavailable|npm_registry_response_limit|invalid_npm_version|approved_npm_release_required)$/;
    console.error(JSON.stringify({ ok: false, error: allowed.test(error?.message) ? error.message : 'npm_release_unconfirmed' })); process.exitCode = 1;
  }
}
