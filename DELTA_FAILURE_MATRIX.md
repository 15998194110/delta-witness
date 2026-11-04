# DELTA failure and recovery matrix

This matrix describes safety invariants and actual local qualification, not provider certification. Final exact-source logs and artifacts are indexed by [GO/NO-GO](DELTA_FINAL_GO_NO_GO.md). Historical native evidence remains in [P0 report](PRODUCTION_BLOCKER_CLOSURE_REPORT.md); changes require candidate requalification. All financial fixtures are synthetic, with no Treasury purchase or signing.

| Failure | Required behavior / original authority | Code and test evidence |
|---|---|---|
| Unpaid/malformed request; request lost before enrollment | No capture/settlement; reject bounded input or issue original challenge | `src/index.ts`, `tests/payment-gate.test.ts`, `tests/reliability-payment.test.ts` |
| Authorization/settlement result unknown | Freeze original payment identity; readback/reconciliation; no new settlement | `src/settlement.ts`, `tests/reliability-payment.test.ts`, native `unknown` scenario |
| Same payment for different request | Reject binding conflict; do not mint another order | `tests/order-decision-integrity.test.ts`, `tests/reliability-payment.test.ts` |
| Duplicate delivery retry / concurrent recoverers | Original identity, lease and conditional completion; one committed outcome | `tests/order-recovery.test.ts`, `tests/paid-recovery-priority.test.ts`, `tests/operating-state.test.ts` |
| Lease expires; old worker continues | Original ETag/fence cannot overwrite successor; uncertain external side effect is not redispatched | `src/claims.ts`, `src/operating-state.ts`, `tests/scheduled-operations.test.ts` |
| Paid process killed before original observation persisted | Preserve liability, needs_intervention; no false historical proof or new charge | `src/order-remediation.ts`, `tests/order-remediation.test.ts`, native `preproof` |
| R2 writes only a subset / hash mismatch / index unavailable | Validate all original hashes and binding; incomplete is not delivered | `tests/artifact-integrity.test.ts`, `tests/review-critical-write-boundaries.test.ts` |
| Original proof complete, final CAS/response ACK lost | Recover original response without Browser/settlement; duplicate reads return original | native `capture`, `preflight`, `post`; `tests/paid-order-recovery.test.ts` |
| Revoked credential or expired raw retention on unfinished paid obligation | Revocation/expiry does not discharge a paid debt; original paid state remains reconciliation/quarantine | `tests/order-remediation.test.ts`, `tests/paid-order-recovery.test.ts` (paid confirmed original fixtures) |
| New deployment startup fails / old reader lacks new state | Use qualified compatibility consumer or forward fix; preserve original records | `tests/rollback-native/build-continuity.mjs`, `tests/rollback-native/process-drill.mjs` |
| D1 unavailable / ACK lost | Original R2 authority preserved; later telemetry resumes; gaps stay incomplete | native Capture/Preflight D1 outage; `tests/metric-migration.test.ts` |
| R2 unavailable / storage quota exhausted | Bounded failure, no cleanup/new payment to conceal failure; unknown write read back by original key | `tests/review-critical-write-boundaries.test.ts`, `tests/order-recovery.test.ts`; actual provider quota remains external |
| Cron missing / duplicate / business failure after start | Immutable scheduled/start/completed observations; duplicate/semantic failure not healthy | `tests/cron-observer.test.ts`, `tests/independent-monitor.test.mjs` |
| Main plus auxiliary monitor dead | Third-domain timer independently alerts | Local `rehearse-independent-monitor.mjs` process drill only; actual independent service remains Gate 2 |
| GitHub late, queued, failed / unknown dispatch | Exact run/release correlation; bounded lookup; original guard prevents second dispatch | `tests/pulse-watchdog.test.ts`, `tests/pulse-status.test.mjs` |
| One channel 429/5xx/invalid large/deep inventory | Bound time/bytes/traversal; preserve lane failure; continue Treasury | `tests/funded-demand-boundaries.test.mjs`, `tests/revenue-reliability.test.mjs` |
| All RPCs down / conflicting views / reorg | Preserve continuous checkpoint/anchors, report gaps; no short-window all-time total | `tests/treasury-continuity.test.mjs`, `tests/treasury-checkpoint-store.test.mjs` |
| Same tx multiple logs / historical rescan | Deduplicate tx+log index with original source/coverage; conflicting evidence stays unresolved | `scripts/treasury-reconciliation.mjs`, `tests/treasury-continuity.test.mjs` |
| Notification rejected / lost ACK / unknown send | Bounded safe retry only after evidence of non-acceptance; otherwise exact original ID readback | `tests/operating-alert-resend.test.ts` |
| Repeated accepted polling / later delivery | Preserve history capacity; do not invent delivered/ACK | `tests/operating-alert-outbox.test.ts` |
| Forged, stale, duplicate or conflicting webhook | Verify raw HMAC/time/original binding; immutable ID/body fence; no dispatch or ACK authority | `src/operating-alert-webhook.ts`, `tests/operating-alert-webhook.test.ts` |
| No new buyers / unknown cost / negative margin | Continue entitled fulfillment and reconciliation; hold expansion; never reprice or invent revenue | `src/financial-evidence.ts`, `tests/financial-evidence.test.ts`, [revenue rules](DELTA_REVENUE_OPERATIONS.md) |
| IPv6 encoding / DNS family failure / redirect | Normalize numeric address; fail closed on unsafe or incomplete DNS; validate each known hop | `src/security.ts`, `tests/security.test.ts`; provider egress TOCTOU qualification is separate |
| Very large malicious page / resource exhaustion | Bounded request, response, artifacts, duration and provider settings; private output | `src/capture.ts`, `tests/reliability-payment.test.ts`, `tests/read-boundaries.test.mjs` |
| Long owner absence / credentials revoked | Persist failures, external timer alerts, retain debts; no dependence on local device | Notification/monitor fixtures; real credential lifecycle and recipient test remain Gate 2/4 |

The matrix is not an assertion that every provider fault has been induced. Native process kills and local R2/D1 use actual local workerd; payment/Browser/provider replies remain injected. Full production inventory, DNS/egress behavior, quota exhaustion, regional outages and real 48-hour execution need external verification. A retained debt can satisfy the safety/handling contract while fulfillment and commercial acceptance remain incomplete.

For remedy selection, prefer exact original bytes; otherwise determine original promise and obtain buyer acceptance before a fresh observation with its actual new time. Financial refund/remediation authorization is separate. Neither a successful test nor an owner alert changes the original contract or recognized revenue.
