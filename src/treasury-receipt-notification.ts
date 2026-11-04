// A projection of original, verified custody snapshots into the existing owner
// outbox. It cannot settle payments, recognize customer revenue or send mail.
import type { RuntimeEnv } from './env';
import { sha256, stableJson } from './crypto';
import { withinDeadline } from './deadline';
import { createClaim, commitClaim } from './claims';
import { createOrderReadSnapshot, readOrderMetadata } from './order-storage';
import { validateCustodyRevision, type CustodyRevision } from '../scripts/treasury-checkpoint-store.mjs';
import { TREASURY_CUSTODY_PREFIX } from './treasury-custody';
import { enqueueOperatingAlert, readOperatingAlert, type TreasuryNotificationObservation } from './operating-alert-outbox';

export const TREASURY_NOTIFICATION_CURSOR_KEY = 'operations/treasury/notifications/cursor.json';
export const TREASURY_NOTIFICATION_DEADLINE_MS = 20_000;
export const TREASURY_NOTIFICATION_BATCH = 4;
export const TREASURY_NOTIFICATION_SOURCE_FRESHNESS_MS = 2 * 60 * 60 * 1000;
// Projection capacity only. Oversize evidence stays intact and holds this
// consumer; it never means the Treasury failed to receive funds or earned zero.
const MAX_BYTES = 1_000_000, MAX_TOTAL = 3_000_000, MAX_VERSION = 10000;
const NETWORK = 'eip155:8453', ASSET = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', TREASURY = '0x1990e21bc219696ff7fbc26527dbaed335ac6367';
const DIGEST = /^[0-9a-f]{64}$/;
const iso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
type Receipt = { receipt_id: string; tx_hash: string; log_index: number; block_number: number; block_hash: string; raw_amount: string; usdc_decimal: string;
  payer_classification: 'unclassified' | 'nohumans_platform_verification' | 'payapi_platform_verification' };
type Correction = { kind: 'removed' | 'replaced'; receipt_id: string; previous: Receipt; replacement: Receipt | null; observed_at: string };
type State = CustodyRevision['state'] & { checked_at: string; confirmation_depth: number; transfers: Receipt[]; corrections: Correction[] };
type Revision = CustodyRevision & { state: State };
type Projection = { receipt: Receipt; correction: Correction | null };
type Source = RuntimeEnv & { OPERATIONS_TREASURY_NOTIFICATIONS_ENABLED?: string; TREASURY_CUSTODY_ENABLED?: string;
  TREASURY_CUSTODY_ORIGIN_BLOCK?: string; TREASURY_CUSTODY_MINIMUM_VERSION?: string; TREASURY_CUSTODY_MINIMUM_DIGEST?: string };
type Cursor = { schema: 'delta-treasury-notification-cursor/v1'; generation: number; origin_block: number; anchor_version: number; anchor_digest: string;
  revision: number; digest: string; offset: number; complete: boolean; updated_at: string; source_observed_at: string; last_selected: number };
const exact = (v: unknown, fields: string[]) => !!v && typeof v === 'object' && Object.keys(v).sort().join(',') === [...fields].sort().join(',');
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw Error('notification_configuration_unavailable');
  const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw Error('notification_configuration_unavailable'); return n;
}
function validCursor(v: Cursor, origin: number, floor: number, digest: string, now: number) {
  return exact(v, ['schema','generation','origin_block','anchor_version','anchor_digest','revision','digest','offset','complete','updated_at','source_observed_at','last_selected']) &&
    v.schema === 'delta-treasury-notification-cursor/v1' && Number.isSafeInteger(v.generation) && v.generation > 0 &&
    v.origin_block === origin && v.anchor_version === floor && v.anchor_digest === digest && Number.isSafeInteger(v.revision) && v.revision >= floor && v.revision <= MAX_VERSION &&
    DIGEST.test(v.digest) && Number.isSafeInteger(v.offset) && v.offset >= 0 && v.offset <= 60000 && typeof v.complete === 'boolean' &&
    iso(v.updated_at) && Date.parse(v.updated_at) <= now && iso(v.source_observed_at) && Date.parse(v.source_observed_at) <= Date.parse(v.updated_at) &&
    Number.isSafeInteger(v.last_selected) && v.last_selected >= 0 && v.last_selected <= TREASURY_NOTIFICATION_BATCH;
}

// The immutable source schema carries full snapshots. Read only adjacent
// revisions, never list or replay the entire custody inventory on every tick.
function project(current: Revision, previous: Revision | null): Projection[] {
  const state = current.state;
  if (!previous) return state.transfers.map(receipt => ({ receipt, correction: null }));
  if (state.checked_through_block < previous.state.checked_through_block || Date.parse(state.checked_at) < Date.parse(previous.state.checked_at) ||
    state.corrections.length < previous.state.corrections.length ||
    previous.state.corrections.some((c, i) => stableJson(c) !== stableJson(state.corrections[i]))) throw Error('notification_custody_history_conflict');
  const corrections = state.corrections.slice(previous.state.corrections.length);
  const prior = new Map(previous.state.transfers.map(r => [r.receipt_id, r]));
  for (const c of corrections) {
    if (stableJson(prior.get(c.receipt_id) ?? null) !== stableJson(c.previous) || c.kind === 'replaced' &&
      (c.previous.block_hash === c.replacement!.block_hash || stableJson(c.previous) === stableJson(c.replacement))) throw Error('notification_correction_conflict');
    if (c.replacement) prior.set(c.receipt_id, c.replacement); else prior.delete(c.receipt_id);
  }
  const actual = new Map(state.transfers.map(r => [r.receipt_id, r]));
  for (const [id, receipt] of prior) if (stableJson(actual.get(id) ?? null) !== stableJson(receipt)) throw Error('notification_correction_missing');
  const events: Projection[] = corrections.map(c => ({ receipt: c.replacement ?? c.previous, correction: c }));
  for (const r of state.transfers) if (!prior.has(r.receipt_id)) events.push({ receipt: r, correction: null });
  return events;
}
async function observation(item: Projection, revision: Revision): Promise<TreasuryNotificationObservation> {
  const r = item.receipt, c = item.correction, s = revision.state;
  const code = c ? 'treasury_receipt_corrected' : 'treasury_received';
  const subject = (await sha256(stableJson([r.receipt_id, r.block_hash]))).slice(7);
  const identity = c ? (await sha256(stableJson(c))).slice(7) : `observed-${revision.version}`;
  return { dedupe_key: `delta:${code}:${subject}:${identity}`, code, subject, severity: 'INFO', stage: 'initial',
    first_seen_at: s.checked_at, evidence_ref: `treasury-revision-${revision.version}-${revision.digest}`,
    receipt: { network: NETWORK, asset: ASSET, treasury: TREASURY, receipt_id: r.receipt_id, tx_hash: r.tx_hash, log_index: r.log_index,
      block_number: r.block_number, block_hash: r.block_hash, raw_amount: r.raw_amount, usdc_decimal: r.usdc_decimal,
      confirmation_depth: s.confirmation_depth, observed_at: s.checked_at, custody_revision: revision.version, custody_digest: revision.digest,
      occurrence: !c && s.corrections.some(prior => prior.kind === 'removed' && prior.receipt_id === r.receipt_id) ? 'reobserved_after_removal' : 'initial_observation',
      payer_classification: r.payer_classification, customer_revenue: r.payer_classification === 'unclassified' ? 'UNKNOWN' : 'EXCLUDED', actual_cost: 'UNKNOWN', contribution_margin: 'UNKNOWN', fulfillment: 'UNKNOWN',
      correction: c ? { kind: c.kind, previous_block_hash: c.previous.block_hash, previous_raw_amount: c.previous.raw_amount } : null } };
}

export async function persistTreasuryReceiptNotifications(source: Source) {
  const base = { selected: 0, established: 0, customer_revenue: 'UNKNOWN', actual_cost: 'UNKNOWN', notification_delivered: null } as const;
  if (source.OPERATIONS_CLOUD_ENABLED !== 'true' || source.OPERATIONS_ALERT_OUTBOX_ENABLED !== 'true' || source.OPERATIONS_TREASURY_NOTIFICATIONS_ENABLED !== 'true')
    return { ...base, state: 'disabled', cursor_state: 'retained' };
  const snapshot = createOrderReadSnapshot(source), env = snapshot.env, readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  let active = true, total = 0, selected = 0, established = 0, blocked = 0, failed = 0;
  const cancel = () => { active = false; snapshot.cancel(); for (const reader of readers) void reader.cancel().catch(() => {}); };
  const check = () => { if (!active) throw Error('notification_projection_deadline'); snapshot.assertActive(); };
  try { return await withinDeadline((async () => {
    if (source.TREASURY_CUSTODY_ENABLED !== 'true' || source.NETWORK !== NETWORK || source.PAY_TO?.toLowerCase() !== TREASURY) throw Error('notification_custody_unavailable');
    // No unanchored bootstrap, including a configured minimum version of zero.
    const origin = integer(source.TREASURY_CUSTODY_ORIGIN_BLOCK, 0), floor = integer(source.TREASURY_CUSTODY_MINIMUM_VERSION, 1, MAX_VERSION), digest = source.TREASURY_CUSTODY_MINIMUM_DIGEST;
    if (!digest || !DIGEST.test(digest)) throw Error('notification_custody_unavailable');
    const cache = new Map<number, Revision | null>();
    const load = async (version: number): Promise<Revision | null> => {
      if (cache.has(version)) return cache.get(version)!; check();
      const stored = await source.PROOFS.get(`${TREASURY_CUSTODY_PREFIX}revision-${String(version).padStart(10, '0')}.json`);
      if (!active) { void stored?.body?.cancel().catch(() => {}); check(); }
      if (!stored) { cache.set(version, null); return null; }
      if (!Number.isSafeInteger(stored.size) || stored.size < 1 || stored.size > MAX_BYTES || total + stored.size > MAX_TOTAL || !stored.body) {
        void stored.body?.cancel().catch(() => {}); throw Error('notification_custody_size');
      }
      const reader = stored.body.getReader(), bytes = new Uint8Array(stored.size); readers.add(reader); let length = 0;
      try {
        while (true) { const part = await reader.read(); check(); if (part.done) break;
          if (!(part.value instanceof Uint8Array) || length + part.value.byteLength > stored.size) throw Error('notification_custody_size');
          bytes.set(part.value, length); length += part.value.byteLength; }
        if (length !== stored.size) throw Error('notification_custody_size'); total += length;
      } finally { readers.delete(reader); void reader.cancel().catch(() => {}); reader.releaseLock(); }
      const item = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
      if (version === 1 ? item.previous_digest !== null : !DIGEST.test(item.previous_digest ?? '')) throw Error('notification_custody_chain');
      const validated = await validateCustodyRevision(item, { originBlock: origin, expectedVersion: version, previousDigest: item.previous_digest }) as Revision; check();
      if (Date.parse(validated.state.checked_at) > Date.now() || validated.state.corrections.some(c => Date.parse(c.observed_at) > Date.parse(validated.state.checked_at))) throw Error('notification_custody_future');
      cache.set(version, validated); return validated;
    };
    const anchored = await load(floor); check(); if (!anchored || anchored.digest !== digest) throw Error('notification_custody_floor');
    const priorCursor = await readOrderMetadata<Cursor>(env, TREASURY_NOTIFICATION_CURSOR_KEY); check();
    if (priorCursor && !validCursor(priorCursor.record, origin, floor, digest, Date.now())) throw Error('notification_cursor_invalid');
    let current = await load(priorCursor?.record.revision ?? floor), previous: Revision | null = null, offset = priorCursor?.record.offset ?? 0;
    if (!current || priorCursor && (priorCursor.record.digest !== current.digest || priorCursor.record.source_observed_at !== current.state.checked_at)) throw Error('notification_cursor_source_conflict');
    if (current.version > floor) previous = await load(current.version - 1);
    if (current.version > floor && (!previous || current.previous_digest !== previous.digest)) throw Error('notification_custody_chain');
    let events = project(current, previous); check();
    // Completion is not trusted from the cursor alone. Rebuild its exact source
    // delta before following the next revision, including the no-next path.
    if (offset > events.length || priorCursor && priorCursor.record.complete !== (offset === events.length)) throw Error('notification_cursor_offset');
    if (priorCursor?.record.complete) {
      if (current.version >= MAX_VERSION) return { ...base, state: 'degraded', reason: 'custody_capacity_reached', cursor_state: 'retained' };
      const next = await load(current.version + 1); check();
      if (!next) { const stale = Date.now() - Date.parse(current.state.checked_at) > TREASURY_NOTIFICATION_SOURCE_FRESHNESS_MS;
        return { ...base, state: stale ? 'degraded' : 'observed', reason: stale ? 'source_stale' : 'next_revision_not_observed', cursor_state: 'retained', source_revision: current.version, source_observed_at: current.state.checked_at, next_revision: current.version + 1, latest_inventory_verified: false }; }
      previous = current; current = next; offset = 0;
      if (current.previous_digest !== previous.digest) throw Error('notification_custody_chain');
      events = project(current, previous); check();
    }
    const batch = events.slice(offset, offset + TREASURY_NOTIFICATION_BATCH); selected = batch.length;
    const destination = source.OPERATIONS_ALERT_DESTINATION_ID && source.OPERATIONS_ALERT_DESTINATION_DIGEST ?
      { id: source.OPERATIONS_ALERT_DESTINATION_ID, digest: source.OPERATIONS_ALERT_DESTINATION_DIGEST } : null;
    for (const item of batch) {
      const event = await observation(item, current); check();
      await enqueueOperatingAlert(env, event, destination); check();
      const stored = await readOperatingAlert(env, event.dedupe_key); check();
      // Blocked/failed transport still retains the original immutable obligation.
      // The producer confirms persistence, never claims send/delivery success.
      if (!stored || stableJson(stored.episode) !== stableJson(event)) throw Error('notification_outbox_unconfirmed');
      if (stored.state === 'blocked') blocked++;
      if (stored.state === 'failed') failed++;
      established++;
    }
    const cursor: Cursor = { schema: 'delta-treasury-notification-cursor/v1', generation: (priorCursor?.record.generation ?? 0) + 1,
      origin_block: origin, anchor_version: floor, anchor_digest: digest, revision: current.version, digest: current.digest,
      offset: offset + batch.length, complete: offset + batch.length === events.length, updated_at: new Date().toISOString(),
      source_observed_at: current.state.checked_at, last_selected: selected };
    if (!validCursor(cursor, origin, floor, digest, Date.now())) throw Error('notification_cursor_exhausted');
    check(); try { if (priorCursor) await commitClaim(env, TREASURY_NOTIFICATION_CURSOR_KEY, priorCursor, cursor); else await createClaim(env, TREASURY_NOTIFICATION_CURSOR_KEY, cursor); }
    catch { /* Read the exact original cursor. No unconditional rewrite or skip. */ }
    check(); const actual = await readOrderMetadata<Cursor>(env, TREASURY_NOTIFICATION_CURSOR_KEY); check();
    const matched = !!actual && stableJson(actual.record) === stableJson(cursor);
    const stale = Date.now() - Date.parse(current.state.checked_at) > TREASURY_NOTIFICATION_SOURCE_FRESHNESS_MS;
    return { ...base, selected, established, blocked, failed, state: matched && !blocked && !failed && !stale ? 'observed' : 'degraded', reason: stale ? 'source_stale' : blocked || failed ? 'transport_pending_or_failed' : matched ? 'outbox_persisted_only' : 'cursor_unconfirmed', cursor_state: matched ? 'advanced' : 'unconfirmed',
      source_revision: current.version, source_observed_at: current.state.checked_at, revision_complete: cursor.complete, next_offset: matched ? cursor.offset : null,
      evidence_ref: TREASURY_NOTIFICATION_CURSOR_KEY, scope: 'anchored_checkpoint_receipts_only', latest_inventory_verified: false };
  })(), TREASURY_NOTIFICATION_DEADLINE_MS, 'treasury_notification_projection_deadline', cancel); }
  catch { return { ...base, selected, established, state: 'unavailable', cursor_state: 'retained', reason: 'original_treasury_notification_evidence_unavailable' }; }
  finally { cancel(); }
}

// A bounded cursor read for the private status view. No source inventory scan,
// provider call or financial-recognition claim; absence is UNKNOWN, not zero.
export async function readTreasuryReceiptNotificationStatus(source: Source, now = Date.now()) {
  const enabled = source.OPERATIONS_CLOUD_ENABLED === 'true' && source.OPERATIONS_ALERT_OUTBOX_ENABLED === 'true' && source.OPERATIONS_TREASURY_NOTIFICATIONS_ENABLED === 'true';
  const unavailable = { enabled, state: enabled ? 'unavailable' : 'disabled', source_revision: null, source_observed_at: null,
    cursor_progress: null, updated_at: null, freshness: 'UNKNOWN', notification_delivered: null, customer_revenue: 'UNKNOWN',
    scope: 'notification_cursor_observation_only', source_freshness_limit_ms: TREASURY_NOTIFICATION_SOURCE_FRESHNESS_MS } as const;
  if (!enabled) return unavailable;
  const snapshot = createOrderReadSnapshot(source);
  try { return await withinDeadline((async () => {
    const origin = integer(source.TREASURY_CUSTODY_ORIGIN_BLOCK, 0), floor = integer(source.TREASURY_CUSTODY_MINIMUM_VERSION, 1, MAX_VERSION), digest = source.TREASURY_CUSTODY_MINIMUM_DIGEST;
    if (source.TREASURY_CUSTODY_ENABLED !== 'true' || source.NETWORK !== NETWORK || source.PAY_TO?.toLowerCase() !== TREASURY || !digest || !DIGEST.test(digest)) return unavailable;
    const stored = await readOrderMetadata<Cursor>(snapshot.env, TREASURY_NOTIFICATION_CURSOR_KEY); snapshot.assertActive();
    if (!stored || !validCursor(stored.record, origin, floor, digest, now)) return unavailable;
    const r = stored.record;
    return { ...unavailable, state: 'observed', source_revision: r.revision, source_observed_at: r.source_observed_at,
      cursor_progress: { offset: r.offset, revision_complete: r.complete }, updated_at: r.updated_at,
      freshness: now - Date.parse(r.source_observed_at) > unavailable.source_freshness_limit_ms ? 'STALE' : 'FRESH',
      evidence_ref: TREASURY_NOTIFICATION_CURSOR_KEY };
  })(), 5000, 'treasury_notification_status_deadline', snapshot.cancel); }
  catch { return unavailable; } finally { snapshot.cancel(); }
}
