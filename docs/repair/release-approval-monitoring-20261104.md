# Release approval: independent monitoring and real notifications

Observed 2026-11-04. Base HEAD `46f7200f211f44f8e47f5a1fb36b6d4abbd78e55`; qualified Core runtime `770449062da06d844a14aefabebbc2601677550d`. This report and the explicit local workflow changes are candidate preparation. **NO_GO for production activation. No deployment, live secret/config mutation, provider registration, real notification, or payment was performed.**

## What actually closed locally

The existing third-domain design covered Cloudflare Cron3, Cron15, and the GitHub observer, but did not directly monitor the canonical Discovery Pulse. A healthy observer only read Core Cron records; it could coexist with a missing Pulse. Core's dispatch watchdog is in the Cloudflare failure domain and its recent-run check uses `created_at`, not proof of a successful financial/business observation. Therefore it cannot serve as the missing independent success clock.

The smallest correction reuses the one canonical Pulse and existing Healthchecks adapter:

| Candidate file | Change and authority |
|---|---|
| [pulse-deadman.mjs](../../scripts/pulse-deadman.mjs) | Read the original run/attempt/SHA and final `pulseGate`; signal success only after the actual critical gate and evidence uploads succeeded. A new queued/failed run is not success. Existing provider ping helper enforces fixed HTTPS origin, bounded response/deadline and exact `200` plus `OK`. |
| [discovery-pulse.yml](../../.github/workflows/discovery-pulse.yml) | Default-off start/finish signals for a fourth independent check. Exact approved SHA plus enable flag. Start failure does not suppress Treasury. Existing schedules, business lanes, prices and credentials are unchanged. Final failure remains visible. |
| [operations-observer.yml](../../.github/workflows/operations-observer.yml) | Existing observer now includes the reviewed five-minute schedule in the local candidate. The unchanged job-level enable + exact SHA guard defaults closed. This removes a future code/SHA change at activation; no workflow was published, enabled or dispatched. |
| [pulse-deadman.test.mjs](../../tests/pulse-deadman.test.mjs) | Tests original identity, unknown/failure immutability, missing start/finish, actual child-process kill, independent timer arming, and configuration guards. |

`DELTA_PULSE_DEADMAN_ENABLED=true` AND `DELTA_APPROVED_PULSE_DEADMAN_SHA=<exact reviewed commit>` are necessary but not yet present activation approvals. `DELTA_PULSE_HEALTHCHECKS_PING_URL` is the single new Pulse secret name; the secret value is never recorded. Neither setting was written. Core/Gateway Worker source and bundle inputs are unchanged by this correction; the release manifest must include the new workflow/helper/tests and the resulting final commit. An approval of the old SHA does not approve these files automatically.

The helper writes a create-only original identity before a start ping, and create-only finish intent before the completion ping. A second finish against the same path cannot replace a failed/unknown result with success or send another completion. The original run's 55-minute Runner budget includes checkout/setup time; a late executor cannot claim completion past that budget. Artifacts include run ID and attempt; a later genuinely recovered run has a new artifact and does not rewrite the earlier failure. Provider dashboard recovery is not deletion of historical incidents. If the Runner dies before artifact upload, missing provider completion/timer expiry is the evidence; local logs are not claimed durable in that case.

`critical_operations_verified` means Core/pricing/path + Treasury declared-interval validation + paid-funnel observation and evidence publication succeeded. It does **not** mean a customer paid or delivery/revenue was recognized. Noncritical channel degradation is explicitly retained as `critical_verified_supplemental_degraded`; an IndexNow failure still does not stop Treasury.

## Actual evidence and its limits

Evidence root: `C:/Users/10122/Documents/ChatGPT/DELTA-release-approval-20261104` (E). Prior readback root: `C:/Users/10122/Documents/ChatGPT/DELTA-cloud-readonly-20261104-1` (C).

| Evidence | Actual conclusion |
|---|---|
| [monitor-tests.log](../../../DELTA-release-approval-20261104/monitor-tests.log) | Six selected suites passed, 102 tests, 2026-11-04 14:57:41 local. No provider transport permitted by test setup except explicit loopback process fixture. |
| [monitor-pulse-final-tests.log](../../../DELTA-release-approval-20261104/monitor-pulse-final-tests.log) | Final helper with original Runner budget passed all six focused tests at 15:03:10 local. Tests from the preceding run are not presented as post-edit evidence for changed code. |
| [monitor-observer-candidate-tests.log](../../../DELTA-release-approval-20261104/monitor-observer-candidate-tests.log) | Final observer scheduling candidate and existing Pulse/observer fault tests. Both candidate schedules remain local and guarded; this is not evidence of live recurrence. |
| [monitor-review-manifest-final.json](../../../DELTA-release-approval-20261104/monitor-review-manifest-final.json) | Latest source hashes including prepared observer schedule; earlier source manifest retained unchanged as historical evidence. |
| [monitor-dual-domain-drill/result.json](../../../DELTA-release-approval-20261104/monitor-dual-domain-drill/result.json) | Actual local primary process killed; observer still recorded unavailable; after both child processes exited the separate fixture timer emitted `both_domains_silent`. External requests 0. Real provider receipt and delivery null. This is not a cloud outage or soak. |
| C `github-actions-readback.json` | Complete retrieved 30-day inventory; largest scheduled-start gap 10.5630556 h, 2026-10-12 07:25:51Z to 17:59:38Z. GitHub scheduled success is not financial/business success. |
| C `delta-witness-api-settings.json`, observation 06:07:39Z | Existing secret names only: INDEXNOW_ADMIN_SECRET, MESHKORE_API_KEY, PARTNER_GATEWAY_SECRET. No CRON/Healthchecks/Resend/OPERATIONS notification bindings. Values were neither requested nor copied. |
| [provider-account-evidence.json](../../../DELTA-release-approval-20261104/provider-account-evidence.json) and `monitor-presence-evidence.json` | Exact provider-domain searches in connected Gmail found no account/wiring messages. Our additional in:anywhere search included Spam/Trash and also found none. This does not prove no account exists elsewhere. Do not create a duplicate account from negative search alone. |
| `DELTA-financial-evidence-20261104/REAL_INVOICE_NOTICE_ANCHOR_1.json` | Real Cloudflare invoice notification exists; it is neither a DELTA Outbox send nor a Resend delivery/owner ACK. It cannot close notification acceptance. |

## Reviewable third-domain configuration

The existing choice remains Healthchecks.io. It has an external timer and direct receiver integrations; neither Cloudflare nor GitHub is required to detect missing heartbeats. The reviewed candidate configuration is [monitor-activation-request.json](../../../DELTA-release-approval-20261104/monitor-activation-request.json). It is **not executed**.

| Check | Producer | UTC schedule | Grace | Signal meaning |
|---|---|---|---|---|
| delta-core-cron3 | Existing Core `observeCronInvocation` | `*/3 * * * *` | 420 s | Original Core invocation completed, including business/control outcomes |
| delta-core-cron15 | Same existing Core | `*/15 * * * *` | 1860 s | Same; timer detects silence by the third missed slot plus 60 s |
| delta-operations-observer | Existing observer, locally scheduled and default-off | `2-59/5 * * * *` | 660 s | Core evidence read/assessed; no order replay |
| delta-canonical-pulse | Existing canonical Discovery Pulse | `21 * * * *` | 3300 s | Original critical operational gate completed; no revenue inference |

The split hourly Pulse schedules still form `21 * * * *`. They were not changed. The existing observer now includes the reviewed five-minute schedule in the **local candidate**, while its job still requires `DELTA_INDEPENDENT_MONITOR_ENABLED=true` and an exact `DELTA_APPROVED_MONITOR_SHA` match. Neither guard nor live workflow was changed remotely. No new code or source SHA is needed merely to turn on the already-reviewed schedule after approval. Cloudflare and Pulse heartbeat activation are separate approved operations. Grace values cover existing bounded execution and are finite; a 10-hour silence exceeds every threshold. Provider transport/delivery delay must be measured separately from timer-due time. Cron3/Cron15 deadlines are no later than the third missed slot plus 60 seconds after the first expected missed schedule sequence; the observer uses the same rule for its candidate five-minute schedule. Pulse alerts after the first missed expected completion plus its 55-minute execution allowance.

Do not leave checks in provider `new` state with `next_ping=null` until the first real job happens. Before producers are enabled, commission each check with an explicitly labelled **control-only `/start` signal**, inspect native timer state and finite deadline, then allow it to expire in an isolated acceptance check. This is not a synthetic business success ping. The provider's documented create/resume examples return `new` with no next ping, so resource creation or resume alone is not an arming proof. No auto-provisioning query is used. Reuse exact existing checks only after identity/config readback; new checks, if needed, remain a separate approved action.

Both Healthchecks notifications must go directly from that provider to approved independent receivers. Routing them through DELTA Core, its R2 Outbox, or a GitHub job would reintroduce the shared failure domain. Check configuration must bind explicit integration identities, not wildcard all contacts. No primary/fallback recipient is inferred from repository email addresses. A shared mailbox/identity/provider outage is retained as a residual risk; the fallback should use a separately approved transport.

Healthchecks `200 OK` is only heartbeat receipt. Its documented management API exposes check state/flips, not a general end-recipient email delivered receipt. Preserve `provider_delivered=UNKNOWN` if unsupported. Actual authenticated receiver readback can establish `receiver_received`, and explicit owner acknowledgment establishes `acknowledged`; neither is relabelled as a provider-native delivered event. If native delivered is mandatory for the deadman transport, bind an approved integration that exposes that receipt or retain the external gate. The ordinary DELTA Outbox path below supports native delivered readback.

## Notification path: existing implementation, no fabricated send

Existing adapters in [operating-alert-resend.ts](../../src/operating-alert-resend.ts), [operating-alert-outbox.ts](../../src/operating-alert-outbox.ts), [operating-alert-delivery.ts](../../src/operating-alert-delivery.ts), [operating-alert-webhook.ts](../../src/operating-alert-webhook.ts) and the [wiring document](../automation/owner-alert-resend.md) were reviewed. Their isolated rejection, unknown-POST, duplicate callback, queue-resume and explicit-ACK tests passed this run.

| State | Required authority |
|---|---|
| created / queued | Durable original incident + exact destination/configuration digest |
| provider_accepted | Native POST result/native GET with exact original ID, sender, one recipient, tags/content/time |
| delivered | Native GET `last_event=delivered`; identifies recipient mail-server delivery, not inbox placement/read |
| signed callback retained | Valid raw-body Svix signature/time/replay checks and existing original binding; receipt custody alone does not promote Outbox |
| receiver_received | Actual authorized receiver inspection, with original correlation, no raw private body in public report |
| acknowledged | Explicit human action bound to original notification ID and payload; opened/clicked is insufficient |
| failed / unknown | Remains visible; lost-ACK readback uses original identity, never a replacement send after provider idempotency expiry |

Resend's current official permission choices are `sending_access` and `full_access`. The existing adapter requires GET `/emails`, GET `/emails/:id` and GET `/domains` preflight/readback, so **sending-only is insufficient**. `full_access` includes provider administration beyond the code's fixed endpoint allowlist; the adapter allowlist is not provider-enforced least privilege. Before real wiring, explicitly approve that risk for a dedicated DELTA Resend account/team and bound sender/recipient, or decline it. Do not silently widen a shared production account's key.

A sending-only key plus signed webhook could reduce runtime permission, but is **not a drop-in configuration** for this candidate: current preflight deliberately rejects it, callbacks require an already-known email ID, lost POST acknowledgment cannot be recovered through list/get, and callback loss requires an independent reconciliation path. Such a change would need a separately reviewed receipt authority and unknown-send recovery design; it was not implemented or presented as ready. Maintaining the current proven original-readback path is the scoped candidate choice, conditional on explicit provider permission approval.

The exact test incident/content template and scopes are in `monitor-notification-acceptance-request.json`. Sender/recipient are unresolved, not guessed. Codex will bind them locally to the digest and render the final reviewed payload before any authorized POST. One isolated synthetic incident tests delivery only; it cannot enter payment, revenue or customer records. Credentials and webhook signing keys go directly into provider secret storage; none belong in chat or this package. Browser/connected Gmail access is not a reusable cloud runtime credential.

## External acceptance sequence and evidence contract

Codex owns all engineering and configuration work after the required owner/provider authorization; the owner does not need to implement scripts.

1. Read back the existing Healthchecks project and Resend account. Confirm plan/quota and receiver consent. No paid upgrade, new identity, DNS mutation or send is implied by login.
2. Review exact four-check config, resolve explicit receiver integration IDs, and obtain authorization for only the bounded test/secret/config scope. Create/reuse isolated acceptance checks without stopping actual Core/Pulse.
3. Arm timer before producer; retain `armed_at`, native schedule/grace, finite expiry, read-only check identity and integration-presence evidence. Exercise never-started, start-without-finish and explicit failure. Stop **isolated producers only**. Retrieve down/up flips independently of CF/GH. Retain original failure even if a later run recovers.
4. For one isolated Outbox incident, retain payload/config digest, notification ID, provider email ID and POST/GET timestamps. Native accepted and delivered must be separate observations. Verify original provider callback, original GET, receiver receipt and owner ACK; failure/unknown is not success. Unknown POST must not be resent merely because 24 hours elapsed.
5. Approve only then the live bindings/observer recurrence and exact source SHA as part of controlled release. Before current production stays unchanged, `live_independent_monitor=NOT_CONFIGURED`, `live_notification=NOT_VERIFIED`, `48h_soak=NOT_STARTED` remain correct.

Persist the evidence as `schema`, `check_id_hash`/`notification_id`, `run_id`+attempt+source SHA, source authority, observed time, original incident identity, planned/detected deadline, accepted/delivered/receiver/ACK times, payload hash, receipt hash and status. A record may have unknown fields; no invented provider message ID, address, receipt, scheduled time or user confirmation is permitted. Keep native secrets, raw customer rows and full private email outside exported evidence. The proposed exact receipt format is in `monitor-notification-acceptance-request.json`.

## Minimal owner/provider conditions, consolidated

1. **Existing external account access and approved notification destination:** connect the existing Healthchecks and Resend account if present; confirm one verified sender and one receiver plus fallback transport. Only the owner can complete provider login/consent and secret entry. Account existence remains UNKNOWN, so creation is not assumed. Cloudflare login is already complete and is not requested again.
2. **Bounded integration-test permission:** approve the exact rendered recipient/content, one Outbox test message plus at most 16 direct deadman test/recovery notifications across two approved receivers, no payment/upgrade and no production task shutdown. Approve current Resend readback permission scope or retain NO_GO. Codex performs the fixture, configuration, retrieval and evidence reconciliation; the owner only acknowledges the actual received original test.
3. **Later exact production approval:** setting live secrets/flags to activate the prepared observer recurrence, merging/pushing release branches and deploying remain separate. Completion of items 1–2 alone does not authorize them.

## Provider contracts refreshed this run

- [Healthchecks schedules/grace](https://healthchecks.io/docs/configuring_checks/): separate check per schedule; start signal uses grace as execution timeout.
- [Healthchecks ping API](https://healthchecks.io/docs/http_api/): `rid` correlates start/completion; only exact acceptance body is receipt, not owner delivery.
- [Healthchecks management API](https://healthchecks.io/docs/api/): project-scoped read-only/read-write keys; read-only omits ping secrets; new checks have no integration by default and can have no next deadline. Use read-only state/flips for acceptance, provider UI for secret entry.
- [Healthchecks notification configuration](https://healthchecks.io/docs/configuring_notifications/): multiple direct integrations support transport redundancy; quotas require account-specific readback.
- [GitHub schedules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule): delays/dropped queued jobs are possible; an hourly workflow cannot be the sole absence alarm.
- [Resend key scopes](https://resend.com/docs/api-reference/api-keys/create-api-key), [native sent-email readback](https://resend.com/docs/api-reference/emails/retrieve-email), [24-hour idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), [delivered semantics](https://resend.com/docs/webhooks/emails/delivered), [raw-body webhook verification](https://resend.com/docs/webhooks/verify-webhooks-requests). These support the distinctions above, not a claim of actual deployment or sending.

**Conclusion:** the canonical Pulse monitoring blind spot is locally repaired and isolation tests pass. Real third-provider timer activation, direct receiver delivery and explicit owner acknowledgment remain external acceptance items. This scoped work does not close the overall production gate or validate customer revenue.
