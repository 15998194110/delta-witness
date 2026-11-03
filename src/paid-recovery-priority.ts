// Operational priority references only. Original orders, settlement journals and
// fulfillment ETags remain the only authorities for a purchased delivery.
import type { RuntimeEnv } from './env';
import { commitClaim, createClaim, type StoredClaim } from './claims';
import { sha256, stableJson } from './crypto';
import { withinDeadline } from './deadline';
import { createOrderReadSnapshot, MetadataReadError, readOrderMetadata } from './order-storage';
import { orderAuthorityDigest, readOrderBinding } from './orders';
import { readOrderSettlement } from './settlement';
import { runPaidOrderRecovery, validatePaidOrderRecoveryResult, type PaidOrderRecoveryItem } from './paid-order-recovery';

export const PAID_RECOVERY_PRIORITY_PREFIX = 'operations/paid-order-recovery/priority/';
export const PAID_RECOVERY_PRIORITY_MAX_PENDING = 128;
export const PAID_RECOVERY_PRIORITY_MAX_BYTES = 65_536;
export const PAID_RECOVERY_PRIORITY_LEASE_MS = 120_000;
export const PAID_RECOVERY_PRIORITY_RETRY_MS = 900_000;
const INDEX_KEY = `${PAID_RECOVERY_PRIORITY_PREFIX}pending.json`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
type Entry = { order_id: string; identity_hash: string; enrolled_at: string; due_at: string; attempts: number;
  claim_id: string | null; lease_until: string | null };
type Index = { schema: 'delta-paid-recovery-priority-index/v1'; version: number; write_id: string; updated_at: string; entries: Entry[] };
type Observation = { schema: 'delta-paid-recovery-priority-order/v1'; order_id: string; identity_hash: string;
  state: 'resolved' | 'quarantined'; reason: PaidOrderRecoveryItem['reason']; observed_at: string; attempts: number };
type Options = { deadlineMs?: number; signal?: AbortSignal };
export type PaidRecoveryPriorityOptions = Options & { maxOrders?: number };
export type PaidRecoveryPriorityItem = { order_id: string; state: 'recovered' | 'complete' | 'skipped' | 'retry_scheduled' |
  'quarantined' | 'conflict' | 'write_unconfirmed'; reason: string };
export type PaidRecoveryPriorityResult = { outcome: 'success' | 'degraded'; reason: string; inventory_complete: false;
  counts: { selected: number; inspected: number; recovered: number; already_complete: number; skipped: number;
    retry_scheduled: number; quarantined: number; conflicts: number; write_unconfirmed: number }; items: PaidRecoveryPriorityItem[] };
const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const exact = (value: unknown, fields: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const safeCount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < Number.MAX_SAFE_INTEGER;
const recordKey = (id: string) => `${PAID_RECOVERY_PRIORITY_PREFIX}orders/${id}.json`;
const identityOf = async (env: RuntimeEnv, id: string) => {
  const order = await readOrderBinding(env, id);
  if (!order) return { reason: 'order_missing' as const };
  const journal = await readOrderSettlement(env, order);
  if (journal.state !== 'settlement_confirmed') return { reason: journal.state };
  return { identity: await sha256(stableJson({ order_id: id, binding: await orderAuthorityDigest(order),
    settlement_key: order.settlement_key, settlement: await sha256(stableJson(journal)) })), revoked: !!order.revoked_at };
};
function validEntry(value: unknown): value is Entry {
  return exact(value, ['order_id', 'identity_hash', 'enrolled_at', 'due_at', 'attempts', 'claim_id', 'lease_until']) &&
    typeof value.order_id === 'string' && UUID.test(value.order_id) && typeof value.identity_hash === 'string' && DIGEST.test(value.identity_hash) &&
    iso(value.enrolled_at) && iso(value.due_at) && Date.parse(value.due_at) >= Date.parse(value.enrolled_at) && safeCount(value.attempts) &&
    (value.claim_id === null && value.lease_until === null || typeof value.claim_id === 'string' && UUID.test(value.claim_id) && iso(value.lease_until));
}
function validIndex(value: unknown): value is Index {
  return exact(value, ['schema', 'version', 'write_id', 'updated_at', 'entries']) && value.schema === 'delta-paid-recovery-priority-index/v1' &&
    safeCount(value.version) && Number(value.version) > 0 && typeof value.write_id === 'string' && UUID.test(value.write_id) && iso(value.updated_at) &&
    Array.isArray(value.entries) && value.entries.length <= PAID_RECOVERY_PRIORITY_MAX_PENDING && value.entries.every(validEntry) &&
    new Set(value.entries.map(entry => entry.order_id)).size === value.entries.length;
}
const RESOLVED = ['original_delivery_recovered', 'already_complete', 'raw_artifacts_expired', 'order_revoked'];
const QUARANTINED = ['order_missing', 'order_changed', 'evidence_inconsistent', 'settlement_unknown', 'settlement_rejected'];
function validObservation(value: unknown): value is Observation {
  return exact(value, ['schema', 'order_id', 'identity_hash', 'state', 'reason', 'observed_at', 'attempts']) &&
    value.schema === 'delta-paid-recovery-priority-order/v1' && typeof value.order_id === 'string' && UUID.test(value.order_id) &&
    typeof value.identity_hash === 'string' && DIGEST.test(value.identity_hash) && iso(value.observed_at) && safeCount(value.attempts) &&
    typeof value.reason === 'string' && (value.state === 'resolved' && RESOLVED.includes(value.reason) || value.state === 'quarantined' && QUARANTINED.includes(value.reason));
}
type Context = { env: RuntimeEnv; check: () => void; signal: AbortSignal };
async function budget<T>(source: RuntimeEnv, options: Options, defaultMs: number, operation: (ctx: Context) => Promise<T>): Promise<T> {
  const milliseconds = options.deadlineMs ?? defaultMs;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 90_000) throw new Error('paid_priority_options_invalid');
  const snapshot = createOrderReadSnapshot(source, PAID_RECOVERY_PRIORITY_MAX_BYTES), controller = new AbortController();
  const stop = () => { controller.abort(); snapshot.cancel(); };
  const check = () => { snapshot.assertActive(); if (controller.signal.aborted || options.signal?.aborted) throw new Error('paid_priority_cancelled'); };
  let rejectAbort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => { stop(); rejectAbort?.(new Error('paid_priority_cancelled')); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    check();
    return await withinDeadline(Promise.race([operation({ env: snapshot.env, check, signal: controller.signal }), aborted]), milliseconds, 'paid_priority_deadline', stop);
  } finally { stop(); options.signal?.removeEventListener('abort', onAbort); }
}
async function readIndex(ctx: Context) {
  ctx.check(); const stored = await readOrderMetadata<Index>(ctx.env, INDEX_KEY, PAID_RECOVERY_PRIORITY_MAX_BYTES); ctx.check();
  if (stored && !validIndex(stored.record)) throw new Error('paid_priority_index_invalid');
  return stored;
}
async function readObservation(ctx: Context, entry: Pick<Entry, 'order_id' | 'identity_hash'>) {
  ctx.check(); const stored = await readOrderMetadata<Observation>(ctx.env, recordKey(entry.order_id)); ctx.check();
  if (stored && (!validObservation(stored.record) || stored.record.order_id !== entry.order_id || stored.record.identity_hash !== entry.identity_hash))
    throw new Error('paid_priority_observation_invalid');
  return stored;
}
// Only an explicit CAS rejection permits a bounded re-read/rebase. Unknown
// acknowledgements are read back under the same write identity, never retried.
async function mutateIndex(ctx: Context, change: (entries: Entry[]) => Entry[] | null) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const prior = await readIndex(ctx), entries = change(prior?.record.entries ?? []);
    if (entries === null) return { state: 'unchanged' as const, record: prior?.record ?? null };
    if (entries.length > PAID_RECOVERY_PRIORITY_MAX_PENDING) throw new Error('paid_priority_index_full');
    const next: Index = { schema: 'delta-paid-recovery-priority-index/v1', version: (prior?.record.version ?? 0) + 1,
      write_id: crypto.randomUUID(), updated_at: new Date().toISOString(), entries };
    if (!validIndex(next) || new TextEncoder().encode(JSON.stringify(next)).byteLength > PAID_RECOVERY_PRIORITY_MAX_BYTES)
      throw new Error('paid_priority_index_invalid');
    let saved: StoredClaim<Index> | null;
    try { ctx.check(); saved = prior ? await commitClaim(ctx.env, INDEX_KEY, prior, next) : await createClaim(ctx.env, INDEX_KEY, next); }
    catch {
      ctx.check(); const actual = await readIndex(ctx);
      return { state: 'unconfirmed' as const, record: actual?.record ?? null };
    }
    ctx.check();
    if (!saved) continue;
    const actual = await readIndex(ctx);
    // A later concurrent transition may already have advanced this index. That
    // grants no authority to a stale lease or a stale result writer.
    return { state: actual?.etag === saved.etag && stableJson(actual.record) === stableJson(next) ? 'saved' as const : 'conflict' as const,
      record: actual?.record ?? null };
  }
  return { state: 'conflict' as const, record: null };
}
const sameEntry = (left: Entry, right: Entry) => left.order_id === right.order_id && left.identity_hash === right.identity_hash;
const owned = (left: Entry, right: Entry) => sameEntry(left, right) && left.claim_id === right.claim_id && left.attempts === right.attempts;
const currentOwner = (left: Entry, right: Entry) => owned(left, right) && left.lease_until !== null && Date.parse(left.lease_until) > Date.now();
const due = (entry: Entry, now: number) => Date.parse(entry.due_at) <= now && (entry.lease_until === null || Date.parse(entry.lease_until) <= now);

export async function enqueuePaidRecoveryPriority(source: RuntimeEnv, orderId: string, options: Options = {}) {
  if (!UUID.test(orderId)) return { outcome: 'not_eligible' as const, reason: 'invalid_order_id' };
  try { return await budget(source, options, 5_000, async ctx => {
    const original = await identityOf(ctx.env, orderId); ctx.check();
    if (!original.identity || original.revoked) return { outcome: 'not_eligible' as const, reason: original.reason ?? 'order_revoked' };
    const now = new Date().toISOString(), entry: Entry = { order_id: orderId, identity_hash: original.identity, enrolled_at: now,
      due_at: now, attempts: 0, claim_id: null, lease_until: null };
    const observation = await readObservation(ctx, entry);
    if (observation) return { outcome: observation.record.state === 'resolved' ? 'terminal' as const : 'quarantined' as const, reason: observation.record.reason };
    let existing = false;
    const changed = await mutateIndex(ctx, entries => {
      const found = entries.find(row => row.order_id === orderId);
      if (found) { if (!sameEntry(found, entry)) throw new Error('paid_priority_identity_changed'); existing = true; return null; }
      return [...entries, entry];
    });
    if (changed.state === 'unconfirmed' || changed.state === 'conflict') return { outcome: 'degraded' as const, reason: 'enrollment_unconfirmed' };
    return { outcome: existing ? 'already_pending' as const : 'enqueued' as const, reason: 'confirmed_original_obligation' };
  }); } catch { return { outcome: 'degraded' as const, reason: 'enrollment_unconfirmed' }; }
}

async function saveObservation(ctx: Context, entry: Entry, state: Observation['state'], reason: Observation['reason']) {
  const prior = await readObservation(ctx, entry);
  if (prior) return prior;
  const observed: Observation = { schema: 'delta-paid-recovery-priority-order/v1', order_id: entry.order_id,
    identity_hash: entry.identity_hash, state, reason, observed_at: new Date().toISOString(), attempts: entry.attempts };
  try { ctx.check(); await createClaim(ctx.env, recordKey(entry.order_id), observed); } catch { /* exact original readback below */ }
  ctx.check(); const actual = await readObservation(ctx, entry);
  return actual && stableJson(actual.record) === stableJson(observed) ? actual : null;
}
async function finish(ctx: Context, entry: Entry, result: PaidOrderRecoveryItem): Promise<PaidRecoveryPriorityItem> {
  const current = await readIndex(ctx);
  if (!current?.record.entries.some(row => currentOwner(row, entry)))
    return { order_id: entry.order_id, state: 'conflict', reason: 'priority_lease_changed' };
  const resolved = RESOLVED.includes(result.reason), quarantined = QUARANTINED.includes(result.reason);
  if (resolved || quarantined) {
    const observed = await saveObservation(ctx, entry, resolved ? 'resolved' : 'quarantined', result.reason);
    if (!observed) return { order_id: entry.order_id, state: 'write_unconfirmed', reason: 'observation_unconfirmed' };
    // Quarantine is retained readback evidence about an unresolved original,
    // never proof that delivery was completed or a financial obligation ended.
    const removed = await mutateIndex(ctx, entries => entries.some(row => currentOwner(row, entry)) ? entries.filter(row => !owned(row, entry)) : null);
    if (removed.state === 'unchanged' || removed.state === 'conflict') return { order_id: entry.order_id, state: 'conflict', reason: 'priority_lease_changed' };
    if (removed.state !== 'saved') return { order_id: entry.order_id, state: 'write_unconfirmed', reason: 'priority_update_unconfirmed' };
    return { order_id: entry.order_id, state: observed.record.state === 'quarantined' ? 'quarantined' : result.state === 'recovered' ? 'recovered' :
      result.state === 'complete' ? 'complete' : 'skipped', reason: observed.record.reason };
  }
  const delay = Math.min(86_400_000, PAID_RECOVERY_PRIORITY_RETRY_MS * 2 ** Math.min(7, entry.attempts - 1));
  const next: Entry = { ...entry, due_at: new Date(Date.now() + delay).toISOString(), claim_id: null, lease_until: null };
  const updated = await mutateIndex(ctx, entries => entries.some(row => currentOwner(row, entry)) ? entries.map(row => owned(row, entry) ? next : row) : null);
  return { order_id: entry.order_id, state: updated.state === 'saved' ? 'retry_scheduled' : updated.state === 'unchanged' || updated.state === 'conflict' ? 'conflict' : 'write_unconfirmed', reason: result.reason };
}

export async function drainPaidRecoveryPriority(source: RuntimeEnv, options: PaidRecoveryPriorityOptions = {}): Promise<PaidRecoveryPriorityResult> {
  const maxOrders = options.maxOrders ?? 5;
  if (!Number.isSafeInteger(maxOrders) || maxOrders < 1 || maxOrders > 10) throw new Error('paid_priority_options_invalid');
  const result: PaidRecoveryPriorityResult = { outcome: 'success', reason: 'none', inventory_complete: false,
    counts: { selected: 0, inspected: 0, recovered: 0, already_complete: 0, skipped: 0, retry_scheduled: 0, quarantined: 0, conflicts: 0, write_unconfirmed: 0 }, items: [] };
  const append = (item: PaidRecoveryPriorityItem) => {
    result.items.push(item); result.counts.inspected++;
    if (item.state === 'recovered') result.counts.recovered++;
    else if (item.state === 'complete') result.counts.already_complete++;
    else if (item.state === 'skipped') result.counts.skipped++;
    else {
      result.outcome = 'degraded'; result.reason = 'priority_requires_reconciliation';
      if (item.state === 'conflict') result.counts.conflicts++;
      else result.counts[item.state]++;
    }
  };
  try { await budget(source, options, 45_000, async ctx => {
    const index = await readIndex(ctx), now = Date.now();
    const selected = (index?.record.entries ?? []).filter(entry => due(entry, now))
      .sort((a, b) => a.due_at.localeCompare(b.due_at) || a.enrolled_at.localeCompare(b.enrolled_at) || a.order_id.localeCompare(b.order_id)).slice(0, maxOrders);
    result.counts.selected = selected.length;
    // A stalled first original has a separate budget, leaving later obligations
    // a fair share of this invocation. Cancellation fences all late continuations.
    const itemMs = Math.max(1, Math.min(8_000, Math.floor((options.deadlineMs ?? 45_000) / (maxOrders + 1))));
    const executionMs = Math.max(1, Math.floor(itemMs * 0.8)), cleanupMs = Math.max(1, itemMs - executionMs);
    for (const candidate of selected) {
      ctx.check();
      let entry: Entry | undefined;
      let acknowledgedEntry: Entry | undefined;
      const item = await budget(source, { deadlineMs: executionMs, signal: ctx.signal }, executionMs, async itemCtx => {
        const claimed = await mutateIndex(itemCtx, entries => {
          const found = entries.find(row => sameEntry(row, candidate));
          if (!found || !due(found, Date.now())) return null;
          entry = { ...found, attempts: found.attempts + 1, claim_id: crypto.randomUUID(), lease_until: new Date(Date.now() + PAID_RECOVERY_PRIORITY_LEASE_MS).toISOString() };
          return entries.map(row => sameEntry(row, candidate) ? entry! : row);
        });
        if (!entry || claimed.state !== 'saved') return { order_id: candidate.order_id, state: claimed.state === 'unconfirmed' ? 'write_unconfirmed' as const : 'conflict' as const, reason: 'priority_lease_unconfirmed' };
        acknowledgedEntry = entry;
        const prior = await readObservation(itemCtx, entry);
        if (prior) return finish(itemCtx, entry, { order_id: entry.order_id,
          state: prior.record.state === 'quarantined' ? 'reconciliation_required' : prior.record.reason === 'already_complete' || prior.record.reason === 'original_delivery_recovered' ? 'complete' : 'skipped', reason: prior.record.reason });
        let original: Awaited<ReturnType<typeof identityOf>>;
        try { original = await identityOf(itemCtx.env, entry.order_id); itemCtx.check(); }
        catch (error) { itemCtx.check(); return finish(itemCtx, entry, { order_id: entry.order_id, state: 'reconciliation_required',
          reason: error instanceof MetadataReadError ? 'evidence_unavailable' : 'evidence_inconsistent' }); }
        if (!original.identity || original.identity !== entry.identity_hash) return finish(itemCtx, entry,
          { order_id: entry.order_id, state: 'reconciliation_required', reason: original.reason ?? 'order_changed' });
        if (original.revoked) return finish(itemCtx, entry, { order_id: entry.order_id, state: 'skipped', reason: 'order_revoked' });
        // The selector invokes the original consumer and all its original proof,
        // retention, settlement and CAS validation. No alternate capture path.
        const observed = await runPaidOrderRecovery(source, { orderIds: [entry.order_id], maxOrders: 1, deadlineMs: Math.max(1, Math.floor(executionMs / 2)), signal: itemCtx.signal });
        itemCtx.check();
        if (!validatePaidOrderRecoveryResult(observed) || observed.items.length !== 1 || observed.items[0].order_id !== entry.order_id)
          return finish(itemCtx, entry, { order_id: entry.order_id, state: 'reconciliation_required', reason: 'evidence_unavailable' });
        return finish(itemCtx, entry, observed.items[0]);
      }).catch(async (): Promise<PaidRecoveryPriorityItem> => {
        // A known queue lease can schedule bounded backoff after its isolated
        // reader timed out. An uncertain lease never grants this transition.
        ctx.check();
        if (acknowledgedEntry) {
          try { return await budget(source, { deadlineMs: cleanupMs, signal: ctx.signal }, cleanupMs,
            cleanupCtx => finish(cleanupCtx, acknowledgedEntry!, { order_id: candidate.order_id, state: 'reconciliation_required', reason: 'evidence_unavailable' })); }
          catch { ctx.check(); }
        }
        return { order_id: candidate.order_id, state: 'write_unconfirmed', reason: 'priority_item_unconfirmed' };
      });
      ctx.check(); append(item);
    }
  }); } catch { result.outcome = 'degraded'; result.reason = 'priority_unconfirmed'; }
  return result;
}

export async function paidRecoveryPriorityStatus(source: RuntimeEnv) {
  return budget(source, {}, 5_000, async ctx => {
    const index = await readIndex(ctx), entries = index?.record.entries ?? [], now = Date.now();
    return { scope: 'enrolled_original_capture_preflight_obligations_only', inventory_complete: false,
      pending: entries.length, due: entries.filter(entry => due(entry, now)).length,
      leased: entries.filter(entry => entry.lease_until !== null && Date.parse(entry.lease_until) > now).length,
      capacity: PAID_RECOVERY_PRIORITY_MAX_PENDING, updated_at: index?.record.updated_at ?? null,
      quarantine_inventory_complete: false, quarantined_originals: null, customer_revenue: null };
  });
}
