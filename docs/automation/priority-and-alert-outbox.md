# Priority recovery and persistent owner-alert intent

Increment from clean `fbccaf1f4cb0f491d6dab82f425631c386e7ec2e`. Core, original orders, settlement/payment identities, historical prices, retention, proof bytes and fulfillment ETags remain authority. This is local implementation and isolated acceptance, not deployment or revenue evidence.

## Original paid obligations first

`src/paid-recovery-priority.ts` stores operational references under `operations/paid-order-recovery/priority/`, not a second order or financial ledger. Enrollment validates the original scoped binding and confirmed settlement; a hash binds that identity without copying credentials, payment signatures or raw artifacts.

The actual Core paid handler schedules enrollment in the existing provider background context only for unfinished/error responses, after the original payment gate. Successful completed traffic does not occupy pending capacity. No extra per-order human approval is introduced. Missing provider context, abrupt process loss, failed enqueue, and pre-handler settlement-ACK uncertainty remain covered only by the original bounded compatibility sweep; this queue alone is not proof of crash-complete enrollment.

The existing fifteen-minute consumer spends its first30-second budget on at most three due priority entries, then gives the compatibility inventory page a20-second budget. Existing unresolved page entries can be enrolled. Priority failure does not prevent that independent fallback observation. Same-event reservations and cursor CAS remain unchanged. These defaults do not promise300-second recovery or a production throughput SLA.

The active index is capped at128 references and64KiB. Explicit CAS rejection permits bounded re-read/rebase; unknown write ACK does not. Original queue claims are fenced by identity, claim ID, attempt and120-second lease, rechecked before a durable result. Expired or replaced owners cannot finalize or remove another owner's entry. Retryable unknown reads use bounded exponential backoff from15minutes to24hours. The original fulfillment CAS still authorizes the sole business write; no queue claim can settle, re-sign, recapture, clear an original lock or change artifacts.

Known complete/expired/revoked results have durable original readback before leaving active pending. Inconsistent, missing or regressed originals retain separate **quarantined, unresolved** evidence; no financial obligation is marked completed and no original order/lock/object is deleted. Quarantine removes only the active scheduling reference to isolate throughput. Its full inventory count remains unknown. Automatic quarantine re-drive, broader product/legacy recovery and provider settlement-unknown reconciliation remain unfinished; tests must not be read as closing those liabilities.

## Owner-alert outbox

`src/operating-alert-outbox.ts` uses the existing private R2 CAS boundary. Stable episode+severity+stage determine notification identity. Payload and destination digests, original observation, claim/run, provider receipt and explicit acknowledgment remain separate. Bounded history preserves prior message identities and receipts through escalation; exhaustion refuses further mutation rather than deleting evidence.

No destination yields a durably **blocked** observation. Configuration may identify a destination but cannot establish current provider permission or recipient delivery. A provider-neutral injected adapter exists for isolated acceptance only. The production router supplies no sender. Its one-use claim precedes send; unknown/lost ACK only permits original-ID readback, never a fresh send. Provider acceptance is not recipient delivery, and neither is an explicit owner's ACK. A definitive provider `not_applied` is a failed operation; automatic retry policy for a future real provider remains to be qualified.

The existing pure report can persist up to five incident candidates on the existing fifteen-minute Cron when `OPERATIONS_ALERT_OUTBOX_ENABLED=true`, under the existing cloud flag. Notification infrastructure conditions are not recursively enqueued. It never sends customer messages or changes scheduler state. All new flags remain unset by this increment.

Protected operations routes are `POST /internal/operations/alerts/observe`, `/read`, and `/acknowledge`. They use the existing admin authentication/no-store/noindex/Origin and payment-header rejection. Observations from this surface are authenticated operator assertions, not independent evidence of revenue or payment authority. No URL credential or browser secret storage is introduced. The report still says `provider_sender_configured:false` and delivery unknown.

## Actual isolated execution

`06-priority-outbox-target-2`:107 passing cases over six selected files, including actual Core unfinished response→background enrollment→priority drain, healthy/unpaid capacity protection, same-original artifacts, lease fencing, unknown ACK/backoff, blocked/private alert intake, explicit ACK and real report-condition persistence.

`06-priority-outbox-all-gates-1`:**1,093 PASS / 1 explicitly inapplicable fallback-internal SKIP**,70files, source stable. Exact historical/reviewed fallback artifacts were loaded. `06-priority-outbox-check-4` passed TypeScript against the same source fingerprint `c9be4fc27d3d015c3a01a9513ffb054f69b580ece2830f191b4fb4529af87153`. Initial check1 failures were test mock literal/Promise typings; original failure evidence is retained, and runtime assertions/production types were not weakened.

The finite synthetic workload again used200orders, concurrency8 and60,056milliseconds;100completed/50recovered/25settlement-unknown/25inconsistent originals,4,080additional read checks, preserved artifacts and no additional signing/settlement/capture. Actual Treasury receipt, customer revenue, costs and margin stay null. This workload qualifies the original isolated order paths; it is not a production capacity benchmark for the new queue.

Exact candidate build and create-only command/source evidence reside in sibling `DELTA-cloud-operations-20261103`. No production release, activation, migration, external notification, customer send, registration, paid canary, funds operation or R2 deletion occurred. Cloudflare OAuth remains explicitly deferred. Approved destination/provider authorization, actual invoices/refunds/buyer-purpose joins, canonical operator writers, quarantine recovery, production runtime and organic business verification remain open.

Business expansion decisions and current bounded demand evidence are in [the expansion playbook](../business/autonomous-expansion-2026-11-03.md).
