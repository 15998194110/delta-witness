import { evidenceInteger, failure, validateCheckpoint } from './treasury-reconciliation.mjs';

const MAX_REVISION_BYTES = 16_000_000;
const MAX_TOTAL_BYTES = 64_000_000;
const MAX_VERSIONS = 10_000;
const DIGEST = /^[0-9a-f]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const aborted = signal => { if (signal.aborted) throw failure('checkpoint_custody_timeout'); };

// Pure validation exports also work in a Worker: no Node modules, credentials,
// filesystem access or provider-specific requests are imported by this module.
export async function checkpointRevisionDigest(state) {
  let bytes;
  try { bytes = new TextEncoder().encode(JSON.stringify(state)); }
  catch { throw failure('checkpoint_custody_invalid_state'); }
  if (bytes.byteLength > MAX_REVISION_BYTES) throw failure('checkpoint_custody_body_limit');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function validateCustodyRevision(item, { originBlock, expectedVersion, previousDigest } = {}) {
  if (!object(item) || item.schema !== 'delta-treasury-revision/v1' || !DIGEST.test(item.digest ?? '')) throw failure('checkpoint_custody_revision_invalid');
  evidenceInteger(item.version, 'custody_version', 1, MAX_VERSIONS);
  if (item.version !== expectedVersion || item.previous_digest !== previousDigest) throw failure('checkpoint_custody_chain_invalid');
  validateCheckpoint(item.state);
  if (item.state.origin_block !== originBlock) throw failure('checkpoint_custody_origin_conflict');
  if (item.digest !== await checkpointRevisionDigest(item.state)) throw failure('checkpoint_custody_digest_mismatch');
  return item;
}

async function bounded(operation, milliseconds) {
  const controller = new AbortController(); let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => {
        reject(failure('checkpoint_custody_timeout'));
        controller.abort();
      }, milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function readBytes(record, remaining, signal) {
  if (!object(record) || !record.body || typeof record.body.getReader !== 'function') throw failure('checkpoint_custody_body_required');
  const limit = Math.min(MAX_REVISION_BYTES, remaining);
  const reader = record.body.getReader(); const parts = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    aborted(signal);
    while (true) {
      const chunk = await reader.read(); aborted(signal);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw failure('checkpoint_custody_body_invalid');
      size += chunk.value.byteLength;
      if (size > limit) throw failure('checkpoint_custody_body_limit');
      parts.push(chunk.value);
    }
    if (!size) throw failure('checkpoint_custody_body_invalid');
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    let item;
    try { item = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
    catch { throw failure('checkpoint_custody_corrupt'); }
    return { item, size };
  } finally {
    signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock();
  }
}

/**
 * Injected authority contract, not a deployed storage provider:
 * listRevisions({cursor,limit,signal}) -> {versions:number[],cursor:string|null}
 * getRevision(version,{signal}) -> {body:ReadableStream<Uint8Array>} | null
 * putRevisionIfAbsent(version,Uint8Array,{signal}) -> {created:boolean}
 *
 * The provider must supply complete strongly consistent inventory/readback and
 * atomic conditional creation of immutable revision-N objects. All writers use
 * the same scope/protocol; no overwrite/delete, partial-list-as-empty or auth
 * failure-as-absence is allowed. A provider transport is deliberately not guessed.
 */
export function continuousCheckpointStore({ authority, originBlock, minimumRevision = null, allowBootstrap = false,
  readTimeoutMs = 15000, writeTimeoutMs = 15000 } = {}) {
  evidenceInteger(originBlock, 'custody_origin');
  evidenceInteger(readTimeoutMs, 'custody_read_timeout', 1, 60000);
  evidenceInteger(writeTimeoutMs, 'custody_write_timeout', 1, 60000);
  if (!authority || ['listRevisions', 'getRevision', 'putRevisionIfAbsent'].some(key => typeof authority[key] !== 'function')) throw failure('checkpoint_custody_authority_required');
  if (minimumRevision !== null && (!object(minimumRevision) || !Number.isSafeInteger(minimumRevision.version) || minimumRevision.version < 1 || minimumRevision.version > MAX_VERSIONS || !DIGEST.test(minimumRevision.digest ?? ''))) throw failure('checkpoint_custody_floor_invalid');
  if (minimumRevision === null && allowBootstrap !== true) throw failure('checkpoint_custody_bootstrap_not_authorized');
  let floor = minimumRevision ? copy(minimumRevision) : null;
  let confirmed = null, pending = null, busy = false, writeState = 'not_attempted';

  async function inventory(signal) {
    const versions = new Set(), cursors = new Set(); let cursor = null;
    for (let page = 0; page < 100; page++) {
      aborted(signal);
      let answer;
      try { answer = await authority.listRevisions({ cursor, limit: 1000, signal }); }
      catch { throw failure('checkpoint_custody_inventory_unavailable'); }
      aborted(signal);
      if (!object(answer) || !Array.isArray(answer.versions) || answer.versions.length > 1000 ||
        !(answer.cursor === null || typeof answer.cursor === 'string' && answer.cursor.length > 0 && answer.cursor.length <= 512)) throw failure('checkpoint_custody_inventory_invalid');
      for (const version of answer.versions) {
        evidenceInteger(version, 'custody_inventory_version', 1, MAX_VERSIONS);
        if (versions.has(version)) throw failure('checkpoint_custody_inventory_duplicate');
        versions.add(version);
      }
      if (versions.size > MAX_VERSIONS) throw failure('checkpoint_custody_capacity_reached');
      if (answer.cursor === null) {
        const ordered = [...versions].sort((a, b) => a - b);
        if (ordered.some((version, index) => version !== index + 1)) throw failure('checkpoint_custody_revision_gap');
        return ordered;
      }
      if (cursors.has(answer.cursor)) throw failure('checkpoint_custody_inventory_cycle');
      cursors.add(answer.cursor); cursor = answer.cursor;
    }
    throw failure('checkpoint_custody_inventory_limit');
  }

  async function readHistory() {
    return bounded(async signal => {
      const versions = await inventory(signal), items = [];
      if (floor && versions.length < floor.version) throw failure('checkpoint_custody_below_trusted_floor');
      let previous = null, totalBytes = 0;
      for (const version of versions) {
        aborted(signal); let record;
        try { record = await authority.getRevision(version, { signal }); }
        catch { throw failure('checkpoint_custody_read_unavailable'); }
        if (signal.aborted) { void record?.body?.cancel().catch(() => {}); aborted(signal); }
        if (record === null) throw failure('checkpoint_custody_listed_revision_missing');
        const decoded = await readBytes(record, MAX_TOTAL_BYTES - totalBytes, signal);
        totalBytes += decoded.size;
        const item = await validateCustodyRevision(decoded.item, { originBlock, expectedVersion: version, previousDigest: previous?.digest ?? null });
        aborted(signal);
        if (previous && item.state.checked_through_block < previous.state.checked_through_block) throw failure('checkpoint_custody_cursor_regressed');
        if (floor?.version === version && floor.digest !== item.digest) throw failure('checkpoint_custody_floor_digest_mismatch');
        items.push(item); previous = item;
      }
      return { items, latest: previous };
    }, readTimeoutMs);
  }

  function acceptHistory(history) {
    confirmed = history.latest ? copy(history.latest) : null;
    if (confirmed) floor = { version: confirmed.version, digest: confirmed.digest };
    if (pending) {
      const observed = history.items[pending.version - 1];
      if (!observed) { writeState = 'unknown'; throw failure('checkpoint_custody_write_unknown_readback_required'); }
      const matched = observed.digest === pending.digest && observed.previous_digest === pending.previous_digest;
      writeState = matched ? 'confirmed_by_readback' : 'conflict';
      pending = null;
    }
    return confirmed ? copy(confirmed) : null;
  }

  async function exclusive(operation) {
    if (busy) throw failure('checkpoint_custody_operation_in_progress');
    busy = true;
    try { return await operation(); } finally { busy = false; }
  }

  return {
    async read() { return exclusive(async () => acceptHistory(await readHistory())); },
    async compareAndSwap(expectedVersion, suppliedState) {
      return exclusive(async () => {
        if (pending) throw failure('checkpoint_custody_write_unknown_readback_required');
        if (expectedVersion !== null) evidenceInteger(expectedVersion, 'custody_expected_version', 1, MAX_VERSIONS);
        let state;
        try { state = copy(suppliedState); } catch { throw failure('checkpoint_custody_invalid_state'); }
        validateCheckpoint(state);
        if (state.origin_block !== originBlock) throw failure('checkpoint_custody_origin_conflict');
        const current = acceptHistory(await readHistory());
        if ((current?.version ?? null) !== expectedVersion) { writeState = 'conflict'; return null; }
        if (current && state.checked_through_block < current.state.checked_through_block) throw failure('checkpoint_custody_cursor_regressed');
        const version = (current?.version ?? 0) + 1;
        if (version > MAX_VERSIONS) throw failure('checkpoint_custody_capacity_reached');
        const revision = { schema: 'delta-treasury-revision/v1', version, previous_digest: current?.digest ?? null,
          digest: await checkpointRevisionDigest(state), state };
        const bytes = new TextEncoder().encode(JSON.stringify(revision));
        if (bytes.byteLength > MAX_REVISION_BYTES) throw failure('checkpoint_custody_body_limit');
        pending = { version, digest: revision.digest, previous_digest: revision.previous_digest, expected_version: expectedVersion };
        writeState = 'pending';
        let definiteConflict = false;
        try {
          const acknowledgement = await bounded(async signal => {
            const response = await authority.putRevisionIfAbsent(version, bytes, { signal }); aborted(signal); return response;
          }, writeTimeoutMs);
          definiteConflict = acknowledgement?.created === false;
        } catch { /* Acknowledgement loss is unknown; only read, never resend. */ }
        let history;
        try { history = await readHistory(); }
        catch { writeState = 'unknown'; throw failure('checkpoint_custody_write_unknown_readback_required'); }
        const observed = history.items[version - 1];
        acceptHistory(history);
        if (!observed || observed.digest !== revision.digest || observed.previous_digest !== revision.previous_digest || definiteConflict) {
          writeState = 'conflict'; return null;
        }
        return copy(observed);
      });
    },
    getObservability() {
      return { scope: 'checkpoint_custody_only', provider_activation_verified: false, origin_block: originBlock,
        minimum_revision: floor ? copy(floor) : null, last_confirmed_revision: confirmed?.version ?? null,
        last_confirmed_cursor: confirmed?.state.checked_through_block ?? null, write_state: writeState,
        pending_write: pending ? copy(pending) : null,
        recognized_customer_revenue_usdc: null, actual_variable_cost_usdc: null, actual_contribution_margin_usdc: null };
    },
  };
}
