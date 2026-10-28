import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, open, link, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { failure, validateCheckpoint } from './treasury-reconciliation.mjs';

const hash = state => createHash('sha256').update(JSON.stringify(state)).digest('hex');
const revisionName = n => `revision-${String(n).padStart(10, '0')}.json`;
const MAX_BYTES = 16_000_000;

// Explicit caller-selected local evidence store, not a new production database.
// A revision is immutable. Atomic same-filesystem link publishes exactly one
// winner at each version. No stale-lock removal, overwrite, or unknown-order deletion.
export function fileCheckpointStore(directory) {
  async function read() {
    let names;
    try {
      const entries = await readdir(directory);
      if (entries.length > 20000) throw failure('checkpoint_entry_limit');
      names = entries.filter(n => /^revision-[0-9]{10}\.json$/.test(n)).sort();
    }
    catch (error) { if (error.code === 'ENOENT') return null; throw failure('checkpoint_read_failed'); }
    if (names.length > 10000) throw failure('checkpoint_revision_limit');
    let previousDigest = null;
    let latest = null;
    let totalBytes = 0;
    for (let i = 0; i < names.length; i++) {
      if (names[i] !== revisionName(i + 1)) throw failure('checkpoint_revision_gap');
      let item;
      try {
        const size = (await stat(join(directory, names[i]))).size;
        totalBytes += size;
        if (size > MAX_BYTES || totalBytes > 64000000) throw failure('checkpoint_body_limit');
        const raw = await readFile(join(directory, names[i]));
        if (raw.byteLength > MAX_BYTES) throw failure('checkpoint_body_limit');
        item = JSON.parse(raw.toString('utf8'));
      } catch (error) { throw error.category ? error : failure('checkpoint_corrupt'); }
      if (item.schema !== 'delta-treasury-revision/v1' || item.version !== i + 1 || item.previous_digest !== previousDigest || item.digest !== hash(item.state)) throw failure('checkpoint_chain_invalid');
      validateCheckpoint(item.state);
      if (latest && (item.state.origin_block !== latest.state.origin_block || item.state.checked_through_block < latest.state.checked_through_block)) throw failure('checkpoint_cursor_regressed');
      latest = item;
      previousDigest = item.digest;
    }
    return latest;
  }
  return {
    read,
    async compareAndSwap(expectedVersion, state) {
      validateCheckpoint(state);
      await mkdir(directory, { recursive: true });
      const current = await read();
      if ((current?.version ?? null) !== expectedVersion) return null;
      if (current && (state.origin_block !== current.state.origin_block || state.checked_through_block < current.state.checked_through_block)) throw failure('checkpoint_cursor_regressed');
      const version = (current?.version ?? 0) + 1;
      const item = { schema: 'delta-treasury-revision/v1', version, previous_digest: current?.digest ?? null, digest: hash(state), state };
      const body = JSON.stringify(item);
      if (Buffer.byteLength(body) > MAX_BYTES || version > 10000) throw failure('checkpoint_capacity_reached');
      const candidate = join(directory, `candidate-${randomUUID()}.json`);
      const handle = await open(candidate, 'wx', 0o600);
      try { await handle.writeFile(body, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      try { await link(candidate, join(directory, revisionName(version))); }
      catch (error) { if (error.code === 'EEXIST') return null; throw failure('checkpoint_publish_failed'); }
      // Retain candidate files as crash/evidence artifacts; no implicit pruning.
      return item;
    },
  };
}
