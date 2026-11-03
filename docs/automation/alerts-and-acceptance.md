# Operating projection and alert acceptance — local candidate

This document completes an explicit **candidate** alert policy. The supplied November 3 attachment ends at `- 超过`; its missing text has not been recovered. The thresholds below are implementation choices approved for local development, not a quotation of missing owner requirements. There is no production deployment, scheduler activation, new outbound channel, spending, price change or customer outreach in this module.

`src/operating-report.ts` exports `projectOperatingReport(input, nowMs, optionalPolicy)` and its input/output types. It is a pure function: no clock lookup, network, filesystem, persistence, queue, signing, notification or business recovery calls. The dashboard can consume its return value. A return value does not mean anything was saved or sent.

## Evidence contract and independent layers

Every observed fact has `value`, a canonical UTC ISO `observed_at`, and an opaque non-secret `evidence_id`. IDs use only letters, digits, period, underscore and hyphen, up to 96 characters. Actual source URLs, customer text, addresses, credentials, request bodies and provider error bodies are excluded. Nested run/RPC/acknowledgment data is reconstructed from allowlisted fields. Unknown extra fields are discarded. Invalid/future timestamps and invalid values produce `unknown`; values are not coerced, rounded or clamped to zero. Collections are bounded at 200 entries and duplicate subject IDs are not merged.

The projection accepts trusted **normalized evidence**. It does not authenticate provider receipts or validate a chain transaction itself. Its input adapter must verify and join the original records first; a caller-supplied assertion is not new authority. An evidence ID is a local lookup reference, not a bearer token. Keep source mapping private.

| Layer | What it can say | What it cannot imply |
|---|---|---|
| Provider scheduler configuration | Explicitly observed enabled/disabled; otherwise unknown | A recent handler run does not prove the provider is currently enabled. |
| Run execution | Run identity, outcome, timestamps, observed duration, separately supplied last success and next run | A success does not prove business delivery, persistence, notification or revenue. Missing duration is null. |
| Business | Nine separately covered metrics and explicitly evidenced conditions | Intent, authorization, settlement, Treasury receipt, fulfillment, customer revenue, cost, margin and refunds never imply one another. |
| Persistence | Explicit stored/failed/pending observation | Generating this report is not a storage acknowledgment. |
| Notification | Not attempted, provider accepted, delivered, failed or unconfirmed, with receipt evidence | Provider acceptance is not recipient delivery; missing receipt cannot prove either accepted or delivered. |
| Alert decision | Severity, dedupe, explicit acknowledgment, escalation and an inert queue candidate | No actual queue, delivery, retry, task disable, price change or financial mutation occurs. |

Facts older than **one hour** are explicitly `stale`. Historical covered metrics retain their interval/value with this label; they are not presented as a current total. Stale lead evidence cannot support qualification. Stale incident or provider permission evidence cannot assert a current condition or enable a notification candidate. A stale run may establish an execution gap only when provider-enabled state and expected cadence were freshly observed. Fresh `observed_at` means an adapter actually rechecked the source; it must not be updated merely because the report was rendered.

Each financial metric carries its own `coverage: {status, from, through}`. Missing/invalid coverage produces `value: null`. Complete interval zero is permitted only for that interval. Partial totals remain `partial`, never all-time or a lower bound for signed margin. The report always says `all_time_verified: false`; full-history verification requires a separate authoritative contract. Estimated variable cost must not be supplied as actual cost. The financial stage input is observational and does not recognize revenue on its own.

## Candidate alert rules

| Condition | Required evidence | Severity / threshold |
|---|---|---|
| Scheduler stale | Fresh enabled provider/cadence evidence; last observed execution start too old | SEV2 after more than 3 expected intervals |
| Consecutive scheduler failures | Explicit fresh contiguous failure-count observation | SEV2 at 3 failures; missing history is unknown |
| Paid but undelivered | Verified same-order settlement and outstanding fulfillment condition normalized by adapter; original condition `since` | SEV1 after 300 seconds; refreshing a scan does not reset original age |
| Receipt unmatched | Canonical receipt with unmatched original order condition, after known exclusions | SEV2; cannot label the receipt customer revenue |
| RPC coverage gap | Explicit bounded block range and valid gap inside it | SEV2; missing RPC evidence is unknown, not an invented range or zero receipts |
| Permission expired/revoked | Explicit current provider permission observation | SEV2; no automatic credential changes |
| Negative margin | Explicit negative margin observation with cost basis | Actual basis SEV2; modeled basis SEV3, never promoted to actual |
| Notification permission missing/expired | Explicit reporter permission observation | SEV2 local-only condition; no recursive attempt to notify through the failed channel |
| Notification unconfirmed | Explicit original delivery operation still unconfirmed | SEV2 local-only condition; absence of an ACK alone does not become delivery or safe retry |

The pure module does not infer paid-but-undelivered from two unrelated aggregate counts. The adapter must preserve original order, settlement, delivery and receipt identity. Likewise, negative margin evidence must preserve actual versus modeled costs. Current owner prices and already-authorized automatic purchasing remain unchanged.

## Dedupe, acknowledgment and escalation

- Key: `delta:<code>:<subject>:<condition-evidence-id>`. The adapter supplies a stable **episode** ID across repeat observations, and a new ID for a newly occurring condition. It must not mint one on each dashboard render.
- A matching persisted history row can retain the original first-seen time. Duplicate or incomplete history requires reconciliation, not another notification.
- Acknowledgment requires explicit evidence for this exact key and severity. Time passing never acknowledges or resolves a condition. A lower-severity acknowledgment cannot suppress a worsened alert.
- Escalation becomes due after **3,600 seconds** without qualifying acknowledgment. This only changes data. An unchanged alert with a recorded emission is suppressed; worsened severity or a newly due escalation may become a queue candidate.
- A prior operation that is queued, provider-accepted or unconfirmed requires reconciliation before any new notification candidate, even when escalation is due. No new send is authorized by a timeout.
- An available, fresh notification permission observation is needed for a queue candidate. Missing permission yields a blocked decision. Notification infrastructure alerts are local-only, so they do not recursively notify themselves.
- `notification_decision.enqueued` and `escalation.dispatched` are always false. Actual dispatch remains a separate, independently authorized adapter with persisted operation identity and provider acknowledgment. These flags must not be overwritten by the UI to imply sending.
- Absence from a later partial snapshot does not mark an earlier alert resolved. This module never deletes history or clears unknown incidents.

## Lead evidence and scope

Lead evidence is scored only for explicit independence, need, fit, payment capability, automatic invocation, repeat need and a positive observed budget. Weights are 10/20/20/15/10/5/20, respectively. This score measures evidence support, **not conversion probability, ROI, available balance, or purchasing authorization**. Missing budget remains null. A zero budget is an explicit negative. The qualification `evidence_supported_for_review` requires positive evidence of independence, need, product fit, payment capability and budget. It does not contact the lead, authorize spending or override a buyer's spend cap. Purchase authorization is a separate observation; ROI remains null.

## Local and external acceptance

`tests/operating-report.test.ts` supplies synthetic fixtures only. The first isolated execution (`03-operating-projection-target-1`) passed 37 cases and `03-operating-projection-check-1` passed TypeScript. Independent review found that an old emission/notification observation could predate the current episode; the reader now requires those observations to be at or after the same episode's first-seen time. Invalid prior emission requires reconciliation and old delivery is unknown. Run completion and last-success time also cannot postdate their observation.

The follow-up `03-operating-projection-target-2` passed **39 cases**, with `source_stable: true` and log SHA-256 `ecc799ef38bc830ae8a1ed5dbb92f81be6b70e17047cb8731e7540cc1551a796`. `03-operating-projection-check-2` recorded a separate shared-tree compile error in `src/pulse-watchdog.ts` (`TextDecoderConstructorOptions.ignoreBOM`); it is preserved rather than presented as passing. Root's subsequent combined validation is required after that file is fixed. Do not treat an earlier source hash as validation of later edits.

Local checks cover missing/partial/stale/future coverage; explicit interval zero; independent financial stages; provider/run/business/persistence/notification separation; no nested secret passthrough; safe IDs; duplicate subjects; all seven primary alert conditions; notification infrastructure conditions; unchanged/acknowledged/escalated alerts; queued/accepted/unknown delivery; original paid-order age; budget unknown/zero/stale; and no I/O or input mutation.

Release acceptance remains external and is **not completed by these tests**:

1. Read provider scheduler configuration and real recent invocation history with authorized access. Preserve unknown gaps, disabled state and original run IDs.
2. Bind input adapters to the same authoritative order/settlement/artifact records and canonical receipt coverage, including known exclusions, refunds, uncertain fulfillment and real cost evidence. Test a same-order joined case without new signing or synthetic revenue claims.
3. Persist a report and alert operation record, then independently read it back. A local file, test fixture or generated response is not a provider storage ACK.
4. Verify the approved notification destination and permission. Exercise actual provider acknowledgment separately from recipient delivery. Preserve the original operation on lost ACK; do not create an alternate send just to make the UI green.
5. Test a repeated unchanged alert, escalation, explicit acknowledgment, degraded provider permission, interrupted original send and safe recovery against the exact deployed version. Confirm no duplicate send, charge, fulfillment or price change.
6. Verify the UI shows unknown/partial/stale distinctly and does not label a 402, healthy API, listed channel, balance or provider green job as revenue.

Current status: **local implementation; isolated acceptance only; pending integration/release and external verification**. No live notification or autonomous profitable acquisition is claimed.
