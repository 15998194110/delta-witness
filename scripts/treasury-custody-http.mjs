import { continuousCheckpointStore } from './treasury-checkpoint-store.mjs';

export const TREASURY_CUSTODY_ORIGIN = 'https://delta-witness-api.ruphussten.workers.dev';
const BASE = `${TREASURY_CUSTODY_ORIGIN}/internal/operations/treasury`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const fail = category => Object.assign(new Error(category), { category, retryable: false });
const bytes = async (body, limit, signal) => {
  if (!body) throw fail('custody_http_body_missing');
  const reader = body.getReader(), parts = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw fail('custody_http_timeout');
      const part = await reader.read(); if (signal.aborted) throw fail('custody_http_timeout');
      if (part.done) break; size += part.value.byteLength;
      if (size > limit) throw fail('custody_http_body_limit'); parts.push(part.value);
    }
    const output = new Uint8Array(size); let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.byteLength; } return output;
  } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
};
const parse = value => { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value)); } catch { throw fail('custody_http_invalid_json'); } };

export function createTreasuryHttpAuthority({ secret, fetchImpl = globalThis.fetch, requestTimeoutMs = 5000 } = {}) {
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 4096 || /\s/.test(secret)) throw fail('custody_http_credential_required');
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 15000) throw fail('custody_http_budget_invalid');
  async function request(path, { method = 'GET', payload, signal, maxBytes = 16000000 } = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) throw fail('custody_http_path_invalid');
    const attempts = method === 'GET' ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal?.aborted) throw fail('custody_http_timeout');
      const controller = new AbortController(), abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true }); let timer;
      try {
        const result = await Promise.race([
          (async () => {
            const response = await fetchImpl(`${BASE}${path}`, { method, redirect: 'error', cache: 'no-store',
              headers: { authorization: `Bearer ${secret}`, accept: 'application/json', ...(payload ? { 'content-type': 'application/json' } : {}) },
              ...(payload ? { body: payload } : {}), signal: controller.signal });
            if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw fail('custody_http_timeout'); }
            return { status: response.status, bytes: await bytes(response.body, maxBytes, controller.signal) };
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => { reject(fail('custody_http_timeout')); controller.abort(); }, requestTimeoutMs); }),
        ]);
        if (method === 'GET' && attempt + 1 < attempts && (result.status === 429 || result.status >= 500)) continue;
        return result;
      } catch (error) {
        if (method === 'GET' && attempt + 1 < attempts && !signal?.aborted && (!error?.category || error.category === 'custody_http_timeout')) continue;
        throw fail(error?.category === 'custody_http_body_limit' ? 'custody_http_body_limit' : 'custody_http_unavailable');
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
    }
    throw fail('custody_http_unavailable');
  }
  const config = async () => {
    const result = await request('/config', { maxBytes: 32000 }); if (result.status !== 200) throw fail('custody_http_config_unavailable');
    const c = parse(result.bytes);
    if (!keys(c, ['ok', 'schema', 'origin_block', 'minimum_revision', 'allow_bootstrap', 'network', 'asset', 'treasury']) || c.ok !== true || c.schema !== 'delta-treasury-custody-config/v1' || !Number.isSafeInteger(c.origin_block) || c.origin_block < 0 ||
      c.network !== 'eip155:8453' || c.asset !== '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' || c.treasury !== '0x1990e21bc219696ff7fbc26527dbaed335ac6367' ||
      (c.minimum_revision === null ? c.allow_bootstrap !== true : !keys(c.minimum_revision, ['version', 'digest']) || !Number.isSafeInteger(c.minimum_revision.version) || c.minimum_revision.version < 1 || c.minimum_revision.version > 10000 || !/^[0-9a-f]{64}$/.test(c.minimum_revision.digest) || c.allow_bootstrap !== false)) throw fail('custody_http_config_invalid');
    return c;
  };
  const versionPath = version => {
    if (!Number.isSafeInteger(version) || version < 1 || version > 10000) throw fail('custody_http_version_invalid');
    return `/revisions/${version}`;
  };
  return { config,
    async listRevisions({ cursor, limit, signal }) {
      if (!(cursor === null || typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 512) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail('custody_http_inventory_request_invalid');
      const query = new URLSearchParams({ limit: String(limit), ...(cursor === null ? {} : { cursor }) });
      const response = await request(`/revisions?${query}`, { signal, maxBytes: 32000 });
      if (response.status !== 200) throw fail('custody_http_inventory_unavailable'); return parse(response.bytes);
    },
    async getRevision(version, { signal }) {
      const response = await request(versionPath(version), { signal });
      if (response.status === 404) {
        const missing = parse(response.bytes);
        if (missing?.ok === false && missing.error === 'custody_revision_not_found') return null;
        throw fail('custody_http_read_unavailable');
      }
      if (response.status !== 200) throw fail('custody_http_read_unavailable');
      return { body: new ReadableStream({ start(controller) { controller.enqueue(response.bytes); controller.close(); } }) };
    },
    async putRevisionIfAbsent(version, payload, { signal }) {
      if (!(payload instanceof Uint8Array) || !payload.byteLength || payload.byteLength > 16000000) throw fail('custody_http_body_limit');
      const response = await request(versionPath(version), { method: 'POST', payload, signal, maxBytes: 32000 }), body = parse(response.bytes);
      if (response.status === 409 && body?.error === 'treasury_custody_conflict' && body.created === false) return { created: false };
      if (response.status !== 201 || body?.ok !== true || body.created !== true || body.version !== version) throw fail('custody_http_write_unknown');
      return { created: true };
    },
  };
}

export async function configuredRemoteCheckpointStore(env = process.env, dependencies = {}) {
  const authority = createTreasuryHttpAuthority({ ...dependencies, secret: env.DELTA_OPERATIONS_ADMIN_SECRET });
  const config = await authority.config();
  const checkpointStore = continuousCheckpointStore({ authority, originBlock: config.origin_block,
    minimumRevision: config.minimum_revision, allowBootstrap: config.allow_bootstrap });
  return { checkpointStore, initialBlock: config.origin_block, config };
}
