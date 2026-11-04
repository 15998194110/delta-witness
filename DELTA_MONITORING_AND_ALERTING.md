# DELTA monitoring and alerting — final candidate

2026-11-04. **Production NO_GO; candidate notification runtime is not deployed and remains default-off.** This document supersedes the monitoring implementation gaps in the historical [P0 report](PRODUCTION_BLOCKER_CLOSURE_REPORT.md), not its retained historical evidence. The original local audit made no production flag, schedule, provider-account, recipient, secret or billing change and sent no real notification. The current follow-up below separately records the later, explicitly authorized interactive Gmail verification; it does not establish the candidate's cloud notification chain.

## Current follow-up — consumer bounds and owner inbox evidence

**Owner inbox verification is now real but narrowly scoped.** The owner explicitly confirmed `ruphussten85@gmail.com`. At `2026-11-04T12:41:39Z`, the root agent used the connected Gmail tool to send one message with subject `DELTA 通知通道验证 DW-NOTIFY-20261104-01`; original message/thread ID: `1a1a6944db78aee7`. Separate native message and thread readbacks observed `SENT`, `INBOX` and `UNREAD` in that same mailbox (a self-message). The [recorded connector evidence](../DELTA-release-approval-20261104/DELIVERY-CLOSURE-20261104/owner-mail-evidence.json) summarizes those authenticated observations; it is not a provider-signed exported delivery receipt. This establishes an interactive Gmail-to-owner-inbox result for that original message. It does not establish a Resend provider `delivered` receipt, a Cloudflare Cron → Treasury producer → Outbox → provider delivery, an independent deadman alert, or human acknowledgment. Human ACK remains unverified. Gmail connector access is not a persistent cloud sender credential.

**The existing delivery consumer's historical-record bottleneck is locally repaired.** Previously it scanned only two episode references per 15-minute invocation, and terminal delivered/acknowledged history consumed the same quota as active work. The same [consumer](src/operating-alert-delivery.ts) now walks bounded two-reference pages in one invocation; terminal history does not consume active capacity. The normal Treasury producer remains at four selected events per invocation; no second loop, provider or scheduler was introduced.

| Per-invocation bound | Current local candidate |
|---|---|
| Original episode references scanned | 32 |
| Active sends / original-provider readbacks | 8 combined |
| Provider requests | 48, checked before calling |
| R2 original metadata reads | 160 |
| Aggregate metadata read bytes | 2,000,000; each object also bounded |
| Work / overall deadline | 35 seconds / 50 seconds |

Original v1 cursor/CAS, immutable holes, episode identities and request hashes are retained. A partially processed page retains its input continuation. An unreadable reference can only be passed after durable immutable-hole readback; the original remains subject to later recovery. Cancellation does not permit a late provider send. A budget exhausted after the original send became uncertain can still leave `unknown`; it requires original-operation readback, never an automatic replacement POST. Confirmed `failed` records remain retained and degraded rather than being silently retried or counted as delivered.

Results explicitly label `counts_scope=this_run_observations_not_cumulative`, distinguish newly observed delivery from already-terminal delivery/ACK, and expose remaining inventory and oldest observed pending time. They do not claim a complete global backlog or cumulative delivered count. Signed webhook custody still does not automatically promote the Outbox. Native latest events such as `opened`/`clicked` are not substituted for a preserved historical delivered event or human ACK.

These bounds improve local throughput but **do not guarantee fixed latency for arbitrary inventory growth**: the current inventory is still historical, active capacity includes both sending and later readback, and failures consume recovery work. At four new events per 15-minute run, eight active operations may already be consumed by one send and one later readback per event. Measure actual queue delay and provider limits before expansion; do not claim spare capacity or an unlimited notification SLA.

Local evidence: [consumer audit](../DELIVERY-CLOSURE-20261104/monitor-2057/audit.md), [source/log hash manifest](../DELIVERY-CLOSURE-20261104/monitor-2057/manifest.json), [73-test offline run](../DELIVERY-CLOSURE-20261104/monitor-2057/tests.log) and [tests](tests/operating-alert-resend.test.ts). TypeScript checking passed. These are local consumer results, not actual mailbox/provider delivery or 48-hour cloud evidence. Candidate runtime SHA256 `b0431c95a9c373c507fa665b99b52e4667b8e8c8ee7290c70eec81f32fa8b6cf` separately passed [actual isolated workerd process-stop qualification](../DELTA-release-approval-20261104/DELIVERY-CLOSURE-20261104/release-20261104T124259Z/RELEASE-QUALIFICATION.md), with [machine-readable qualification](../DELTA-release-approval-20261104/DELIVERY-CLOSURE-20261104/release-20261104T124259Z/release-qualification.json). This verifies original INFO send-ACK-loss recovery through the compatible forward artifact and retains the older reader's incompatibility; it does not qualify a whole-system rollback to that old reader. That isolated qualification cannot satisfy the real 48-hour unattended gate.

The shortest remaining notification path is to complete the **existing** Resend sender/domain, minimal required native send/read/domain access, approved configuration digest and signed receipt wiring, then validate one original cloud-generated owner test through provider acceptance, supported delivery evidence, exact inbox receipt and separately human ACK. No actual Resend configuration or third-domain receiver has yet been verified. The current production decision remains **NO_GO**.

## Post-login observation

[Production readback](docs/repair/cloudflare-readonly-20261104.md) confirms both existing Cron lanes execute in Cloudflare. Provider success does not prove downstream business success; one 3-minute record is missing from the observed interval. GitHub's declared hourly Pulse has a 10.563-hour maximum observed gap, and the candidate independent observer workflow is not on remote master. Live Core lacks the candidate operational/alert wiring. Therefore this audit establishes existing cloud execution, not candidate activation or real notification delivery. No task was enabled or replaced.

## Actual architecture and authority

| Component | Responsibility and durable evidence | Boundary |
|---|---|---|
| [Scheduled lanes](src/scheduled-operations.ts) and [Core wrapper](src/cron-observer.ts) | Existing Cron3 MeshKore heartbeat; Cron15 Watch/recovery/owner-alert/watchdog lanes; bounded IndexNow lane. Immutable start/completion events, scheduled/start/complete time, run identity, lease and last-success projection | Observation failure does not prevent original business work. Failed business results remain failed even if a later lane succeeds. This is not payment authority |
| [Operating state](src/operating-state.ts) | Existing single task identity, R2 ETag CAS, generation fencing, leases, bounded history/checkpoints/attempts, readback before retrying an uncertain mutation | Old executor cannot advance a newer generation. Unknown side effects are not blindly replayed. Full history/capacity requires intervention, never deletion/reset |
| [Pulse watchdog](src/pulse-watchdog.ts) | Existing canonical repository/workflow only; exact approved SHA; one original dispatch identity and provider run readback | Does not enable a disabled workflow, create another business loop, or execute financial work |
| [Independent observer](scripts/independent-monitor.mjs), [workflow](.github/workflows/operations-observer.yml) | Separate GitHub execution domain reads private Cron observations and detects three missing slots, lease expiry, duplicates, malformed/unavailable evidence | Scheduled candidate with default-off enable flag and exact-SHA gate. Publication and activation remain separately authorized; no current recurring run is claimed |
| Third-domain deadman timers | Four independent Healthchecks checks: Cron3, Cron15, GitHub observer and canonical Discovery Pulse; their own timer and their own recipient integration | Not configured/accepted here. Their notifications must bypass Cloudflare Outbox so simultaneous Cloudflare/GitHub outage can still be reported |
| [Canonical Pulse deadman](scripts/pulse-deadman.mjs) | Original run/attempt/SHA, immutable start/finish intent; success requires the executed critical and reporting gates. Queued/failed runs and timestamps alone cannot clear failure | Default disabled and exact-SHA gated. No dispatch or new business loop. Real provider arming and receipt remain external prerequisites; [closure evidence and exact wiring](docs/repair/release-approval-monitoring-20261104.md) |
| [Outbox](src/operating-alert-outbox.ts), [consumer](src/operating-alert-delivery.ts), [Resend adapter](src/operating-alert-resend.ts) | Durable incident intent, conditional original send, native provider ID, unknown-result reconciliation, bounded pagination and immutable holes | No permission is inferred from configuration. No customer mailing or refund authority. Read-only/native evidence, delivery and human ACK are different states |

The three-provider plan separates failure domains; it cannot eliminate correlated DNS, mailbox, identity or provider failures. A fallback recipient/transport must itself be approved and externally tested. Provider failure does not activate another arbitrary address or pay for another service.

## Candidate repairs completed

**Long accepted-notification polling no longer consumes the whole Outbox history.** An unchanged, verified native receipt returns the original state without a new frame. Forty accepted polls in the isolated test preserve the original row, then permit a later delivered transition and explicit ACK. This prevents normal slow delivery from exhausting the 16-frame history. A changed delivery result still requires a verified transition; polling never refreshes the original stored observation into fake freshness.

**Provider-signed webhook evidence now has a concrete route.** [Receiver](src/operating-alert-webhook.ts) and the route in [Core](src/index.ts) accept `POST /internal/operations/alerts/resend-webhook` only under all existing cloud/outbox/delivery gates plus `OPERATIONS_ALERT_WEBHOOK_ENABLED`. It is signature authenticated, placed before generic administrative authentication, and rejects browser Origin, admin Authorization and payment headers. Disabled route returns 404 without provider/storage access.

The receiver verifies HMAC-SHA256 over the exact raw bytes and Svix message ID/timestamp. It enforces a five-minute timestamp window, bounded rotation signatures, 16 KiB body, finite stream reads, two-second body deadline and ten-second request fence. Exact provider email ID, original approved configuration digest, sender/recipient/subject/tags and original creation time must match an already persisted transport binding. It will not adopt an unknown POST result merely because a webhook arrived. This follows the [Resend raw-body verification contract](https://resend.com/docs/webhooks/verify-webhooks-requests) and [Svix signed-content contract](https://docs.svix.com/receiving/verifying-payloads/how-manual).

Each accepted event stores an immutable minimal custody object under `operations/alerts/resend-webhooks/`: event/body hashes, original notification/payload/destination/provider ID, event type and times. It stores no raw message, mailbox, key or signature. Identical events deduplicate; changed body under the same event ID conflicts; write ACK loss triggers original-key readback. Oversize, stale, forged or mismatched events grant no state transition. The isolated suite also checks the publicly documented Svix test vector; its example key is not a production credential.

**Webhook acceptance is custody, not automatic Outbox promotion.** The existing native `GET /emails/<original-id>` adapter remains Outbox delivery authority. Signed `email.delivered` is additional external evidence but HTTP 200 from the receiver itself proves only local custody. `opened`/`clicked` never become human acknowledgment. Provider delivered means the recipient mail server accepted the email, not that the owner read it. See [Resend delivery semantics](https://resend.com/docs/webhooks/emails/delivered).

**Paid but unfulfilled original orders are now connected to real alert projection.** [Source reader](src/operating-paid-alert-source.ts) reads at most three original `orders/` records per page and calls [Core's remediation reader](src/orders.ts), which validates original binding, confirmed settlement and original proof/fulfillment state. [Operating control](src/operating-control.ts) feeds confirmed pending/intervention obligations into the existing `paid_undelivered` rule, ahead of lower-priority candidates. Age derives from the original settlement clock; stable episode identity derives from original order/payment identity. It is not reset to the latest scan time.

The original-order source intentionally does not depend on only the pending priority index or latest successful scan. Quarantined originals stay observable after removal from that pending index. Unknown evidence is not converted into settled debt, proof loss, resolution or zero liability. Verified completed originals do not generate a new active debt alert; disappearance from a bounded page never acknowledges or deletes an earlier incident.

The existing alert consumer persists selected alert intents before an immutable page readback and exact cursor CAS. Unknown writes retain the cursor; pagination wraps to revisit originals. This is bounded observation progress, not another payment ledger or recovery permission. Private status labels source scope and incompleteness. It does **not** claim complete historical debt coverage, legacy/Pilot/partner/Watch inventory, or a notification-time SLA for arbitrarily large inventories.

## State, escalation, retry and evidence rules

| Observation | Meaning | What it cannot establish |
|---|---|---|
| created / blocked / queued | Original incident persisted; destination may still be unapproved | Provider permission or send |
| sending / unconfirmed | Original claim/send may have applied; reconcile that original | Safe new POST, alternate identity, payment retry |
| provider_accepted | Native provider email ID/content matches | Delivery or owner awareness |
| delivered | Native original email reports mail-server delivery | Read, action, underlying incident recovery |
| failed | Native delivery failure retained on later scans | Safe arbitrary resend or deletion of the incident |
| acknowledged | Explicit authenticated original notification/payload ACK | Successful recovery, fulfillment or revenue |

Initial paid-debt alert requires five minutes overdue; severity SEV1. Existing [policy](src/operating-report.ts) has a one-hour escalation, stable episode deduplication and explicit ACK handling. Long-unacknowledged incidents receive the bounded initial/escalated progression once the original emission is resolved; uncertain/accepted original sends are reconciled rather than duplicated. There is no endless reminder loop. Worsened severity or a distinct episode receives its own permitted transition. Independent deadman notification is the fallback for primary-domain failure, not another sender competing for the same email.

The concrete Resend adapter keeps a fixed API origin, refuses redirects, bounds native responses/deadlines, verifies sender domain and readback access, and creates durable transport intent before POST. Only explicit rate-limit rejection permits its bounded same-payload/key retry; timeout, 5xx, conflict, missing native ID or ambiguous list readback remain unknown. Original absence never authorizes resend after provider idempotency retention expires. Details remain in [the transport contract](docs/automation/owner-alert-resend.md).

## Actual isolated verification

Evidence root: `C:\Users\10122\Documents\ChatGPT\DELTA-cloud-operations-20261103`. Each record is create-only, has its command, UTC times, log hash and source fingerprint. Network is denied by the reviewed offline guard; all payment/provider responses are explicit synthetic fixtures.

| Current run | Actual result | Evidence |
|---|---|---|
| FINAL-monitor-target-3 | PASS: 7 files, 118 tests; source stable | [JSON](../DELTA-cloud-operations-20261103/FINAL-monitor-target-3.json), [log](../DELTA-cloud-operations-20261103/FINAL-monitor-target-3.log) |
| FINAL-monitor-check-4 | PASS: TypeScript; source stable | [JSON](../DELTA-cloud-operations-20261103/FINAL-monitor-check-4.json), [log](../DELTA-cloud-operations-20261103/FINAL-monitor-check-4.log) |

These runs verified shared uncommitted candidates after baseline `b20f1b1`; each was internally stable. The test fingerprint was `76a0649e36e655d9f19d2b8e734c445eaf9e88d08a8ec04761b7e68c5ece5230`, and the subsequent typecheck fingerprint was `ab6eb5848c70bd1c5a11254381612f4f9b5e86b7bec202349b871c82459a05b5` after other integrated changes. Final unchanged-source release evidence and commit in [GO/NO-GO](DELTA_FINAL_GO_NO_GO.md) supersede both intermediate fingerprints. First typecheck exposed two corrected typing issues; a later no-output direct `tsc` invocation could not produce the wrapper's expected log file. Neither incomplete attempt is counted as verification. The final targeted run also proves that a valid original artifact larger than the alert cursor's metadata cap remains valid under Core's separate artifact limits; the alert reader does not impose that smaller cap on proof bytes.

| Fault / invariant | Test evidence |
|---|---|
| Old generation writes, claim ACK loss, expired lease, unknown side effect | [Operating state tests](tests/operating-state.test.ts) |
| Cron storage failure, later success preserving older failure, heartbeat body stall / malformed 200, future timestamp | [Cron observer tests](tests/cron-observer.test.ts) |
| Provider rejection, lost send ACK, concurrent dispatch, wrong native correlation, expired key ambiguity, late response, terminal failure, reference holes | [Resend tests](tests/operating-alert-resend.test.ts) |
| Unchanged accepted poll exhaustion followed by real state transition and explicit ACK | [Outbox tests](tests/operating-alert-outbox.test.ts) |
| Published raw-byte signature vector; signature tamper, future/old timestamp, key rotation; app route rejects browser/payment/admin inputs | [Signature tests](tests/operating-alert-webhook.test.ts), [route/custody tests](tests/operating-alert-resend.test.ts) |
| Original synthetic paid order quarantined, pending removed, later successful scan: same debt incident; no new browser/payment work | [Paid alert source tests](tests/operating-paid-alert-source.test.ts) |
| Bounded page continuation/wrap, concurrent identical checkpoint, immutable-page failure before cursor, cursor ACK loss, unavailable inventory | [Paid alert source tests](tests/operating-paid-alert-source.test.ts) |
| Private status, blocked alert and exact explicit ACK, scheduler gap persisted without invented delivery | [Operating integration tests](tests/operating-integration.test.ts) |

The independent OS-process stop/deadman rehearsal in the historical P0 report was a local fixture test, not cloud production evidence. A fresh final rehearsal and aggregate tests belong to the final release manifest; this document does not relabel old evidence as a new run.

## Normal Treasury receipt notification follow-up

The earlier incident projection did not notify on normal Treasury receipts. The [receipt closure](DELTA_RECEIPT_NOTIFICATION_CLOSURE.md) now adds a validated custody-to-existing-Outbox producer and normal INFO templates, with correction/re-observation semantics and known platform exclusions. It remains default-off and unverified externally. This extends the runtime/record contract; previous native/fallback evidence does not certify the new notification record reader. Sender backlog and end-to-end latency must be measured before activation or expansion.

## External acceptance still required

1. Read-only Cloudflare access has established actual deployment/bindings/Cron/flags and current secret **names** in the linked readback. Refresh this observation before approved writes; no repeat login is requested. Source configuration does not prove activation.
2. The exact owner receiver is now confirmed as `ruphussten85@gmail.com`, with the narrow Gmail inbox evidence above. Still verify/approve one existing Resend sender/domain, provider-managed minimum necessary send/read/domain permissions, configuration digest and approval reference. Bind the API key only in provider secret storage. Do not paste secrets in chat or commit them. A sending-only key is not a drop-in for the current native original-message reconciliation path.
3. If signed custody is desired, separately configure the exact webhook URL, event types and provider-managed `OPERATIONS_ALERT_RESEND_WEBHOOK_SECRET`; enable its flag only after route/key/configuration review. Do not expose this signing secret to the administrative caller or client.
4. Configure independent third-domain Cron3/Cron15/observer/canonical-Pulse timers with their own notifications and backup destination; validate quiet-period expiry, explicit fail signal, actual provider receipt and separately owner ACK. Timers must be armed before the first producer run, so a Runner that never starts is detectable. There is no current evidence that any such receiver is connected.
5. Under explicit single-notification authorization for the candidate cloud/Resend path, obtain original incident ID, provider native ID, native delivered evidence, signed custody where configured, exact inbox receipt and separately explicit owner ACK. The interactive Gmail message above cannot substitute for this path. Duplicate webhook/consumer invocation must not create a second email. Simulate rejection in isolation; actual provider outage validation requires a separately approved non-disruptive method.
6. After separately authorized deployment, complete 48 hours of actual cloud scheduling/coverage/recovery and external notification evidence. Repeated local PASS cannot close this gate.

No new account purchase, billing, real send, scheduling change, production release or credential export is required to read this candidate. Required owner actions are consolidated in [the owner checklist](DELTA_OWNER_ACTIONS.md).
