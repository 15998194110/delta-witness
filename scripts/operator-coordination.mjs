// Import-safe LOCAL CANDIDATE. This never sends, submits, polls, starts tasks or
// infers authority from an old sprint. Only an explicitly selected original
// pipeline.json may be updated; tests use synthetic files exclusively.
import { open, lstat, rename, unlink } from 'node:fs/promises';
import { isAbsolute, basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_BYTES = 2_000_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const fail = code => { throw new Error(code); };
const opaque = value => typeof value === 'string' && ID.test(value);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function normalizeOperatorTarget(target) {
  if (typeof target !== 'string' || target.length > 254 || /[\s\x00-\x1f]/.test(target)) fail('invalid_operator_target');
  const value = target.toLowerCase();
  const parts = value.split('@');
  const domain = parts.length === 1 ? value : parts.length === 2 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0]) ? parts[1] : '';
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) fail('invalid_operator_target');
  return { target: value, keys: [...new Set([`domain:${domain}`, ...(parts.length === 2 ? [`email:${value}`] : [])])] };
}
function pathFor(path) {
  if (!isAbsolute(path) || basename(path) !== 'pipeline.json') fail('explicit_canonical_pipeline_required');
  return path;
}
async function bytesAt(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) fail('invalid_canonical_pipeline');
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(before.size + 1);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await file.read(bytes, position, bytes.length - position, position);
      if (!bytesRead) break;
      position += bytesRead;
    }
    if (position !== before.size || (await file.stat()).size !== before.size) fail('canonical_pipeline_changed_during_read');
    return bytes.subarray(0, position);
  } finally { await file.close(); }
}
export async function readCanonicalPipeline(path) {
  const bytes = await bytesAt(pathFor(path));
  let document;
  try { document = JSON.parse(bytes.toString('utf8')); } catch { fail('invalid_canonical_pipeline'); }
  if (!document || typeof document !== 'object' || Array.isArray(document) || !Array.isArray(document.opportunities) || !Array.isArray(document.contact_suppressions)) fail('unsupported_canonical_pipeline_shape');
  return { document, sha256: digest(bytes) };
}
function coordination(document) {
  const value = document.delta_action_coordination;
  if (value === undefined) return { schema: 'delta-operator-coordination/v1', revision: 0, actions: [] };
  if (!value || value.schema !== 'delta-operator-coordination/v1' || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.actions) || value.actions.length > 1000) fail('invalid_operator_coordination');
  const ids = new Set();
  for (const action of value.actions) {
    if (!action || !opaque(action.action_id) || ids.has(action.action_id) || !HASH.test(action.payload_hash) || !iso(action.updated_at) ||
        !['prepared', 'attempted', 'confirmed', 'unknown'].includes(action.state) || !Array.isArray(action.target_keys) ||
        JSON.stringify(normalizeOperatorTarget(action.target).keys) !== JSON.stringify(action.target_keys) ||
        !['recorded'].includes(action.bookkeeping_state) || !['unreported', 'reported'].includes(action.reporting_state)) fail('invalid_operator_coordination');
    ids.add(action.action_id);
  }
  return value;
}
function legacyTargets(value) {
  if (typeof value !== 'string') return [];
  const emails = value.match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  return emails.flatMap(email => { try { return normalizeOperatorTarget(email).keys; } catch { return []; } });
}
function originalHistoryBlocks(document, keys) {
  const intersects = other => other.some(key => keys.includes(key));
  if (document.contact_suppressions.some(value => intersects(legacyTargets(value.recipient)))) return true;
  if (document.opportunities.some(value => intersects([
    ...legacyTargets(value.contact), ...legacyTargets(value.failed_recipient),
  ]) && [value.sent_message_id, value.failed_sent_message_id, value.followup_sent_message_id,
    value.last_sent_message_id, value.superseded_message_id, value.bounce_message_id, value.thread_id].some(Boolean))) return true;
  return (document.distribution_submissions ?? []).some(value => {
    // Historical approvals can carry url + approval_message_id rather than
    // endpoint. Either recorded target stays reserved, including unknown
    // submissions; an approval is not permission to submit again.
    return [value.endpoint, value.url].some(target => {
      try { return intersects(normalizeOperatorTarget(new URL(target).hostname).keys); } catch { return false; }
    });
  });
}
function readback(value, action, at, expectedOutcome) {
  // Internal evidence envelope supplied by a trusted reader; NOT an invented
  // Gmail/provider response schema, nor independent verification of the claim.
  if (!value || value.outcome !== expectedOutcome || !opaque(value.evidence_ref) || !iso(value.checked_at) ||
      value.checked_at > at || Date.parse(at) - Date.parse(value.checked_at) > 300_000 ||
      value.target !== action.target || value.payload_hash !== action.payload_hash || !['gmail_sent', 'platform_readback'].includes(value.source) ||
      Object.keys(value).some(key => !['outcome','evidence_ref','checked_at','target','payload_hash','source','message_id','submission_id','thread_id'].includes(key))) fail('current_external_readback_required');
  if (expectedOutcome === 'confirmed' && !opaque(value.message_id ?? value.submission_id)) fail('confirmed_external_identity_required');
  if (value.thread_id !== undefined && !opaque(value.thread_id)) fail('invalid_thread_identity');
  return { ...value, assurance: 'caller_attestation_requires_provider_readback' };
}

export function projectOperatorTransition(document, command) {
  if (!command || !opaque(command.action_id) || !iso(command.at)) fail('invalid_operator_command');
  const next = structuredClone(document), current = coordination(next);
  if (current.actions.length >= 1000 && command.transition === 'prepare') fail('operator_capacity_requires_review');
  const action = current.actions.find(value => value.action_id === command.action_id);
  if (command.transition === 'prepare') {
    if (action || !HASH.test(command.payload_hash)) fail('operator_action_identity_conflict');
    const target = normalizeOperatorTarget(command.target);
    if (originalHistoryBlocks(next, target.keys) || current.actions.some(value => value.target_keys.some(key => target.keys.includes(key)))) fail('prior_contact_or_submission_requires_reconciliation');
    current.actions.push({ action_id: command.action_id, target: target.target, target_keys: target.keys, payload_hash: command.payload_hash,
      state: 'prepared', bookkeeping_state: 'recorded', reporting_state: 'unreported', updated_at: command.at });
  } else {
    if (!action || command.at < action.updated_at) fail('operator_action_unavailable');
    if (command.transition === 'attempt') {
      if (action.state !== 'prepared') fail('operator_attempt_already_reserved');
      action.readback = readback(command.readback, action, command.at, 'no_match');
      action.state = 'attempted';
    } else if (command.transition === 'unknown') {
      if (!['attempted', 'unknown'].includes(action.state)) fail('invalid_operator_transition');
      action.state = 'unknown';
    } else if (command.transition === 'confirm_from_readback') {
      if (!['prepared', 'attempted', 'unknown', 'confirmed'].includes(action.state)) fail('invalid_operator_transition');
      const observed = readback(command.readback, action, command.at, 'confirmed');
      const identity = observed.message_id ?? observed.submission_id;
      if (current.actions.some(other => other.action_id !== action.action_id && (other.readback?.message_id ?? other.readback?.submission_id) === identity)) fail('external_identity_already_linked');
      if (action.state === 'confirmed' && (action.readback?.message_id ?? action.readback?.submission_id) !== identity) fail('external_identity_conflict');
      action.readback = observed; action.state = 'confirmed';
    } else if (command.transition === 'report') {
      if (!opaque(command.report_evidence_ref)) fail('report_evidence_required');
      action.reporting_state = 'reported'; action.report_evidence_ref = command.report_evidence_ref;
    } else fail('invalid_operator_transition');
    action.updated_at = command.at;
  }
  current.revision += 1;
  next.delta_action_coordination = current;
  return next;
}

export async function updateCanonicalPipeline({ path, expectedSha256, command }) {
  // This lock plus snapshot comparison protects cooperating adapter writers.
  // It CANNOT CAS against legacy write_text/Gmail tools that bypass this lock;
  // all canonical writers need integration before any real activation.
  pathFor(path);
  if (!HASH.test(expectedSha256)) fail('canonical_snapshot_required');
  const lockPath = join(dirname(path), '.pipeline.delta-write-lock');
  const nonce = randomUUID(), lockBytes = JSON.stringify({ schema: 'delta-operator-lock/v1', nonce, expected_sha256: expectedSha256 });
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch { fail('operator_lock_exists_or_unavailable_readback_required'); }
  try { await lock.writeFile(lockBytes); await lock.sync(); } finally { await lock.close(); }
  // Any subsequent error deliberately preserves this lock and intermediate
  // evidence. No timeout, expiry, unknown-lock deletion or automatic retry.
  const snapshot = await readCanonicalPipeline(path);
  if (snapshot.sha256 !== expectedSha256) fail('canonical_version_conflict');
  const next = projectOperatorTransition(snapshot.document, command);
  const output = Buffer.from(JSON.stringify(next, null, 2) + '\n');
  if (output.length > MAX_BYTES) fail('canonical_pipeline_size_limit');
  const tempPath = join(dirname(path), `.pipeline.delta-${nonce}.pending`);
  const pending = await open(tempPath, 'wx', 0o600);
  try { await pending.writeFile(output); await pending.sync(); } finally { await pending.close(); }
  if ((await readCanonicalPipeline(path)).sha256 !== expectedSha256) fail('canonical_version_conflict');
  await rename(tempPath, path);
  if (digest(await bytesAt(path)) !== digest(output)) fail('canonical_commit_readback_failed');
  if ((await bytesAt(lockPath)).toString('utf8') !== lockBytes) fail('operator_lock_ownership_changed');
  await unlink(lockPath); // Only our exact lock after successful commit readback.
  return { schema: 'delta-operator-local-update/v1', sha256: digest(output), action_id: command.action_id,
    state: next.delta_action_coordination.actions.find(value => value.action_id === command.action_id).state,
    external_action_performed: false, external_readback_verified: false,
    concurrency_scope: 'cooperating_adapter_writers_only' };
}
