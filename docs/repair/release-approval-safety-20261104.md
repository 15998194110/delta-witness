# DELTA release approval: production safety and continuity

Status at 2026-11-04: **LOCAL RELEASE SAFETY FIXED AND TARGETED CHECKS PASSED / PRODUCTION NOT DEPLOYED**. This report does not approve a release, prove the other external gates, or declare organic revenue. No production mutation, provider send, payment, wallet signature, workflow trigger, push or merge was performed for this review.

## 1. Candidate identity and actual baseline

- Intake HEAD: `46f7200f211f44f8e47f5a1fb36b6d4abbd78e55`, branch `codex/cloud-operations-20261103`, initially clean.
- Product runtime: `770449062da06d844a14aefabebbc2601677550d`. The subsequent `9d1aef2` and `46f7200` commits change reports only. This review changes release tooling/tests, not `src/`, pricing, the public receipt address or the runtime bundle.
- Remote master observed in the authenticated intake: `455f7be8278205f78e2099b85c45867ba39163b6`. Live Core metadata reports `0.7.0`; Gateway reports `0.6.1`. The candidate Core is `0.7.1`.
- Live annotation `af9490276b8b5db5b8af532ee0d8e823343958ed` belongs to a side branch. Its three unique commits are release-only changes; they must not be discarded merely because they are absent from local master history. An annotation is not deployed-byte attestation.
- The exact final source SHA must be filled after integrating this local release-tooling change. A runtime SHA is not interchangeable with a later workflow/source SHA in the approval variables.

Evidence: [GitHub relationship readback](../../../DELTA-cloud-readonly-20261104-1/github-version-relationship.json), [local evidence and hashes](../../../DELTA-release-approval-20261104/safety-evidence-v3.json).

| Qualified local payload | SHA-256 | Qualification limit |
| --- | --- | --- |
| Candidate `candidate-worker-1/worker/index.js` | `06995a4105a5547afdf9c87d2641794862cc93f039894b1d167712e2c0ceb78f` | Native local workerd scenarios, synthetic payment and browser |
| Compatible fallback `compatible-worker-1/worker/index.js` | `c0bf205a78fdfacb0fdf093d70860c15fdbe6859a0e895177171508ea120cde6` | Old product plus the exact candidate paid-recovery consumer and input guard; not a fully production-qualified rollback |

This review rehashed every recorded build payload and each of the six native result files, and recorded the per-process log hashes. It did not rerun a complete test suite or replace existing evidence. A later build with different runtime bytes requires corresponding qualification; a source label alone cannot transfer the exact-byte acceptance.

## 2. Locally closed release configuration gap

The previous release wrapper retained variables using `--keep-vars` but used the checked-in config directly. That flag does not preserve the full live observability or preview-URL configuration. The historical release-only branch protected those settings; the general release train had not carried that protection forward.

The current minimal correction reuses that guard approach:

1. [`cloudflare-live-config-guard.mjs`](../../scripts/cloudflare-live-config-guard.mjs) reads only the existing Core service metadata using eight fixed-origin GETs, including deployment history. Responses have a streaming 256,000-byte limit and redirects are rejected. Provider payloads and secret values are not serialized.
2. It checks the compatibility date/flags, exact resource bindings, Cron schedules, configured variable values, complete nonsecret variable inventory, routes, custom domains, observability, placement, limits and tail consumers. Both variable policies reject unknown extra variables, including unreviewed recovery/permission flags.
3. It requires an explicitly approved previous app version, currently `0.7.0`, through `DELTA_APPROVED_CORE_PREVIOUS_APP_VERSION`. The candidate's configured `APP_VERSION=0.7.1` is the only allowed existing-variable value difference. Any other proposed variable change needs a separately reviewed configuration, not automatic acceptance.
4. [`verified-cloudflare-artifact.mjs`](../../scripts/verified-cloudflare-artifact.mjs) writes a fresh `reviewed-core-config.json` with `wx`, copying only checked-in public config plus reviewed observability and the current preview URL boolean. It preserves `redact_query_string=false` explicitly and checks the overlay again before upload and after submission. No rebuild occurs in the submission callback.
5. [Release train](../../.github/workflows/release-train.yml) runs this guard before any separately authorized D1 migration or secret write; submission performs another live check. An uncertain or failed post-submit readback does not automatically submit again or authorize rollback.
6. A matching `APP_VERSION` alone is insufficient. Before mutation/upload, the current single-version, 100% deployment must match `DELTA_APPROVED_CORE_PREVIOUS_DEPLOYMENT_ID=198bd533-8c3e-470a-b7c0-681ef0191182` and `DELTA_APPROVED_CORE_PREVIOUS_VERSION_ID=706c943b-c0e3-42c7-a662-5c3c2a6dcef0`. After upload, readback requires a **new** single-version, 100% deployment and records its IDs; it never requires the old IDs after upload. This is an optimistic read-before/write/read-after guard, not a provider-side compare-and-swap or binary attestation. Concurrent out-of-band changes remain a release coordination risk.

Pinned Wrangler `4.157.0` supports `observability.redact_query_string`; its default is false. The new guard makes preservation explicit rather than depending on a default. In its installed source, lines 170347–170348 encode explicit `vars` as `plain_text` bindings; lines 170903–170906 and 170937 add `keep_bindings` for the preservation flag. The CLI help at line 242343 describes suppression of deletion before deployment. Thus the candidate app-version binding is still explicitly included in the upload; production acceptance must also confirm the actual returned value. The evidence JSON records the pinned CLI hash and source locations. See the official [Wrangler source-of-truth guidance](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth).

### Actual provider readback of the new guard

- First direct read at `2026-11-04T07:07:58Z` returned 401 using the short-lived OAuth token in the existing local session. It was retained as evidence, not treated as a new login requirement.
- The root audit invoked the existing pinned Wrangler authentication-refresh path. No browser login or new consent was requested.
- At `2026-11-04T07:10:12.591Z`, all seven metadata GETs returned 200 and the new guard passed against the actual Core. Current `preview_urls=true` and `redact_query_string=false` are explicitly preserved. All configured values, the exact nonsecret variable set, bindings, Cron, empty route/custom-domain lists and observability matched the approved comparison. Only secret names were projected.
- The final version-aware guard at `2026-11-04T07:17:44.139Z` completed all eight GETs with HTTP 200 and confirmed the exact old deployment/version IDs above as well as the same configuration.
- The production config overlay was **not** persisted or uploaded in that read-only check.

Evidence: [initial 401](../../../DELTA-release-approval-20261104/safety-live-core-guard.json), [refreshed GET-only guard PASS](../../../DELTA-release-approval-20261104/safety-live-core-guard-refreshed.json), [final version-aware GET-only guard PASS](../../../DELTA-release-approval-20261104/safety-live-core-guard-versioned.json), [final offline dry-run and tests](../../../DELTA-release-approval-20261104/safety-evidence-v3.json). The final dry-run serializes the observed preview=true setting and verifies the output Worker bytes are unchanged; its bindings/payment state remain isolated fixture inputs, not a production deployment.

## 3. Data authority, existing orders and migration

Original R2 order, settlement and fulfillment records plus the original proof artifacts are the recovery authority. D1 telemetry, operating projections and queue/priority records do not supersede their original payment identity, captured observation time or delivery obligation. A missing projection does not authorize another charge.

The paginated read-only inventory reached a terminal page: 15 objects, 1,153,975 bytes. This is a non-atomic inventory, not a verified backup. There were three proof manifests with nine raw artifacts; all nine artifact hashes matched their manifests. Both v0.6 bundle roots matched. The older v0.2 bundle root remains `UNKNOWN` under the newer calculation, not a fabricated pass or a declared mismatch. R2 public access remains disabled; no raw proof was made public.

Two existing `delta-fulfillment/v1` records are `complete`:

| Historical shape | Evidence missing | Compatibility consequence |
| --- | --- | --- |
| Capture, 2026-09-09, original recorded price 0.03 | No response digest or payment-response header | Preserve original completed response and original amount; do not reprice it to the current new-order price |
| Preflight, 2026-09-07, original amount absent in this record | No response digest or payment-response header | Keep amount and receipt unknown; completed replay must not require inventing them |

[`src/index.ts`](../../src/index.ts) keeps completed legacy signed replay before new quote/capture work. [`src/fulfillment.ts`](../../src/fulfillment.ts) accepts the old absent digest on that path; new enrolled orders cannot remove a digest and masquerade as legacy. Legacy records cannot mint a new recovery capability. This review adds shape-only synthetic regression cases in [`review-current-policy-isolation.test.ts`](../../tests/review-current-policy-isolation.test.ts) matching both observed shapes: same original delivery, no fabricated receipt, no payment/capture call and no stored-record mutation on retry. No real order or payment payload was copied into the fixtures.

The two records are not proof of two organic customers. They do not contain the modern receipt evidence needed to elevate them to verified external revenue. Nor does this snapshot establish there can be no new in-flight orders at release time. A fresh inventory/readback is mandatory immediately before any authorized mutation.

Evidence: [paginated inventory](../../../DELTA-cloud-readonly-20261104-1/r2-paginated-inventory.json), [sanitized historical record shapes](../../../DELTA-cloud-readonly-20261104-1/persisted-inventory.json), [proof hash readback](../../../DELTA-cloud-readonly-20261104-1/proof-integrity-readback.json).

### D1 migration 0002

Production currently records only `0001_telemetry.sql`; its schema lacks the five new metric columns. [`0002_metric_provenance.sql`](../../migrations/0002_metric_provenance.sql) adds nullable `metric_schema`, `measured_browser_ms`, `measured_storage_bytes`, `modeled_variable_cost_usd`, and `modeled_contribution_margin_usd`. It does not delete data or rewrite legacy zeros into asserted actual costs. Old rows acquire NULL in the added columns.

- Migration approval is independent of code deployment approval.
- Before applying: inspect the migration ledger **and every target column**, save an approved backup/Time Travel recovery reference, record the exact database and migration hash, and verify the existing data snapshot's consistency limits.
- The SQL is not safe to rerun blindly after an unknown or partially applied result. Reconcile observed columns and ledger first; a partial apply requires an approved forward repair.
- Do not drop the new columns during code rollback. The old consumer can continue with additive columns, while original legacy rows remain unchanged.
- A Time Travel bookmark readback is a recovery reference, **not** proof that a backup has been restored and validated. A production restore overwrites data and requires separate authorization plus protection for post-backup writes.
- Do not use `wrangler d1 migrations list --remote` for this read-only inspection: the installed helper may create its ledger table. Use SELECT on the existing ledger/schema.

Evidence: [production migration ledger](../../../DELTA-cloud-readonly-20261104-1/d1-migrations.json), [column readback](../../../DELTA-cloud-readonly-20261104-1/d1-columns.json), [Time Travel bookmark read](../../../DELTA-cloud-readonly-20261104-1/d1-current-bookmark.json), [`metric-migration.test.ts`](../../tests/metric-migration.test.ts), and the native D1 outage/resume assertions below.

## 4. What the fallback actually proves

| Existing native scenario | Demonstrated behavior | Remaining boundary |
| --- | --- | --- |
| Capture / Preflight | Native process killed after durable draft; bad candidate startup; transient R2 outage; compatible recovery; second kill after CAS before ACK; restart replays once; original IDs/bytes/negative Preflight verdict retained | Synthetic settlement/browser and local persistence, not provider or customer acceptance |
| Priority queue | Original paid unfinished item survives restart and one compatible consumer resolves it | No claim that a disabled live recovery consumer is enabled |
| Unknown settlement | State remains unknown through old, compatible and forward consumers; no second settlement/capture | Requires authoritative settlement reconciliation; do not infer delivery permission |
| Before proof durability | Paid obligation survives; forward view requires intervention | Historical bytes may be unrecoverable. No fake timestamp, substitute delivery or automatic refund |
| Recovery POST | Original scoped recovery through real local HTTP; nonempty/payment-bearing/wrong-capability requests rejected | Original capability and terms must remain available in production |
| D1 in Capture / Preflight | Additive columns and original rows survive; unavailable telemetry does not deadlock paid replay; writer can resume | Missing telemetry interval remains incomplete; successful later writes do not erase the gap |

The unmodified old worker deliberately does **not** consume new recovery obligations. Its ability to start is not rollback acceptance. The qualified fallback is the specific composition of `0dbf2b3963ff56641b96e95b8f358591514cb3c4` product source plus `7704490` paid-order recovery/priority/control/rollback-continuity modules, the zero-byte recovery-input guard, and the candidate dependency lock. The full build manifest identifies each input and the one source patch.

This fallback does not automatically carry the candidate's entire operating/notification system. Before approving it for production, preserve or independently qualify the monitor, notification outbox and recovery handling for every actually active record class. Unsupported state is quarantined/retained, not deleted. Prefer a reviewed forward repair if rollback would strand newer obligations or disable necessary recovery. No production R2/D1 rewind, settlement replay, lock deletion or fabricated proof is part of rollback.

Evidence: [native summary](../../../DELTA-final-production-20261104/native-summary.json), [compatible build provenance](../../../DELTA-final-production-20261104/compatible-worker-1/build-evidence.json), [fresh hash verification and per-process log locations](../../../DELTA-release-approval-20261104/safety-evidence-v3.json). Each result's `production_qualified` remains false.

## 5. Secrets, resources and minimum operation scopes

Live Core has only the observed secret names `INDEXNOW_ADMIN_SECRET`, `MESHKORE_API_KEY`, `PARTNER_GATEWAY_SECRET`. Their values were neither read through the provider API nor exported. Core binds the existing `PROOFS` R2 bucket, `ANALYTICS_DB` D1 database and `BROWSER`; no Queue or Durable Object binding was observed. Notification/dead-man/recovery integration flags and credentials must not be assumed installed just because local adapters exist. Treasury is a public receive address, not a signing credential.

The read-only metadata check succeeds using the existing account session; no production token broadening is needed for it. Billing scope belongs in the separate cost-permissions review. Future deployment/migration credentials must be restricted to the approved account and required services; a Billing 403 is not a reason to add general production management permissions. Never copy a Treasury signer into GitHub or Cloudflare.

| Proposed operation | Separate approval needed | Exact boundary |
| --- | --- | --- |
| Local candidate/source commit | No provider mutation; root integrates once | Record final source SHA and changed files; do not push/merge without authorization |
| Core Worker deployment | `core-cloudflare`, exact source/artifact and fallback identities | Existing `delta-witness-api`; approved var policy, previous app version, overlay, bindings and private bucket preserved |
| D1 0002 | `d1-migration` plus Core scope | Existing telemetry database only; backup/column/ledger checks first; no destructive rewind |
| Existing Core secret installation | `core-secrets` plus Core scope | Current release train installs only `PARTNER_GATEWAY_SECRET` and `INDEXNOW_ADMIN_SECRET`; it does not provision notification secrets automatically. A secret write can create a new version and invalidate the approved old-ID gate: perform approved wiring separately and review its new baseline before approving code upload, never bypass the gate |
| Notification / external monitor connection and a real test notification | Named provider, recipient, event/receipt path and minimal secret entries | Separate external-wiring/send authorization; not included by code approval or a successful local fixture |
| Recovery/observer/notification flags or new credentials | Explicit setting-by-setting approved delta | Unknown additional vars fail closed in the guard until reviewed into the candidate configuration |
| GitHub monitor/workflow activation | Explicit branch publication/automation change approval | One existing loop; no duplicate schedule or silent task toggling |
| Gateway, Pages, npm/PyPI/MCP, catalogs or IndexNow | Their own release scopes | Excluded from the proposed minimal Core safety release; no automatic full release train |
| Backup export/restore, data repair, refund, signing or paid canary | Their own exact action approval | Not granted by any row above; no funds operation in this package |

[`release-scope.mjs`](../../scripts/release-scope.mjs) requires exact equality of requested/approved scopes and enforces parent dependencies. [`check-release-authorization.mjs`](../../scripts/check-release-authorization.mjs) requires explicit workflow dispatch, execute=true, exact requested/approved source, and separately identified rollback source/artifact. A passing local build or tag grants none of these permissions.

## 6. Release decision and concrete conditions

**This safety branch is locally closed for the identified configuration-preservation gap. Overall production remains NO_GO.**

Before a requested release can become a reviewable authorized action:

1. Root integrates one final source revision and records the exact candidate bytes, release-tooling hashes, fallback composition and changed configuration. Preserve the current 1 / 5 / 10 USDC new-order policy and original historical orders.
2. Close the separate independent-monitor, real-notification and cost-source gates with external evidence or explicit auditable limitations. Do not call this native-process evidence a substitute.
3. Approve an exact operations list. Fill `DELTA_APPROVED_RELEASE_SHA`, `DELTA_APPROVED_ROLLBACK_SHA`, `DELTA_APPROVED_ROLLBACK_ARTIFACT_SHA256`, `DELTA_APPROVED_RELEASE_SCOPES`, `DELTA_APPROVED_VARIABLES_POLICY`, `DELTA_APPROVED_CORE_PREVIOUS_APP_VERSION`, `DELTA_APPROVED_CORE_PREVIOUS_DEPLOYMENT_ID` and `DELTA_APPROVED_CORE_PREVIOUS_VERSION_ID`; verify any GitHub protected-environment approval settings instead of assuming they exist.
4. Refresh current deployment identities, settings, original proof hashes, outstanding order/recovery/outbox records, D1 schema/ledger and private-bucket state. Securely establish the approved backup and restore constraints. The earlier inventory is neither a lock nor an atomic backup.
5. Execute only the authorized scoped release. A wrong guard field, source/artifact hash, migration ambiguity or unknown provider outcome blocks subsequent mutations. Read the original result before any retry.
6. After release, independently verify deployment identity, unchanged configuration/proof objects/prices, actual Cron execution and recovery ownership. No paid self-test. Begin the separately approved real 48-hour acceptance only after all its external monitoring and receipt prerequisites exist.

Rollback decision: stop and inspect the exact current state; use the qualified compatible consumer only for supported original obligations and retain independent monitoring. If the new state cannot be consumed, choose a reviewed forward repair and preserve the liability. Do not run a raw historical Worker rollback or database restore merely to make `/health` green.

No claim of deployment, 48-hour acceptance, notification delivery, actual production rollback, customer payment or contribution margin is made by this report.
