# Canonical operating task state — local candidate

This internal module provides task coordination primitives over the existing private R2 binding. It does not schedule, scan, purchase, send, deploy, sign, settle, delete, or reset anything. It has no initialization side effect or automatic retry loop. Existing orders, settlement journals, Watch claims/outboxes and Treasury checkpoints remain their original authorities. `scope=operational_coordination_no_financial_authority` must remain visible when projecting these records.

## Identity and authority

One task object lives at `operations/tasks/<task_id>.json`. The module deterministically derives a UUID from `kind + idempotency_key` using SHA-256; the idempotency key and payload hash are required SHA-256 identifiers. A supplied `expected_task_id` is checked, never used to choose a different key. Recreating the same identity with a different payload, schedule, operation class or retry policy conflicts. Adapters must include the canonical business/schedule scope in their digest; different kinds deliberately have separate namespaces. Untrusted clients must not choose another tenant's identity or submit arbitrary reconciliation evidence.

Task creation is conditional on absence. Every transition uses the original object's ETag with one conditional write. The ETag, run UUID and monotonically increasing generation fence the old writer. The module does not replace an original product's financial CAS. The R2 provider must implement the conditional-write contract atomically; these tests do not qualify a production provider deployment.

The caller persists `run_id` and each `operation_id` before the request. Exactly one successful claim may return `execute=true`; task reads, creation, operation replay, checkpoint, completion and reconciliation always return `execute=false`. A lost response cannot be turned into a new permission by reading or replaying the same operation. A replay returns current metadata, not permission to repeat the original effect. This is at-most-one claim permission, **not exactly-once external execution**.

## API

The module exports `OperatingTask`, `OperatingLease`, `OperatingReadback`, `OperatingResult`, `OperatingCheckpoint`, `OperatingRetryPolicy`, and validation helpers. `validateOperatingTask` is asynchronous because it verifies the derived identity. These are private server-side functions; authentication, adapter admission and request-body bounds belong to the existing admin gateway, not to this storage module.

| Function | Scope |
| --- | --- |
| `createOperatingTask(env, input, options?)` | Create one pending identity; no execution permission. Input includes kind, idempotency/payload hashes, operation class, schedule, operation ID and retry policy. |
| `getOperatingTask(env, taskId, options?)` | Bounded read of original task plus ETag, always read-only. |
| `claimOperatingTask(env, taskId, {run_id, operation_id, lease_ms?}, options?)` | One CAS from due pending/retry_wait into running. Successful fresh ACK alone can return execute=true and a lease handle. |
| `checkpointOperatingTask(env, taskId, lease, {operation_id, checkpoint, lease_ms?}, options?)` | Persist progress and optionally renew the same run lease. Returns a new ETag handle; old handle becomes stale. |
| `finishOperatingTask(env, taskId, lease, {operation_id, outcome, evidence_hash?}, options?)` | Record succeeded, retryable_failure, permanent_failure or unknown; never execute work. Success requires a non-placeholder evidence hash. |
| `markExpiredOperatingLease(env, taskId, operationId, options?)` | Move an expired running task to recovery_required. It never grants a replacement lease. |
| `reconcileOperatingTask(env, taskId, {operation_id, expected_etag, readback}, options?)` | Accept exact original, adapter-verified readback metadata and CAS the original state; no external I/O. |

`OperatingResult` includes `status`, `execute`, a sanitized `reason`, and when known the original `task`, `etag`, and updated `lease`. Status is created/updated/replayed/missing/blocked/conflict/unavailable/unconfirmed. `unavailable` is never absence; `unconfirmed` is never failure-to-commit. After an uncertain write, the caller reads the original task and operation history instead of issuing an automatic replacement operation. The module itself performs no write retry or lease takeover.

## States and retry rules

```
pending → running → succeeded
                 → retry_wait → running       (confirmed read-only failure)
                 → dead_letter                (read-only permanent/exhausted failure)
                 → recovery_required          (unknown or external mutation failure)
running + expired lease → recovery_required    (never directly running again)
recovery_required + exact readback succeeded → succeeded
recovery_required + exact readback not_applied → retry_wait / dead_letter
```

Unknown external mutation outcomes always require reconciliation, including an HTTP timeout or apparent retryable error. No absence/404, expired lease, missing ACK or process restart establishes `not_applied`. The adapter must verify the provider's original identity and a terminal conclusion that the old operation cannot still take effect; a temporarily absent result while an old request may complete later is insufficient. The envelope names its source `adapter_verified_readback` and binds task ID, run ID, generation, original payload hash, nonzero evidence hash and observation time. The observation must occur at or after the recovery-required transition. It is a trusted adapter assertion, not cryptographic proof that a provider was contacted. Unknown evidence leaves the task frozen. Successful readback closes the task without repeating it. Read-only expired leases also enter recovery_required first, so the runner must reconcile before requeueing.

Retry policy allows 1–8 attempts, 1-second to 1-hour base/max delays and at most a 1-hour run lifetime. Equal-jitter exponential backoff is bounded by the configured maximum. No claim is available before the original schedule or retry timestamp. `retry.max_run_ms` fixes the per-run deadline at claim time. Default lease is 120 seconds; explicit leases up to one hour support the existing 55-minute Pulse. Heartbeats cannot extend the original run deadline or revive an expired lease. A delayed write ACK after lease expiry returns no execution permission. The runner must still bound/abort its actual external operations; storage fencing cannot physically cancel a provider effect already submitted.

## Checkpoint and evidence bounds

The checkpoint is a fixed allowlist: numeric `completed_units`, an optional numeric block/page/offset cursor, and an optional evidence hash. Arbitrary text, URLs, access credentials, raw requests/responses and wallet material have no checkpoint field. Completed units cannot decrease. Once initialized, the cursor cannot be cleared, change kind or decrease numerically. It is an operating progress reference, not a Treasury cursor or order settlement authority; original domain validators still determine what its progress actually proves.

The record includes an append-only in-record transition history with every retained checkpoint, run identity, timestamp, reason and request hash. The module never truncates it. Maximum record size is 32 KiB and maximum history is 64 entries. A claim reserves three future transition slots and bounded byte headroom; a checkpoint/heartbeat preserves two slots for completion/unknown-result reconciliation. Capacity exhaustion blocks further permission/progress updates before consuming the reserved result space. Terminal/capacity cases require a separately reviewed lifecycle policy; no rollover task, deletion or new identity is generated here.

Reads reuse `readOrderMetadata`'s actual-byte stream validation and 15-second bound; conditional writes reuse `createClaim`/`commitClaim` and the shared 15-second write bound. Each public operation has a 20-second outer deadline. Expiry stops continuation; it cannot retract an already submitted conditional write. A late original write may commit and remains evidence to reconcile. No unknown exception text is returned, and corrupt/oversized original objects are preserved.

## Verification and deployment limits

Local tests cover derived identity and payload conflicts; concurrent create/claim; same-run replay; old ETag/generation fences; checkpoint preservation; bounded retries/dead letters; unknown external mutation results; exact reconciliation; expired leases for both operation classes; one-hour heartbeat ceiling; reserved completion capacity; stalled reads/bodies, lost and late write ACKs; and corrupt objects. They use synthetic R2 and block external network calls. No real provider, payment, registration, task activation, production migration or deployment is performed by these tests.

The pure module is not proof that the existing Pulse has adopted it, that all writers use its protocol, that a watchdog is active, or that the service runs independently in production. Gateway wiring, original-task identity migration, provider authorization, configuration, durable orchestration and live acceptance remain separately evidenced integration steps. No task state is customer revenue or actual contribution margin.
