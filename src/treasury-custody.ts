import type { RuntimeEnv } from './env';
import { withinDeadline } from './deadline';
import { validateCustodyRevision, type CustodyRevision } from '../scripts/treasury-checkpoint-store.mjs';

export const TREASURY_CUSTODY_PREFIX = 'operations/treasury/revisions/';
export const TREASURY_CUSTODY_DEADLINE_MS = 20_000;
const BASE = '/internal/operations/treasury';
const MAX_BYTES = 16_000_000, MAX_TOTAL = 64_000_000, MAX_VERSION = 10000;
const DIGEST = /^[0-9a-f]{64}$/;
const NETWORK = 'eip155:8453', ASSET = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', TREASURY = '0x1990e21bc219696ff7fbc26527dbaed335ac6367';
type CustodyEnv = RuntimeEnv & { TREASURY_CUSTODY_ENABLED?: string; TREASURY_CUSTODY_ORIGIN_BLOCK?: string;
  TREASURY_CUSTODY_MINIMUM_VERSION?: string; TREASURY_CUSTODY_MINIMUM_DIGEST?: string; TREASURY_CUSTODY_ALLOW_BOOTSTRAP?: string };
type Configuration = { ok: true; schema: 'delta-treasury-custody-config/v1'; origin_block: number;
  minimum_revision: { version: number; digest: string } | null; allow_bootstrap: boolean; network: string; asset: string; treasury: string };
const key = (version: number) => `${TREASURY_CUSTODY_PREFIX}revision-${String(version).padStart(10, '0')}.json`;
const answer = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw Error('invalid_custody_integer');
  const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw Error('invalid_custody_integer'); return n;
}
function configuration(env: CustodyEnv): Configuration {
  if (env.TREASURY_CUSTODY_ENABLED !== 'true' || env.NETWORK !== NETWORK || env.PAY_TO?.toLowerCase() !== TREASURY) throw Error('custody_not_configured');
  const origin = integer(env.TREASURY_CUSTODY_ORIGIN_BLOCK, 0, Number.MAX_SAFE_INTEGER);
  const version = integer(env.TREASURY_CUSTODY_MINIMUM_VERSION, 0, MAX_VERSION);
  const digest = env.TREASURY_CUSTODY_MINIMUM_DIGEST;
  if (version > 0 ? !digest || !DIGEST.test(digest) : env.TREASURY_CUSTODY_ALLOW_BOOTSTRAP !== 'true' || !!digest) throw Error('custody_not_configured');
  return { ok: true, schema: 'delta-treasury-custody-config/v1', origin_block: origin,
    minimum_revision: version ? { version, digest: digest! } : null, allow_bootstrap: version === 0,
    network: NETWORK, asset: ASSET, treasury: TREASURY };
}

// Authentication belongs to the shared private operations router. This module
// additionally fails closed on absent approved custody configuration.
export async function handleTreasuryCustody(request: Request, env: CustodyEnv): Promise<Response> {
  let active = true, writeStarted = false, total = 0;
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const cancel = () => { active = false; for (const reader of readers) void reader.cancel().catch(() => {}); };
  const check = () => { if (!active || request.signal.aborted) throw Error('custody_deadline'); };
  const bytes = async (body: ReadableStream<Uint8Array> | null, declared?: number): Promise<Uint8Array> => {
    check();
    if (!body || declared !== undefined && (!Number.isSafeInteger(declared) || declared < 1 || declared > MAX_BYTES)) throw Error('custody_body_unavailable');
    const reader = body.getReader(); readers.add(reader); const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const part = await reader.read(); check(); if (part.done) break;
        if (!(part.value instanceof Uint8Array)) throw Error('custody_body_unavailable');
        length += part.value.byteLength; total += part.value.byteLength;
        if (length > MAX_BYTES || total > MAX_TOTAL || declared !== undefined && length > declared) throw Error('custody_body_limit');
        chunks.push(part.value);
      }
      if (!length || declared !== undefined && length !== declared) throw Error('custody_body_unavailable');
      const all = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; } return all;
    } finally { readers.delete(reader); void reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
  const parse = (value: Uint8Array): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value));
  try {
    return await withinDeadline((async () => {
      const config = configuration(env), url = new URL(request.url), cache = new Map<number, CustodyRevision | null>();
      const load = async (version: number): Promise<CustodyRevision | null> => {
        if (cache.has(version)) return cache.get(version)!; check();
        const stored = await env.PROOFS.get(key(version));
        if (!active || request.signal.aborted) { void stored?.body?.cancel().catch(() => {}); check(); }
        if (!stored) { cache.set(version, null); return null; }
        const item = parse(await bytes(stored.body, stored.size)) as CustodyRevision;
        if (version === 1 ? item?.previous_digest !== null : !DIGEST.test(item?.previous_digest ?? '')) throw Error('custody_chain_invalid');
        const valid = await validateCustodyRevision(item, { originBlock: config.origin_block, expectedVersion: version, previousDigest: item.previous_digest }); check();
        cache.set(version, valid); return valid;
      };
      if (config.minimum_revision) {
        const floor = await load(config.minimum_revision.version);
        if (!floor || floor.digest !== config.minimum_revision.digest) throw Error('custody_floor_unavailable');
      }
      if (url.pathname === `${BASE}/config` && request.method === 'GET' && !url.search) return answer(config);
      if (url.pathname === `${BASE}/revisions` && request.method === 'GET') {
        if ([...url.searchParams.keys()].some(name => !['cursor', 'limit'].includes(name)) || [...url.searchParams.keys()].some(name => url.searchParams.getAll(name).length !== 1)) return answer({ ok: false, error: 'invalid_custody_query' }, 400);
        const cursor = url.searchParams.get('cursor') ?? undefined;
        if (cursor !== undefined && (!cursor || cursor.length > 512)) return answer({ ok: false, error: 'invalid_custody_query' }, 400);
        const limit = integer(url.searchParams.get('limit') ?? '1000', 1, 1000); check();
        const page = await env.PROOFS.list({ prefix: TREASURY_CUSTODY_PREFIX, limit, ...(cursor ? { cursor } : {}) }); check();
        if (!Array.isArray(page.objects) || page.objects.length > limit || typeof page.truncated !== 'boolean' ||
          page.truncated && (!page.cursor || page.cursor.length > 512) || page.delimitedPrefixes?.length) throw Error('custody_inventory_unavailable');
        const versions = page.objects.map(row => {
          const match = /^operations\/treasury\/revisions\/revision-([0-9]{10})\.json$/.exec(row.key);
          if (!match) throw Error('custody_inventory_unavailable');
          return integer(String(Number(match[1])), 1, MAX_VERSION);
        });
        if (new Set(versions).size !== versions.length) throw Error('custody_inventory_unavailable');
        return answer({ versions, cursor: page.truncated ? page.cursor : null });
      }
      const match = /^\/internal\/operations\/treasury\/revisions\/([1-9][0-9]{0,4})$/.exec(url.pathname);
      if (!match || url.search) return answer({ ok: false, error: 'custody_route_not_found' }, 404);
      const version = integer(match[1], 1, MAX_VERSION);
      if (request.method === 'GET') {
        const item = await load(version); return item ? answer(item) : answer({ ok: false, error: 'custody_revision_not_found' }, 404);
      }
      if (request.method !== 'POST') return answer({ ok: false, error: 'custody_method_not_allowed' }, 405);
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return answer({ ok: false, error: 'custody_json_required' }, 415);
      if (config.minimum_revision && version <= config.minimum_revision.version) return answer({ ok: false, error: 'treasury_custody_conflict', created: false }, 409);
      const raw = await bytes(request.body), item = parse(raw);
      const previous = version > 1 ? await load(version - 1) : null;
      if (version > 1 && !previous) return answer({ ok: false, error: 'treasury_custody_conflict', created: false }, 409);
      if (version === 1) {
        if (!config.allow_bootstrap) return answer({ ok: false, error: 'treasury_custody_conflict', created: false }, 409);
        const existing = await env.PROOFS.list({ prefix: TREASURY_CUSTODY_PREFIX, limit: 1 }); check();
        if (!Array.isArray(existing.objects) || typeof existing.truncated !== 'boolean') throw Error('custody_inventory_unavailable');
        if (existing.objects.length || existing.truncated) return answer({ ok: false, error: 'treasury_custody_conflict', created: false }, 409);
      }
      const valid = await validateCustodyRevision(item, { originBlock: config.origin_block, expectedVersion: version, previousDigest: previous?.digest ?? null }); check();
      if (previous && valid.state.checked_through_block < previous.state.checked_through_block) return answer({ ok: false, error: 'treasury_custody_conflict', created: false }, 409);
      // Original bytes + original schema; one conditional create. A late commit
      // is possible after timeout, but no overwrite or automatic resend occurs.
      check(); writeStarted = true;
      const result = await env.PROOFS.put(key(version), raw, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } }); check();
      return result ? answer({ ok: true, created: true, version, digest: valid.digest }, 201) : answer({ ok: false, error: 'treasury_custody_conflict', created: false }, 409);
    })(), TREASURY_CUSTODY_DEADLINE_MS, 'treasury_custody_deadline', cancel);
  } catch {
    return answer({ ok: false, error: writeStarted ? 'treasury_custody_write_unknown' : 'treasury_custody_unavailable', retryable: false }, 503);
  } finally { cancel(); }
}
