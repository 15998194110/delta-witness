# Order recovery workload — declared before execution

This plan is for the second local batch only. Status at declaration: **not run**. The plan alone must not be used as a passing G06 record; actual execution is recorded below. No production account, browser, R2 object, payment, RPC or customer request is included.

## Fixed scope and workload

Use the agreed Core order-capability contract and the thin JS persistent-store adapter with an isolated in-memory provider/R2 double. Use synthetic request URLs, signed-payment fixtures and deterministic unique authorization nonces. Process restarts simulated by constructing fresh client/module instances are labelled as simulation, not a real multi-process storage guarantee.

- One fixed seed, 200 distinct business order IDs and request digests.
- Concurrency 8; 100 normal completed orders, 50 final-record interruptions with verifiable original drafts, 25 unknown-settlement outcomes, 25 missing/corrupt-artifact cases.
- Every order is replayed/recovered from a fresh client using the same durable-store fixture. Also send two concurrent recovery attempts for each final-record interruption.
- Run for at least 60 seconds, repeating only status/recovery checks after the fixed order population is created. Never create additional paid orders to fill the duration. Hard overall watchdog: 180 seconds.
- Keep the ordered stage trace and original artifact digests. Emit a summary of completed, recovered, unknown, evidence-inconsistent, settlements, Browser invocations, stored objects and duration. Record module/source hashes and actual command/exit time.

## Predeclared pass thresholds

No duplicate settlement for any order; no signing or Browser invocation initiated by recovery; no wrong-buyer result or export; no changed original artifact hash/time; no unknown order presented as unpaid/safe-to-repay. All 150 normal/draft-recoverable orders must return the original completed result within the bounded test run. The 50 deliberately uncertain/corrupt cases must stay non-complete and identifiable, with no deletion or automatic reset.

After creation, repeated reads/recovery must not grow the business-order count, add settlements or continually append new proof objects. Compare retained-object count after recovery convergence with the final count; retain legitimate failure evidence and report it instead of deleting it to satisfy a threshold.

This is a finite synthetic workload. It does not certify sustained production uptime, real provider latency, platform payout, operating costs, real process/region concurrency, or a deploy/rollback window. If any fixture assumption prevents a prescribed case, report the run as incomplete and keep G06 partial/not-run rather than substituting a simpler loop after seeing its results.

## Recorded execution

Final reviewed-source run: `29-batch2-workload-guard`, exit0, source fingerprint stable before/after. It ran for at least60seconds with the fixed200 orders and concurrency8, preserved700 artifact hashes, and converged at1275 retained objects with no additional settlement/signing/Browser during recovery. The report includes the ordered trace and actual duration/read counts. See `validation-evidence-batch2.json`, which hashes the create-only report in the private sibling evidence directory. Earlier successful runs and failed investigations are retained separately; source-unstable runs are not final acceptance evidence. G06 is locally exercised for this scope, not globally closed.
