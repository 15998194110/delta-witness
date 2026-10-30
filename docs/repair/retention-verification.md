# D07 retention policy and dry-run verification

Status: **local implementation / isolated tests only**. No retention duration was approved as a public promise. No production lifecycle, data migration, cleanup job, credential, provider read or deletion was configured or run.

## Read baseline

The v1.1 ZIP was opened and its actual UTF-8 file contents read. This implementation follows `01_DELTA_REPAIR_SPEC.md:228–250` (D07), `02_ACCEPTANCE_MATRIX.md:71–78` (D07-T01–T04), and `04_EVIDENCE_AND_DECISIONS.md:141` (DEC-01). It also preserves the G02/G07 constraint against retroactive changes to old obligations. The current local batch began at `191c0fbec249fd9022bc5948a379b99d9699f9d0`; no old candidate was reset or overwritten.

## One contract, separate authority

`src/retention.ts` is a pure Core module. It has no environment/storage/network handle and no delete function. It reuses Core's `stableJson` and `sha256`.

- An explicit `delta-retention-policy/v1` configuration contains independently specified raw artifact, minimal metadata and transaction audit policies. Each class specifies start event, positive duration and deletion window. The only implemented start events are original settlement confirmation and original fulfillment completion. There is no default 30/90-day duration.
- `parseRetentionPolicy(undefined)` means unconfigured. Invalid explicit JSON/configuration is rejected. A configuration proposal is not a customer-approved policy.
- `createRetentionSnapshot` copies the entire policy and rights, plus order/tenant/proof/payment identity and purchase time. Policy and snapshot hashes use Core canonical hashing. Changing configuration does not mutate a purchased snapshot.
- `verifyRetentionSnapshot` requires an authoritative snapshot hash from the original order/journal. A self-consistent replacement snapshot cannot satisfy the old authority hash.
- `evaluateRetention` uses original event times, never the current query/recovery time. It returns the raw expiry and retention permission. That permission **is not buyer authentication**. Authentication expiry may be earlier and is not extended. Legacy unsnapshotted data stays `legacy_policy_unknown`, with null expiry/permission rather than invented zero lifetime.
- Minimal metadata cannot expire before raw evidence, and transaction audit cannot expire before minimal metadata once their original event times are known. Missing events remain pending, future/contradictory/unzoned/impossible calendar timestamps are rejected.

Root integration owns the order purchase snapshot, journal hash binding, status/export checks and any purchase-before-payment disclosure. The standalone module does not claim those integration gates passed; their separate evidence must be recorded by the integrator. A raw expiry makes future raw export impermissible under the chosen contract even while storage still contains the bytes. This does not authorize deletion.

## Dry-run scope

The planner accepts one explicit tenant scope, evaluation timestamp and bounded inventory (at most 500 orders / 2 MB JSON). The inventory must supply original authoritative snapshot hash, original event times, order state, settlement state, cleared obligations, absence of legal hold, and exact object preconditions.

Only completed, settled, fully identified orders within their raw deletion window can become **dry-run candidates**. Other tenants, in-flight/unknown outcomes, uncleared/unknown obligations or legal hold, old unsnapshotted records, conflicting ownership, malformed identity/hash and incomplete object inventories are excluded. Duplicate orders or object ownership claims are excluded rather than guessed away.

A candidate lists only exact original `page.html`, `page.md`, and `screenshot.png` keys with ETag, hash and size. `manifest.json`, order records, settlement/fulfillment journals, minimal metadata and transaction audit are protected. No wildcard/prefix deletion appears. The metadata/audit schedule remains visible for policy review; actual destruction of those records is intentionally not implemented.

The deletion window is half-open: `[raw expiry, raw expiry + configured window)`. A missed window is reported separately and excluded; the planner does not silently extend authorization. Candidate hashes are stable across repeated runs of the same object preconditions, and plan/inventory hashes record exactly what was evaluated. Every report declares `execution_authorized:false`, `actual_deletions:0` and supplied-fixture authority that was not independently live-verified. A future executor would require separately approved real authority readback, exact object CAS/scope checks, audit persistence and interruption tests; this package supplies no executor.

## Reviewed local CLI

`scripts/retention-dry-run.mjs` reads one explicitly supplied local JSON file, compiles the same Core module in memory through the existing locked local esbuild dependency, and exclusively creates one new local plan file (`wx`). It does not install packages, run package lifecycle scripts, read provider credentials, call R2, delete files, or overwrite prior reports. Output prints only counts and plan hash. Invalid arguments, input, or an existing output return nonzero with controlled error text.

The bundled `tests/fixtures/retention-dry-run.synthetic.json` contains only clearly synthetic identities, short test durations, object preconditions and policy. To repeat the isolated example, use the approved local runner with a new evidence label and a new output filename:

```powershell
& 'C:/Users/10122/Documents/ChatGPT/DELTA-repair-evidence-20261028/Run-LocalCheck.ps1' `
  -Directory 'C:/Users/10122/Documents/ChatGPT/DELTA-local-repair-v1.1' `
  -Label '<new-local-evidence-label>' -Executable node `
  -Arguments @('scripts/retention-dry-run.mjs','--dry-run','--input',
    'tests/fixtures/retention-dry-run.synthetic.json','--output','<new-local-plan.json>') -Offline
```

This is not permission to prepare or execute deletion against a live inventory. Do not replace the synthetic fixture with credentials or whole private provider dumps.

## Actual evidence

Evidence root: `C:/Users/10122/Documents/ChatGPT/DELTA-repair-evidence-20261028/`.

| Evidence | Actual result |
|---|---|
| `29-batch3-retention-target-1.log/.json` | 43/43 isolated tests passed. |
| `29-batch3-retention-calendar-red-2.log/.json` | 44 passed / 2 failed: Date.parse silently normalized February 30 and 24:00. |
| `29-batch3-retention-calendar-green-3.log/.json` | 46/46 passed after explicit calendar validation. |
| `29-batch3-retention-types-1.log/.json` | TypeScript check passed. |
| `29-batch3-retention-cli-1.log/.json` | Exit 0; one synthetic candidate, zero exclusions, zero deletions. |
| `29-batch3-retention-plan-report-1.json` | Saved original synthetic dry-run plan; not an execution request. |
| `29-batch3-retention-cli-refuse-overwrite-2.log/.json` | Expected exit 1, `output_already_exists`; original plan preserved. |

D07-T01 snapshot immutability, T02 time boundaries/recovery delay, and T04 legacy protection have pure-module evidence. T03 has planning/idempotency/scope evidence only; no actual cleanup implementation or deletion acceptance is claimed. Purchase/status/export integration, an approved production retention policy, old-customer/prepaid obligation inventory, migration/rollback review, and any real cleanup authorization remain separate gates.

Final pure-module validation at this checkpoint: `29-batch3-retention-target-4` passed **48/48**, adding exact object-field/type checks so unrelated metadata or non-string ETags cannot enter candidate records. `29-batch3-retention-cli-repeat-3` successfully wrote a new report from the same synthetic fixture; report 1 and report 2 were byte-identical (SHA-256 `3e82c521ba826fd63c3175398110aedecc50b8ee82c2825d3e8a5f34178e847c`). Previous reports were neither overwritten nor deleted. No source changes followed this checkpoint except an independently reviewed blocking fix if separately recorded below.

Frozen pure-module file hashes:

| File | SHA-256 |
|---|---|
| src/retention.ts | 92e098a81c755f02aeb5d5a81388c20507619fdaf30c61c1e2f885e7cc657326 |
| tests/retention.test.ts | 4f4b8db386aeb9caee6e468da103f19854d6822270d8201e0a73dc83b972e76b |
| scripts/retention-dry-run.mjs | b261d7d06b8931baf6f9eb71007ef526bc1e40816752930ef8f568710e3a8c39 |
| tests/fixtures/retention-dry-run.synthetic.json | 9842cdc0769fe67ce79f1c03e2d67b8634b35e0950643b8fcbc6a7fe9d7efcc9 |

## Independent review follow-up — local input growth

Core reviewer found the original CLI's `stat` then `readFile` sequence could allocate an oversized input if the file grew or was replaced after the size check. The CLI now opens one file handle and reads into a fixed 2,000,001-byte buffer, rejects overflow, and closes the handle on success/failure. No unbounded `readFile` remains. Four mocked-handle regressions cover growth after stat, a valid original handle, initial oversize and a failed reader.

`29-batch3-retention-bounded-cli-5` passed **52/52** (48 retention cases plus 4 CLI input cases). `29-batch3-retention-cli-bounded-4` also executed the updated CLI against the unchanged synthetic fixture and saved `29-batch3-retention-plan-report-3.json`, with the same plan hash and zero deletions. The earlier CLI fingerprint above remains historical evidence; only the CLI source and new CLI test changed for this review finding.

| File | Updated SHA-256 |
|---|---|
| scripts/retention-dry-run.mjs | 8d8100dec0b0e0ae0734f0d8a9306d6ce17c69850bd18a0ee3f8965eae5fd1d8 |
| tests/retention-cli.test.mjs | 54a44671328e8c34d0c58f429a1bed34445aad487d111964ff21d02b7ce3c47d |

## Purchase-time policy validation follow-up

Root integration review identified that the original parser accepted conflicting category obligations and discovered the conflict only when calculating events after payment. The parser now requires `raw_artifacts -> minimal_metadata -> transaction_audit` durations to be nondecreasing and start-event rank never to move backward (`settlement_confirmed < fulfillment_completed`). This is a deliberately conservative supported subset: even an apparently long audit period beginning at settlement is rejected if metadata begins at fulfillment, because completion delay has no authorized upper bound. Equal durations and forward event ordering remain valid. There is no new default policy or public retention promise.

The synthetic source fixture now starts all three categories at fulfillment and has newly computed snapshot hashes. Earlier report files and hashes above remain historical evidence and were not overwritten. Timeline validation also rejects future settlement events even when every category starts at fulfillment; previously that unused event escaped the category-specific check.

- `29-batch3-retention-order-red-6`: 47 passed / 5 failed before the fix (four static-order regressions plus the future-event gap).
- `29-batch3-retention-order-green-7`: 63/63 passed (52 pure policy/planner cases, 4 bounded CLI cases, 7 current integration cases).
- `29-batch3-retention-order-types-9`: TypeScript check passed.
- `29-batch3-retention-order-cli-8`: updated CLI fixture produced one synthetic candidate, zero exclusions, zero deletions; a new report `29-batch3-retention-order-plan-report-4.json` has plan hash `sha256:fc8a2efc50eaf11898dbaf4d62e8104f787ae8029c98079975d1585d3464dbef`.

## Independent review of initial Core integration

Review scope was `orders.ts`, `settlement.ts`, `order-export.ts`, `index.ts`, `fulfillment.ts`, and the JS client changes. This is separate from the pure-module implementation self-tests above.

- Confirmed the entire optional purchased snapshot participates in the original settlement journal's order authority hash. Recomputing only the order's internal policy/snapshot hashes cannot replace its terms. Legacy unsnapshotted orders stay unknown and are not retroactively enrolled when configuration changes.
- Export retains shared buyer authorization, original entitlement/integrity checks, a final expiry check, private no-store headers and attachment sandboxing. The JS client persists the selected policy hash before its signing CAS; repeated preparation with different terms fails closed.
- Reported an integration blocker to Root: the initial response draft at `index.ts` did not persist `completed_at`, while `fulfillment.ts` recovery filled a missing value using the current recovery time. Interruption after artifacts were stored but before terminal CAS could therefore move a fulfillment-based retention start to a later recovery day. Root owns this correction and its interruption regression; this note does not claim that a fix was verified.
- D07 scope remains partial: optional new scoped Capture/Preflight orders only; no implicit contract for existing/unsnapshotted orders, unscoped requests, Partner, Watch or Pilot. No actual deletion executor, migration or production policy is authorized here.
- New JS order records containing `retention_policy_hash` are rejected by the old SDK's strict unknown-field validator. This is fail-closed (no fresh signature), but rollback to that client cannot be claimed to preserve recovery availability.

## Independent recovery-clock re-review

The initial recovery-clock blocker above has been corrected conservatively. Read-only review of `fulfillment.ts:171-180` confirms recovery spreads the original record and changes only state/update time: an existing `completed_at` remains unchanged; a missing original completion event remains missing. `orders.ts:186-205` allows that missing event to flow to the pure retention evaluator. A verified original bundle can therefore recover to `complete`, while a fulfillment-based retention start stays `pending_start` with null expiry/permission. Export remains unavailable (503); no expiry or deletion eligibility is invented from recovery time. This is an explicit event-evidence gap, not full D07 completion.

Inspected Root's actual `30-batch3-retention-recovery-clock.log`: **9/9 passed**. Its new interruption test fails the terminal fulfillment write, advances time by two minutes, recovers, and verifies missing `completed_at`, pending/null retention, export 503 and exactly one Browser call. The same file also checks expiry reached during export reads returns 410. Preservation of an already-present completion timestamp is confirmed by code inspection in this review; the current nine tests do **not** contain a separate persisted-timestamp recovery case.

Reviewed source fingerprints (read-only snapshot):

| File | SHA-256 |
|---|---|
| src/fulfillment.ts | 9d2bffb31be0a4577e871729030577f906db97ce91414e97d8027e1d9f5e15f2 |
| src/orders.ts | e75fc178758581451788547617ca4b7407c4fd695e712e39eef6c33af402d9cc |
| tests/order-retention.test.ts | f5eb00f054310c3827cf0a92d4afd3f584d3a3419704498ae6b4b51b5d9daee6 |
