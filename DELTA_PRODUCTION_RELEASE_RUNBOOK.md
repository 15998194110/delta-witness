# DELTA controlled release runbook

Status: preparation only; no deployment, remote migration, secret write, task activation or external publication authorized by this file. Final source/artifact hashes and local qualification are in [GO/NO-GO](DELTA_FINAL_GO_NO_GO.md). Never run the whole train merely to publish Core.

## Completed read-only intake and refresh boundary

[2026-11-04 intake](docs/repair/cloudflare-readonly-20261104.md) records actual deployments, private storage, existing D1 schema, legacy proof integrity, Cron events and Actions gaps. Core is 0.7.0, Gateway 0.6.1; local candidate is 0.7.1. Live Core annotation comes from a release side branch, not assumed current master. Preserve the actual observed settings, including the explicitly preserved historical query-redaction setting, unless a reviewed configuration change is separately approved. Billing remains access-denied. This intake is not an atomic backup; repeat version/ETag/in-flight-order checks immediately before an approved release. Do not use `wrangler d1 migrations list --remote` for read-only inspection: the installed CLI initializes the migration table; query existing tables with SELECT instead.

## Read-only intake after provider access

1. Use the existing Cloudflare account login; never copy Treasury keys or production secrets into the workspace. Record account identity, Worker deployment/version IDs, effective non-secret vars, binding identities, both Cron definitions, secret **names** and permissions. Compare against the exact candidate config. Remote Git HEAD is not the deployed version.
2. Capture D1 migration ledger, schema, Time Travel bookmark and counts; inventory R2 original proofs/order bindings/settlement/fulfillment, priority and quarantined liabilities, original notification intents and Treasury revisions. Preserve hashes/ETags and private access; do not place raw customer artifacts into the public release pack.
3. Verify independent external timers and approved real notification receipts. Review full paid-liability inventory across Capture, Preflight, Pilot, partner, Watch and historical obligations. A bounded page is not an exhaustive inventory.
4. Freeze candidate and compatible rollback bytes, config/lock hashes and the real provider rollback version. Bind authorization to exact SHA and selected operations. Readback drift requires review, not overwrite.

## Explicit release scope

[release-scope.mjs](scripts/release-scope.mjs) compares requested JSON scopes with independently approved `DELTA_APPROVED_RELEASE_SCOPES`. Empty, duplicate, unknown, widened and dependency-incomplete scopes fail. Existing exact-source/fallback approval remains required. [release-train.yml](.github/workflows/release-train.yml) consumes only the validated scope outputs.

Examples for review only: `["core-cloudflare"]` submits Core only; it does not migrate D1, write secrets, run authenticated partner probes, publish SDKs or register catalogs. `d1-migration`, `core-secrets`, `gateway-secrets`, `partner-probe`, `indexnow` and each publishing job require separate explicit scope. Gateway currently depends on Core; registry depends on its npm package. There is no wildcard scope.

Worker deploy also requires `DELTA_APPROVED_VARIABLES_POLICY`: `preserve-reviewed` adds `--keep-vars`, while `replace-reviewed` uses the reviewed declarative config. Both require prior comparison of effective values: preserving unknown values or dropping recovery flags is unsafe. Missing policy blocks before the provider callback. Secret values are never stored in the artifact. Local tests cover both modes and zero callbacks on rejection.

The current [Core live guard](scripts/cloudflare-live-config-guard.mjs) now enforces that comparison before migrations/secret steps and again before upload, through [the exact artifact wrapper](scripts/verified-cloudflare-artifact.mjs). It rejects unknown nonsecret vars and changed resource/Cron/observability settings, and explicitly preserves reviewed preview URLs and query-redaction behavior. `--keep-vars` alone is not protection for those settings. The old app version, deployment ID and Worker version ID require separate exact approvals: currently `0.7.0`, `198bd533-8c3e-470a-b7c0-681ef0191182`, and `706c943b-c0e3-42c7-a662-5c3c2a6dcef0`. They populate `DELTA_APPROVED_CORE_PREVIOUS_APP_VERSION`, `DELTA_APPROVED_CORE_PREVIOUS_DEPLOYMENT_ID` and `DELTA_APPROVED_CORE_PREVIOUS_VERSION_ID`.

The version-aware guard actually passed eight production metadata GETs on 2026-11-04; [evidence and limitations](docs/repair/release-approval-safety-20261104.md). After submission it must observe a new single-version deployment and the candidate app/config values, never demand the old IDs again. This remains an optimistic check, not provider CAS or deployed-byte attestation. Coordinate concurrent changes; unknown submission or readback stops further writes and triggers inspection, not automatic resubmission. A secret update that changes the live version requires a new reviewed baseline. The initial proposed scope therefore excludes `core-secrets`, which installs old partner/IndexNow secrets and is not the new notification provisioning mechanism.

Critical release/reliability/Pulse/observer Actions are pinned to exact official repository commits, recorded in [action revisions](../DELTA-final-production-20261104/action-revisions.json). Pulse provider secrets are scoped to their consuming steps, not public marketplace scanners. Historical nonselected one-shot workflows remain outside the release scope.

## Data compatibility and execution

`0002_metric_provenance.sql` is additive nullable telemetry metadata, not a rewrite of historical zero costs. It is not blindly repeatable: compare the ledger and each column first; partial application needs a reviewed forward reconciliation. No destructive R2 migration exists. Freeze deletion/retention changes for this release. D1 restoration overwrites state and requires separate authorization plus preservation of post-backup writes.

Before mutation, retain backups and verify restoration in an approved isolated environment. Provider deployment, secret update and migration are distinct actions; unknown responses require querying the original result before retry. Do not run customer charge/settle as a smoke test. Shadow mode uses sanitized synthetic input and detached mock payment/Browser/storage; it never replays live payment signatures.

After approved deployment: read back version/config; public health/quote/discovery and existing proof hashes; private order authentication and original obligation status; verify unpaid challenges and no capture/settlement; verify actual schedules and recovery flags. A local or remote HTTP 200 is not a financial success.

## Failure and rollback

New startup failure: preserve all data and query current deployment first. Use the **qualified compatible composition** or forward fix, never raw old `0dbf2b3` alone. The rollback must retain the selected candidate's recovery/liability readers and independently qualified monitoring. Its product handler may be older while its consumer understands new observations. Unsupported records stay quarantined/needs_intervention; do not delete them for old readers.

Original complete proofs recover with original settlement, IDs and CAS. Lost response/ACK requires readback, not another payment or delivery. Partial/corrupt/missing proof is an explicit remedy obligation; new observation would require buyer acceptance and a real new timestamp. Refund execution remains separately authorized. The two historical D1 fault-injection missing telemetry rows remain incomplete, never reconstructed as actual zero expense.

Rollback qualification is scoped, not proof of every production liability. Verify original orders, quarantines, queue leases, monitoring and Treasury coverage before declaring recovery. Then begin [48-hour acceptance](DELTA_48H_ACCEPTANCE_PLAN.md). Production approval is pending, not implied by this document.

Official semantics checked: [Wrangler variables/deploy](https://developers.cloudflare.com/workers/wrangler/commands/workers/), [workflow job dependencies and conditions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), [Worker rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/), [D1 restoration](https://developers.cloudflare.com/d1/reference/time-travel/).
