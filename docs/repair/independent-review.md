# Independent cross-module review — 2026-10-29

Reviewer: separate Treasury agent reviewing Core and adapters authored by other agents. Read-only source review; the only file written during this review is this document. No network, credentials, deployment, migration, payment or platform calls were used. This review does not certify the reviewer's own Treasury implementation.

Baseline: `455f7be8278205f78e2099b85c45867ba39163b6` plus the current local working changes. Read v1.1 D02–D06 and the system stability gates directly from the supplied ZIP; the requirements and historical test counts are not execution evidence. Findings below are static execution-path evidence, not claims of production incidents. No new test suite was executed for this review. Current regression source was inspected, including `tests/reliability-payment.test.ts`, rather than relying on an earlier passing count.

## Release-blocking findings

### R1 — P1: returning to unchanged 455f7be can resume operations explicitly blocked by the new runtime

**Classification:** introduced mixed-version/data compatibility risk; G02/G04/G07 remain unqualified. This is a release/rollback blocker even if the new runtime's own tests pass.

**Current evidence:** `src/fulfillment.ts:41–56` keeps schema `delta-fulfillment/v1` while adding `blocked_failure`. `src/index.ts:464–468` writes a `processing` record with the original response before publishing artifacts; `src/index.ts:498–506` deliberately leaves uncertain persistence unresolved or writes `blocked_failure`. `src/settlement.ts:114–123` writes `settlement_unknown` before submitting settlement, potentially without any fulfillment record. `src/guarded-pilot.ts:74–76,456–465,479–487` has the equivalent unchanged-schema state additions. New `src/capture.ts:282–308` protects artifact bytes with conditional creation.

**Historical evidence:** `git show 455f7be:src/index.ts`, lines 203–228, only stops complete/fresh-processing records; every other recognized-schema record reaches `claimRetry` and authorization bypass. Its line 208 proceeds to the original payment middleware if the fulfillment is absent, without consulting `settlements/*`. `git show 455f7be:src/capture.ts`, lines 272–282, unconditionally writes HTML/Markdown/PNG/manifest. `git show 455f7be:src/fulfillment.ts` accepts the same v1 schema and unconditionally writes terminal fulfillment state.

**Concrete trigger:** a new worker persists `processing + response + original artifacts`, then loses the final-completion acknowledgement. A rollback to 455f7be after lease expiry treats this as capture work to retry and can replace the original proof bytes under the same deterministic proof ID. A `blocked_failure` record similarly becomes retryable. Separately, a new settlement with an unknown outcome and no fulfillment is invisible to the old runtime and can result in another settlement submission. This demonstrates a duplicate-submission path, not a confirmed second USDC transfer: nonce enforcement/provider behavior still determines that outcome.

**Required release condition:** designate and test a rollback build that understands these persisted states and journal reservations, including pending/blocked records and original bytes; alternatively provide an explicitly reviewed stop-and-reconcile rollout protocol that prevents old writers from seeing unresolved new-format work. A plain code rollback to 455f7be is not a safe rollback plan. Do not delete reservations or rewrite historical evidence to make old code accept it. No production action is authorized by this review.

### R2 — P1: the new semantic settlement identity does not cover legacy raw-header-only fulfillments

**Classification:** pre-existing D02/D03 historical compatibility gap left open, not a new regression caused by the nonce journal.

**Evidence:** `src/index.ts:225–242` first locates fulfillment by `sha256(payment header)`, then consults the new semantic settlement journal only if that exact fulfillment key is absent. `src/settlement.ts:67–86` derives journal identity from chain/token/sender/nonce and reads only `settlements/*`; it has no mapping from legacy fulfillments. `src/guarded-pilot.ts:180–200` uses the same pattern. The old `455f7be:src/index.ts:203–208` also keyed solely on raw header bytes.

**Concrete trigger:** an authorization used by the old runtime has only fulfillment A and no new settlement journal. Re-encoding the same signed payload as header B changes the raw-header digest while retaining the same authorization/nonce. B misses A and has no journal, so it can reach a new facilitator verification/settlement attempt. If a provider rejects an already-used nonce, the result may be failure rather than another charge; if it returns/reconstructs the prior successful receipt, another proof identity may be created. Neither outcome is a correct guaranteed replay of A. No actual duplicate transfer was observed.

**Required acceptance:** legacy fixture A without `settlements/*`, equivalent representation B, original/changed request bodies, and old-price orders must be tested. A compatibility strategy needs a trustworthy legacy authorization-to-order mapping or bounded reconciliation; existing semantic identity tests for new-journal orders do not establish this. Do not re-sign, re-submit a real payment or mutate legacy evidence as a shortcut.

### R3 — P1: buyer recovery remains a warning/stop contract, not the required authenticated order API

**Classification:** known pre-existing/open D03/D05/D06 requirement; the new fail-closed behavior is appropriate, but does not complete recovery. G03 cannot be closed for buyer restart/lookup/export.

**Evidence:** paid request schemas in `src/fulfillment.ts:8–24,72–94` accept URL/expectation fields, not a stable buyer business-order identifier. Current public Core routes in `src/index.ts:605–613,725–750` provide paid operations and public proof/demo metadata, not an authenticated buyer order-status/recovery/export route. `channels/base-app/src/domain.ts:107–117` preserves only a non-secret attempt marker and explicitly says automatic recovery is unavailable; `channels/base-app/src/App.tsx:394` still directs the buyer to contact DELTA. JS `packages/js-client/src/index.js:1–6,117–140` reports uncertainty without a recoverable order operation. MCP `packages/mcp-server/src/index.ts:133–163,211–254` likewise has no authenticated recovery tool.

**Consequence:** browser refresh, SDK process restart, or a new MCP invocation can neither securely retrieve the original result from the attempt digest nor prove that a new signing operation is recovery rather than a new purchase. Within one invocation, single-signature/deadline guards improve safety; they are not cross-invocation business-order idempotency. This does not justify disabling legally authorized normal purchases or asking for manual approval for every order.

**Required acceptance:** design one Core order/authentication/recovery contract, then wire thin adapters to it and test restart, concurrent tabs/instances and buyer isolation. Public proof IDs and attempt digests must not become download credentials. Keep status as open, not locally fully repaired.

### R4 — P1 for Pilot scope: recovery requires a final draft that is absent after successful per-page storage

**Classification:** pre-existing D13/D04 recovery gap exposed and safely contained by the new fail-closed path; not a reason to restore unsafe recapture. It blocks Pilot recovery qualification, not independent Capture-only work.

**Evidence:** `src/guarded-pilot.ts:397–425` captures and stores each page before recording a durable per-page result. The aggregate draft is first persisted at line 456. `recoverPilot` at lines 143–155 requires `record.response` with all proofs. Any crash after one stored page, or even after all stored pages but before line 456, leaves no draft accepted by recovery. Line 480 keeps that work unknown, and line 217 prevents stale processing from recapturing.

**Consequence:** original bytes are preserved, but even fully stored artifacts cannot be automatically returned in this window; partial pages cannot resume as the original paid Pilot. Existing final-completion-write recovery tests cover a later phase, after the draft exists.

**Required acceptance:** persist validated per-page progress and original evaluation inputs/results through the shared claim contract, reconstruct only verified original outputs, and fault-inject each per-page publication boundary plus the pre-draft window. No production read/write or historical deletion is needed to build the isolated tests.

## Scoped adapter limitation that remains open

Apify D16/G04 is not closed by its new same-run KVS marker. `channels/apify/main.mjs:72–80` keys both idempotency and recovery to `actorRunId`; lines 126–133 use separate read/write/charge operations without CAS. Two instances of the same run can both observe no marker before either writes it, and a replacement run has a different identity. This is an acknowledged pre-existing cross-run/multi-writer gap, not evidence that the new code introduces a known platform double-charge. Keep Apify outside any qualified autonomous-billing release scope until a platform-supported atomic/business-order contract and real platform evidence are available. A one-run fixture does not prove cross-run uniqueness.

## Changes reviewed that should be retained

The shared ETag claim helpers fence final writes; new settlement reservations do not expire into a fresh debit; completed legacy deliveries are checked before live source/preflight validation; original artifact recovery verifies bytes and manifest binding; private artifacts remain private; the adapters distinguish non-delivery/unknown from HTTP success and do not internally retry a paid transport. The new normal authorized purchase path remains automatic. These are meaningful local improvements and should not be reverted merely to hide the open requirements above.

## Bounded-response cleanup observation

`src/capture.ts:177–189` wraps the Browser binding promise in the new 30-second `withinDeadline` without attaching late-response cleanup. If the binding ignores its response deadline and resolves later, that Response's body is discarded without cancellation; the hardened fetch adapters explicitly cancel their late bodies. This is an introduced resource-cleanup uncertainty for G05, not evidence of a duplicate charge or artifact overwrite. Browser's configured `actionTimeout: 25000` remains present, so do not infer unbounded browser execution solely from this static path. An isolated late-header response fixture and body cancellation can resolve it without changing payment or order contracts. No runtime reproduction was performed in this read-only review.

## Review snapshot

This snapshot identifies reviewed dirty source bytes, not a release artifact or deployed revision. Line numbers are for this snapshot; later fixes need independent retest and updated evidence rather than silently treating the finding as closed.

| File | SHA-256 |
|---|---|
| src/claims.ts | 3f3b27d72428237415dbf54ce839db943a6e03bf67531f44ff885715c179a860 |
| src/settlement.ts | 0da3415008b8ddbcf117c306e742ed11cb4c947ccde541863b8fcb30900be0db |
| src/fulfillment.ts | feac8df47e5a141e692425f6ce3613dcd9a3b51b31d36a815c754116f80d4f5b |
| src/index.ts | a59d83f7fca801d17596b9d276c7360e41ca5881897d3a021c6d05b6122125cb |
| src/capture.ts | d1230e595c12f9b6ebedf37c1cff2d8444ff6d143f20f03c4aea62c559ea5c25 |
| src/guarded-pilot.ts | 7bf50c94aa19d98fb1ce18779420d317023c82df1b2ac3d62a7b0c0b51fb5b2b |
| channels/base-app/src/domain.ts | 6a28a285cb4140e34931654261b92b07d1adef0f85e4b0f0c527e187e20e7b20 |
| channels/base-app/src/App.tsx | 74d28f2bceef7e91e4451c501cbef698af4fbdd33b0b12adb8a25eaa32adfa46 |
| packages/js-client/src/index.js | 6cf5c1df82d8d710ba1be327e74b9553238205adb4b1ccae0af54a3526b5515e |
| packages/mcp-server/src/index.ts | 27b209166069e6b7d1add3add92b1ad8be5460d73bd2c496356009f9821e31e5 |
| channels/apify/main.mjs | 98db0e3c51152315a59398bdf7d17d8b23d3281a974ff35663fa93d85ef3dd0d |
| channels/partner-gateway/src/index.ts | b64989c3f47ccf141e77b00c0fc764585d465646d1383f4476bff31bb13cbbc2 |

Commands used: local `Get-Content`, `rg`, `git diff`, `git show 455f7be:<path>`, `Get-FileHash`, and read-only ZIP streams. No runtime publication evidence was obtained. G08 has an independent source review for this scope; it does not imply the operational alert/report-delivery part of G08 has passed.

## Integrator follow-up — late Browser response

The separate review also found that a Browser response arriving after the caller's deadline was not cancelling its body. The integrator reproduced this in `29-browser-late-red-1` (13 pass, 1 fail), then added late-body cancellation without a second Browser call. `29-browser-late-green-2` passed 14/14 under outbound network denial. This does not prove cancellation of an already running provider action, and does not close R1–R4. The review snapshot above remains the original reviewed bytes; final integrated source fingerprints are recorded separately.

## Second local batch review — D05/D06 authority and storage

Reviewed the integrator/Core agent's current `src/orders.ts` and `src/settlement.ts` after bounded storage integration. No new confirmed blocking correctness/security defect was identified in that cross-module review. This does not replace the original G07/R1 no-release limitation or claim live acceptance.

- `src/settlement.ts:95` requires the journal's `order_id` and `order_binding_hash` to match the order, including scope and payment/request fields. `src/orders.ts:162` provides the common authority digest; an index record alone cannot mint entitlement.
- `src/settlement.ts:144` verifies an opted-in authorization before reserving its order-bearing journal, then binds the order before settlement. Unknown outcome reservations remain durable and do not authorize another settlement.
- `src/orders.ts:196` uses the shared bounded storage view and one operation deadline. `assertCurrent` runs before recovery CAS and before status delivery. A CAS already dispatched before the deadline may still complete after the client gets a 503; a later status call reads actual state. This is a storage acknowledgement ambiguity, not permission to capture or settle again.
- The D06 implementation found one integration bug: API middleware replaced the artifact-specific CSP sandbox. `29-order-export-route-red-3` reproduces that failure. Core's fix at `src/index.ts:547` preserves the private route's existing CSP; whole-route assertions passed in `29-order-export-route-green-4` and the later shared-storage tests.
- R3 is now partially addressed locally by opt-in order status, original-observation recovery, and authenticated artifact export for completed Capture/Preflight orders. No legacy entitlement migration, global retention/TTL policy, owner credential rotation/revocation management interface, or production validation is implied. The existing denial tests use synthetic revoked/rotated records.
- Historical recipient/network configuration changes remain a known compatibility constraint: Core's original artifact verifier compares `manifest.payment` with current `env.PAY_TO`/`env.NETWORK`. An entitled historical order after such a configuration change fails closed; this batch does not claim compatibility across a Treasury/network reconfiguration. Existing prices remain bound to original settlement facts.

The export/storage implementation's own tests are not described as an independent review of those same files. Core separately reviewed those helpers. Final combined validation belongs to the integrator. R1/R2/R4 and external/operational acceptance remain separately tracked rather than erased by this follow-up.

### Later independent findings and integration corrections

The adapter reviewer subsequently identified that original credential dates were absent from the authority hash and saved Guard decision fields were not bound during recovery. Core now hashes original created/expiry dates with the journal authority. The integrator added an original response digest, required by new capability orders, and exercised altered safe/changed/reason/diff and missing-digest cases. A second Core review identified the processing-draft variant of missing-digest downgrade on raw-header replay; the guard now runs before both completed replay and draft recovery. Completed unstructured legacy headers remain compatible, while storage/receipt failures are not swallowed as legacy. Final tests and source fingerprints are in the second-batch evidence index.

These are storage-consistency checks, not signatures against a coherent privileged storage rewrite. The optional capability belongs to the first accepted request; its order ID and token digest are not independently part of the payer's EIP-3009 signature. A copied still-unused authorization and first-request competition remain a distinct authentication boundary. No wallet-owner authentication or complete legacy migration is claimed.
