# Post-login production readback — 2026-11-04

**READ-ONLY ACCESS VERIFIED / CANDIDATE NOT DEPLOYED.** [GO/NO-GO](../../DELTA_FINAL_GO_NO_GO.md) remains the single release decision. Login resolves authentication, not external qualification or approval.

Observed approximately06:07–06:24 UTC (14:07–14:24 Asia/Shanghai). Existing OAuth used in memory only. No credentials, customer page bytes or payment authorization headers exported. No deployment, migration, secret update, task activation, notification, registration, payment, signature or refund. Account APIs: GET plus read-only GraphQL and single D1 SELECTs; all D1 responses report rows_written=0 / changed_db=false. Public GETs can record ordinary telemetry and must not be counted as buyer demand.

## Versions and resources

| Item | Actual observation | Evidence |
|---|---|---|
| Git | Intake HEAD9d1aef2 clean; runtime7704490; remote master455f7be unchanged. 23 local-only commits, zero remote-only at intake. This report is a subsequent docs-only change. | [Relationship](../../../DELTA-cloud-readonly-20261104-1/github-version-relationship.json) |
| Core | Live0.7.0; deployment198bd533-8c3e-470a-b7c0-681ef0191182,2026-10-01T01:00:12.822365Z; version706c943b-c0e3-42c7-a662-5c3c2a6dcef0 at100%. | [Deployments](../../../DELTA-cloud-readonly-20261104-1/delta-witness-api-deployments.json), [settings](../../../DELTA-cloud-readonly-20261104-1/delta-witness-api-settings.json) |
| Annotation | af949027 is a side branch; merge base with master f2c7fe76. Its three unique commits only change release scripts/workflow/manifest. Annotation is not binary attestation. | Git relationship above |
| Gateway | Live0.6.1; deployment19e89b13-494f-415e-8a81-a317436d4db8,2026-09-15T23:15:55.904154Z; version6ad94054-5a9b-48eb-82d2-fbc76a2f25f3. Existing Core service binding intact. | [Deployments](../../../DELTA-cloud-readonly-20261104-1/delta-witness-partner-gateway-deployments.json), [settings](../../../DELTA-cloud-readonly-20261104-1/delta-witness-partner-gateway-settings.json) |
| Pages | Productionfc9273aa-76ce-4ba6-a06b-3bcda58438c6,2026-10-22T09:07:09.177076Z, source annotationd2ff4167. Home/manifest200; association header/payload/signature nonempty and byte-equal to preserved candidate source. | [Project](../../../DELTA-cloud-readonly-20261104-1/pages-project.json), [readback](../../../DELTA-cloud-readonly-20261104-1/public-readback.json) |
| D1 | Existing delta-witness-analytics/c9431b00-27c5-4609-9f3d-6af20cb162df; only0001 migration; new0002 provenance columns absent. | [Schema](../../../DELTA-cloud-readonly-20261104-1/d1-schema.json), [columns](../../../DELTA-cloud-readonly-20261104-1/d1-columns.json), [migrations](../../../DELTA-cloud-readonly-20261104-1/d1-migrations.json) |
| Wiring | Browser/D1/R2 present. Secret names only: INDEXNOW_ADMIN_SECRET, MESHKORE_API_KEY, PARTNER_GATEWAY_SECRET. Candidate operations/observer/paid-order recovery flags and real alert wiring absent. No Queue/DO binding in inspected Core/Gateway; not account-wide non-use proof. | Settings above |

Observed redact_query_string=false was intentionally preserved by the old release branch. Do not silently alter it or assume an omitted local field matches it. Any change belongs in the approved configuration policy; raw logs were not read.

## Availability and network diagnosis

Native Node direct access to workers.dev timed out (UND_ERR_CONNECT_TIMEOUT), while Cloudflare reports both subdomains enabled. DNS diagnostics also failed locally. Windows already had HTTP proxy127.0.0.1:8800. Through that existing proxy, with normal TLS verification and no system change, Core/Gateway health, three GET quotes, OpenAPI, x402 discovery and sample proof all returned200. Quotes remain1/5/10 USDC, Base mainnet, original Treasury. OpenAPI shows Capture/Preflight/Pilot as POST. Proof has noindex/nofollow/noarchive and no inline raw artifacts. These GETs are not a new settlement test.

[Direct transport](../../../DELTA-cloud-readonly-20261104-1/worker-public-network.json) and [successful proxy readback](../../../DELTA-cloud-readonly-20261104-1/public-proxy-readback.json) distinguish local network failure from production failure.

## Actual scheduling

Cron remains */3 and */15. Scheduled-event query covers approximately2026-11-03T06:19:46Z–2026-11-04T06:19:46Z:96 distinct15-minute records, all provider success, largest internal interval900s;478 distinct3-minute records, all provider success, one360s interval from2026-11-04T02:57:15Z to03:03:15Z. Expected03:00:15 is absent from this response. Latest06:15:15 leaves trailing analytics delay possible. Old handlers catch some downstream failures: provider success does not establish MeshKore/Watch/business success or48h acceptance. Mixed invocation analytics separately reports4,383 requests and zero recorded runtime errors; not a Cron-only metric.

[Configured schedules](../../../DELTA-cloud-readonly-20261104-1/delta-witness-api-schedules.json), [schema](../../../DELTA-cloud-readonly-20261104-1/cron-schema.json), [actual events](../../../DELTA-cloud-readonly-20261104-1/cron-24h.json).

GitHub rolling30-day window contains152 runs including142 successful Discovery Pulses. Declared hourly schedule nevertheless has a maximum adjacent scheduled-run gap of10.563h (2026-10-12T07:25:51Z–17:59:38Z). Latest Pulse started2026-11-03T23:59:53Z, finished2026-11-04T00:02:24Z, over6h before observation. Its144s job and Treasury step succeeded, not proof of continuous coverage or revenue. Two10/22 Purchase Integrity failures are at Base App test/build while live-price checks succeeded; no timeout diagnosis supported. Candidate operations-observer.yml is absent from remote master; other accounts' monitors remain unverified. Do not create a duplicate Pulse or activate schedules without approval.

[Paginated Actions metadata, steps and gaps](../../../DELTA-cloud-readonly-20261104-1/github-actions-readback.json).

## Proof preservation and legacy orders

R2 stays private: r2.dev disabled, custom domains empty. Pagination7+7+1 returned15 distinct objects/1,153,975 bytes, final short page with no cursor. This completes enumeration at observation time, not an atomic backup. Earlier1000-item responses lacked pagination metadata and remain separately marked incomplete.

Observed12 proof objects/three bundles, two complete legacy fulfillment records, one operational metadata object. No new orders/settlements/Watch/partner/Pilot/operation-ledger objects in this enumeration. This does not exclude obligations outside the bucket or missing historical records. Refresh before approved release.

**Nine original artifact hashes match; both v0.6.0 bundle roots match.** The v0.2 sample's three artifact hashes match; its older bundle algorithm is not certified using the new canonicalization. All12 references exist. Raw bytes were hashed in memory only, never saved/replaced/deleted/publicized.

Both fulfillments lack payment-response headers and response_hash; one lacks paid_price_usd. Do not invent historical fields. Their9/7 Preflight and9/9 Capture match existing [PayAPI reclassification](../growth-evidence-2026-09-10T0125+08-payapi-reclassification.md): both0.03-USDC verification payments are excluded from customer revenue. This is historical evidence, not fresh full-chain reconciliation.

[Privacy](../../../DELTA-cloud-readonly-20261104-1/r2-public-domain.json), [domains](../../../DELTA-cloud-readonly-20261104-1/r2-custom-domains.json), [pagination](../../../DELTA-cloud-readonly-20261104-1/r2-paginated-inventory.json), [redacted records](../../../DELTA-cloud-readonly-20261104-1/persisted-inventory.json), [hash validation](../../../DELTA-cloud-readonly-20261104-1/proof-integrity-readback.json).

## Finance and external conditions

D1 has72,511 rows,2026-08-31T04:14:48Z–2026-11-04T06:05:45Z. Its30-day event aggregate: page_view3,631; payment_required19,333; proof_opened3,150; quote_issued4,264; no payment_verified/capture_completed. Selected-event full history finds two successful rows of each payment_verified/capture_completed with0.06 gross per series. Never add the series together or infer all-time zero receipts from telemetry.

Billing history, billable-usage and billable-usage/info each return403/10000. Another identical login does not establish billing scope. Actual costs, fee/refund coverage, cumulative recognized revenue and actual margin remain UNKNOWN. Quote/manifest costs remain estimates. No Treasury checkpoint changed and no complete fresh chain scan claimed.

[Counts](../../../DELTA-cloud-readonly-20261104-1/d1-counts.json), [30-day events](../../../DELTA-cloud-readonly-20261104-1/d1-events-30d.json), [history](../../../DELTA-cloud-readonly-20261104-1/d1-delivery-history.json), [billing](../../../DELTA-cloud-readonly-20261104-1/billing-history.json), [usage](../../../DELTA-cloud-readonly-20261104-1/billable-usage.json), [period info](../../../DELTA-cloud-readonly-20261104-1/billing-period-info.json).

The [current D1 Time Travel bookmark](../../../DELTA-cloud-readonly-20261104-1/d1-current-bookmark.json) was also read successfully at approximately06:34 UTC. This GET creates neither a backup nor a restore. It supplies a recovery reference at observation time; it does not replace the approved pre-release backup and restore rehearsal.

## Release consequences

Login/inventory work is completed; do not repeat the login request. Candidate0.7.1 and its qualified compatible fallback remain local. Existing cloud Cron does not activate new recovery/accounting/monitoring code. Migration0002, reviewed operational flags, notification/monitor wiring and credential lifecycle require exact approved scope. Do not migrate to make new-schema query scripts work. Preserve resources, prices and original records. Legacy missing fields require non-destructive compatibility treatment, not evidence rewriting.

Remaining: real alert recipient/independent monitoring; billing access/allocation; Browser provider egress/cancellation qualification; financial source/finality/coverage evidence; exact release approval; then48h cloud acceptance and independent customer-profit validation. Engineering work stays with Codex; only provider/authority tasks go in [one owner list](../../DELTA_OWNER_ACTIONS.md). No new channel or paid canary.

## Evidence/API review

[Evidence index](../../../DELTA-cloud-readonly-20261104-1/evidence-index.json) hashes scripts/redacted observations and excludes OAuth configuration. Avoided wrangler d1 migrations list --remote because the installed CLI calls CREATE TABLE via initMigrationsTable; used SELECT only.

Official references: [R2 pagination](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/list/), [object GET](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/get/), [D1 query](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/), [Cron history](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [billable usage v1](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get_account_usage_v1/). Service usage requires allocation; access denied is not zero cost.
