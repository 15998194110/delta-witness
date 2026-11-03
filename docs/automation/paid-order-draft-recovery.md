# Original paid-order delivery-draft recovery

This local increment follows clean `22233e3`. The original orders, settlement journals, fulfillment ETags, retention snapshots and artifact bytes retain authority. The new consumer completes an existing verified delivery draft; it does not implement a second capture service, payment rail or order ledger.

## Exact scope

`src/paid-order-recovery.ts` inspects one bounded page of original `orders/` indexes. For each scoped Capture/Preflight order it verifies the original binding, confirmed settlement, original retention contract, fulfillment response digest and stored proof bytes using existing Core readers. Only `processing` plus a verified original delivery may call the original `recoverDelivery` CAS. It does not start Browser Run, settle/re-sign/re-purchase, retry an absent capture, clear claims, modify a historical price, issue/extend buyer credentials or delete artifacts. A recovered completion retains an unknown original completion time; it cannot extend retention.

Unknown/rejected settlement, missing/corrupt originals, missing draft and other failure states remain reconciliation responsibilities. Revoked indexes and expired raw-artifact entitlements are skipped before raw reads. One problematic order is classified independently; each order has a bounded read budget inside the total page budget. Cancellation fences prevent late continuations from starting new calls. A write already submitted to R2 may still commit and must be read back under the same original identity on a later pass.

## Existing scheduler and persistence

`src/paid-recovery-control.ts` is connected only to the existing `*/15 * * * *` Cloudflare handler. It requires **both** `OPERATIONS_CLOUD_ENABLED=true` and `PAID_ORDER_DRAFT_RECOVERY_ENABLED=true`; neither is activated by this code change. No new Cron, GitHub workflow, ChatGPT task, customer webhook or provider account is created.

One create-only event reservation precedes work. Duplicate delivery of the same Cron event grants no second execution. An unknown reservation ACK never grants permission. A later distinct event may safely inspect the same original records; original fulfillment ETags, not the scan cursor, own business completion.

Completed observations use the reserved event's CAS. The exact original observation is independently read back before advancing the scan cursor. Unknown writes are read back, never blindly repeated. Cursor advancement uses its original ETag or conditional creation and never retries a conflict. Partial/invalid/timed-out pages retain their input cursor. A complete final page wraps the next pass to the first page. Neither pagination nor an empty page establishes a complete historical inventory. Late continuations cannot advance a canceled scan.

Only private `operations/paid-order-recovery/` stores operational records. `GET /internal/operations/paid-recovery` uses the same protected operations surface, no-store/noindex and no URL credentials. The main status reads this optional source concurrently and degrades it independently. A configuration flag, observed run and observation freshness are separate. Recovery observations never establish Treasury receipt, customer revenue, actual costs or profit; those remain unknown until the original financial evidence is joined.

## Limits and unfinished work

The configured batch is **five indexes every fifteen minutes**, at most twenty per hour. Completed and unresolved indexes are included. This is a bounded delivery-draft sweep, **not yet a paid-outstanding priority queue**, not full recovery of every legacy/Pilot/partner/Watch path, and not a 300-second recovery SLA. Queue enrollment for current paid obligations, starvation/throughput qualification and exact production inventory must be completed before any wider reliability claim.

Owner alerts still lack an approved destination/provider and an original-notification readback interface. Financial monitoring still needs the true original Treasury history/floor, independently evidenced buyer purpose, full refund coverage and actual fees/invoices. The existing accounting kernel must be reused; selected orders cannot prove complete business totals. Cloudflare OAuth remains explicitly deferred by the owner. No deployment, migration, activation, notification, customer contact or funds action is included in this increment.

The provider contract was rechecked against the official [R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/) and [Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/). These describe conditional storage operations, not this deployment's current configuration or runtime acceptance.

## Actual isolated acceptance

`05-paid-recovery-target-1` passed 157 cases across six selected files. The initial typecheck then identified two test-fixture assignments that conflicted with generated literal environment types. They were changed to an explicit runtime-drift fixture through `Object.assign`; historical-price assertions and production pricing stayed unchanged. The failure log is retained.

The final unchanged-source combination, `05-paid-recovery-all-gates-1`, passed **1,056 tests in 68 files**, with **one explicitly inapplicable fallback-internal case skipped**. `05-paid-recovery-typecheck-2` passed. Both records bind source fingerprint `779011d190830f2407dc2c22903987feb3b44feb699db9ff2b1c59cd63a23cd6` and record `source_stable:true`. Historical producer and reviewed fallback artifacts were loaded by their existing exact evidence hashes.

The finite synthetic workload again used 200 orders, concurrency eight, and 60,076 milliseconds: 100 completed, 50 recovered, 25 settlement-unknown, 25 inconsistent originals. There were 4,104 additional recovery reads, no subsequent signing/settlement/browser increase and no original-artifact changes. This does not count as customer activity or revenue.

Private create-only execution logs, source hashes, workload trace and exact candidate-build evidence are retained in the sibling `DELTA-cloud-operations-20261103` evidence directory. Production deployment, runtime activation, whole-product recovery, actual notification delivery and business acceptance remain unverified.
