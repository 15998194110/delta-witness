import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertReleaseAuthorization } from './check-release-authorization.mjs';

// Official v0.1 ServerResponse separates publisher-owned server data from
// registry-owned outer _meta. No field inside server is silently discarded.
// https://raw.githubusercontent.com/modelcontextprotocol/registry/main/docs/reference/api/openapi.yaml
// https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
const OFFICIAL = 'io.modelcontextprotocol.registry/official';
const STATUS_KEYS = ['status', 'statusMessage', 'statusChangedAt', 'publishedAt', 'updatedAt', 'isLatest'];
const fail = code => { throw new Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function canonical(value, depth = 0) {
  if (depth > 32) fail('mcp_metadata_depth_limit');
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}';
  if (value === undefined || typeof value === 'function' || typeof value === 'number' && !Number.isFinite(value)) fail('invalid_mcp_metadata');
  return JSON.stringify(value);
}
function validateExpected(expected) {
  if (!object(expected) || typeof expected.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9._-]+$/.test(expected.name) ||
      expected.name.length > 200 || typeof expected.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(expected.version) ||
      expected.version.length > 100 || !Array.isArray(expected.packages) || !expected.packages.length) fail('invalid_mcp_metadata');
  canonical(expected);
}
function validateEnvelope(record) {
  if (!object(record) || Object.keys(record).some(key => !['server', '_meta'].includes(key)) || !object(record.server) ||
      !object(record._meta) || Object.keys(record._meta).some(key => key !== OFFICIAL)) fail('mcp_registry_invalid_response');
  const official = record._meta[OFFICIAL];
  if (!object(official) || Object.keys(official).some(key => !STATUS_KEYS.includes(key)) ||
      !['active', 'deprecated', 'deleted'].includes(official.status) ||
      (official.isLatest !== undefined && typeof official.isLatest !== 'boolean') ||
      (official.statusMessage !== undefined && (typeof official.statusMessage !== 'string' || official.statusMessage.length > 500)) ||
      ['publishedAt', 'updatedAt', 'statusChangedAt'].some(key => official[key] !== undefined &&
        (typeof official[key] !== 'string' || !Number.isFinite(Date.parse(official[key]))))) fail('mcp_registry_invalid_response');
  return official;
}
export function registryMetadataStatus(expected, record) {
  validateExpected(expected);
  const official = validateEnvelope(record);
  if (canonical(record.server) !== canonical(expected)) return 'metadata_mismatch';
  return official.status === 'active' ? 'match' : 'inactive';
}

export async function lookupMcpVersion(expected, fetchImpl = fetch) {
  validateExpected(expected);
  // Exact version + include_deleted avoids substring-search pagination and
  // avoids treating an existing tombstone as permission to publish again.
  const url = `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(expected.name)}/versions/${encodeURIComponent(expected.version)}?include_deleted=true`;
  const controller = new AbortController(); let reader, timer;
  try {
    return await Promise.race([
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); void reader?.cancel().catch(() => {}); reject(new Error('mcp_registry_unavailable'));
      }, 15_000); }),
      (async () => {
        const response = await fetchImpl(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: controller.signal });
        if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); fail('mcp_registry_unavailable'); }
        if (response.status === 404) { void response.body?.cancel().catch(() => {}); return null; }
        if (response.status !== 200 || !response.body) { void response.body?.cancel().catch(() => {}); fail('mcp_registry_unavailable'); }
        reader = response.body.getReader(); const chunks = []; let bytes = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (controller.signal.aborted) fail('mcp_registry_unavailable');
          if (done) break;
          bytes += value.byteLength; if (bytes > 128_000) fail('mcp_registry_response_limit'); chunks.push(value);
        }
        let payload;
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('mcp_registry_invalid_response'); }
        validateEnvelope(payload);
        return payload;
      })(),
    ]);
  } finally { clearTimeout(timer); void reader?.cancel().catch(() => {}); }
}

export async function reconcileMcpPublication({ expected, lookup, publish }) {
  validateExpected(expected);
  const plan = structuredClone(expected);
  const existing = await lookup(structuredClone(plan));
  if (existing !== null) {
    const state = registryMetadataStatus(plan, existing);
    if (state !== 'match') fail(state === 'inactive' ? 'existing_mcp_version_inactive' : 'existing_mcp_metadata_mismatch');
    return { ok: true, action: 'existing_exact_metadata', name: plan.name, version: plan.version };
  }
  // A single attempted publication, never retry on an uncertain/duplicate exit.
  // Error text is not evidence. Only the exact active post-readback can confirm.
  let publisherResult = 'returned';
  try { await publish(structuredClone(plan)); } catch (error) {
    if (['mcp_metadata_changed', 'invalid_mcp_metadata'].includes(error?.message)) throw error;
    publisherResult = 'uncertain_exit';
  }
  const readback = await lookup(structuredClone(plan));
  if (readback === null || registryMetadataStatus(plan, readback) !== 'match') fail('mcp_publication_readback_unconfirmed');
  return { ok: true, action: 'metadata_confirmed_after_single_attempt', publisher_result: publisherResult, name: plan.name, version: plan.version };
}

async function readExpected(file) {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > 32_000) fail('invalid_mcp_metadata');
    const bytes = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length !== stat.size || (await handle.stat()).size !== stat.size) fail('mcp_metadata_changed');
    const expected = JSON.parse(bytes.subarray(0, length).toString('utf8')); validateExpected(expected); return expected;
  } finally { await handle.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [file = 'server.json', mode] = process.argv.slice(2);
    if (mode !== undefined && mode !== '--publish-if-absent') fail('invalid_mcp_check_mode');
    if (mode) {
      if (process.env.GITHUB_ACTIONS !== 'true') fail('release_not_authorized_for_exact_candidate');
      assertReleaseAuthorization({ event: process.env.GITHUB_EVENT_NAME, execute: process.env.DELTA_EXECUTE_RELEASE, source: process.env.GITHUB_SHA,
        requested: process.env.DELTA_REQUESTED_SOURCE, approved: process.env.DELTA_APPROVED_SOURCE,
        rollbackSource: process.env.DELTA_ROLLBACK_SOURCE, rollbackArtifact: process.env.DELTA_ROLLBACK_ARTIFACT_SHA256 });
    }
    const expected = await readExpected(file);
    if (mode) {
      const result = await reconcileMcpPublication({ expected, lookup: lookupMcpVersion, publish: async plan => {
        // Approved trusted CI workspace only, not a claim of arbitrary-writer
        // filesystem CAS. Re-read after registry I/O and after login.
        const unchanged = async () => { if (canonical(await readExpected(file)) !== canonical(plan)) fail('mcp_metadata_changed'); };
        await unchanged();
        execFileSync(resolve('mcp-publisher'), ['login', 'github-oidc'], { stdio: 'ignore', timeout: 60_000 });
        await unchanged();
        execFileSync(resolve('mcp-publisher'), ['publish', file], { stdio: 'ignore', timeout: 60_000 });
      } });
      console.log(JSON.stringify(result));
    } else {
      const record = await lookupMcpVersion(expected);
      if (record === null) { console.log(JSON.stringify({ ok: false, state: 'absent' })); process.exitCode = 2; }
      else {
        const status = registryMetadataStatus(expected, record);
        if (status !== 'match') fail(status === 'inactive' ? 'existing_mcp_version_inactive' : 'existing_mcp_metadata_mismatch');
        console.log(JSON.stringify({ ok: true, state: 'exact_metadata_active', name: expected.name, version: expected.version }));
      }
    }
  } catch (error) {
    const allowed = /^(invalid_mcp_metadata|mcp_metadata_depth_limit|mcp_registry_invalid_response|mcp_registry_unavailable|mcp_registry_response_limit|existing_mcp_version_inactive|existing_mcp_metadata_mismatch|mcp_publication_readback_unconfirmed|mcp_metadata_changed|invalid_mcp_check_mode|release_not_authorized_for_exact_candidate)$/;
    console.error(JSON.stringify({ ok: false, error: allowed.test(error?.message) ? error.message : 'mcp_registry_unconfirmed' })); process.exitCode = 1;
  }
}
