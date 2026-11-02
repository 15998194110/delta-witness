# Existing Cloudflare Cron: local observation candidate

This candidate wraps the existing Cron lanes. It has not been deployed or enabled in Cloudflare. It does not install a scheduler, start an independent business queue, change an original paid order, or establish that the production scheduler is running.

## Existing authority and scope

- `*/3 * * * *` runs the existing MeshKore token/agent heartbeat. Missing configuration is `skipped`, not success. A rejected token or heartbeat becomes `degraded`; transport and deadline failures are explicit.
- `*/15 * * * *` runs the existing prepaid Watch checks and notification outbox. The existing Watch ETag claims, lease, quota, retry/outbox records and cursors remain authoritative.
- The existing UTC 03:00 daily IndexNow slot runs independently of Watch. IndexNow failure does not prevent Watch from executing. The combined `waitUntil` rejects only after each lane has produced its own outcome, so a failed lane is not reported as a successful provider invocation.
- There is no new automatic purchase, signing, settlement, paid-order recovery worker, business retry, lease takeover, deletion, or revenue recognition. A later trigger may repeat the original scheduled operation as before.

## Common observation contract

Run metadata uses `task_id`, `run_id`, `source`, `source_status`, `scheduled_at`, `started_at`, `completed_at`, `duration_ms`, and `outcome`. Here `source=cloudflare_cron_handler` and `source_status=recorded_handler_execution`. `scheduled_at` comes from the actual handler event. The run UUID identifies an observation; `idempotency_key` correlates the lane and scheduled timestamp and **does not deduplicate execution**.

Outcomes are `running`, `success`, `degraded`, `skipped`, `timeout`, or `failed`. `success` describes the lane call only. In particular, Watch `checks_settled` and `notifications_settled` count fulfilled JavaScript promises, which may include skipped records or internally handled outcomes. They do not count paid deliveries, receiver acknowledgements, settlements, or sales. Rejected work and inventory failures are separate counts. Existing handled capture failures, notification failures, deferred retries, uncertain leases/CAS and recovery-required or margin-paused work are counted in `checks_failed`, `notifications_failed`, `checks_deferred`, and `notifications_deferred`; these make the lane degraded even when the original function returns normally. Successful negative Guard observations (`ok=true`, `safe=false`) remain successful observations. These counts describe record visits, not unique new failures: the existing two outbox passes may visit the same deferred event. They add no R2 reads/writes, retries or quota debits. Notification at-least-once semantics and receiver event-id deduplication remain unchanged.

The private status projection adds `last_success_at` from the recorded latest-success pointer, or `null`. A missing lane record is `source_status=unknown`, `outcome=unknown`; it is not inferred to have succeeded. `provider_scheduler_enabled` and `next_run` are always `null` here because a handler record does not prove current provider configuration. `paid_order_recovery_connected=false` and `revenue_observed=false` explicitly delimit this view.

## Bounds and privacy

The work deadline is 20 seconds for MeshKore, 170 seconds for Watch, and 15 seconds for IndexNow. Each start/end observation has its own 2-second deadline; these can add up to 4 seconds around a lane. `duration_ms` spans handler start through work outcome, including the initial observation and excluding final observation persistence. MeshKore fetch and its actual response stream share the lane signal and the token JSON is capped at 16 KiB. Logs and observations never include tokens, raw provider responses, arbitrary exceptions, order bodies, or customer identifiers.

Watch retains its existing finer bounds: 20-second inventory/cursor/notification operations and 50-second check operations, including their original cancellation fences. The existing sequential phases total at most 150 seconds when all phase deadlines are reached; the 170-second wrapper is an outer observation limit. JavaScript cannot physically cancel an already submitted provider operation. A timed-out R2 write may still commit its original bytes; the wrapper stops its own subsequent latest-pointer work and never erases or retries it.

## Optional persistent observations

Persistence is disabled unless `SCHEDULED_OPERATIONS_OBSERVABILITY_ENABLED=true`. No default was added to Wrangler. When separately authorized, existing private R2 may hold only these additional keys:

```
operations/scheduled/runs/<task>/<run UUID>/started.json
operations/scheduled/runs/<task>/<run UUID>/completed.json
operations/scheduled/latest/<task>.json
```

Start/end records are create-only. Latest metadata uses the original object ETag for a single CAS attempt. It orders records by scheduled time, start time, and run ID; an older completion cannot replace a newer run, and a late start cannot regress its own final record. Last-success is monotonic independently of the latest failure. A conflict or uncertain write is reported as such; it does not retry work, delete evidence, or claim durable observation success. R2 reads are bounded to 8 KiB and each run payload to 4 KiB. Invalid existing metadata is preserved and reported unavailable.

This flag would introduce additional R2 requests and accumulating run records. Retention, cost budget, production enablement and any deletion policy require a separate decision. This candidate creates no cleanup task and changes no proof retention.

`GET /internal/scheduled/status` requires the already configured `INDEXNOW_ADMIN_SECRET` bearer credential and rejects query strings and browser Origin headers. It returns private/no-store/noindex responses. It reads three fixed latest keys only; it does not enumerate or expose order/proof objects. No new secret is required or copied. A disabled flag or unavailable metadata returns a controlled 503, not a green health claim.

## Local verification and unresolved production facts

The isolated tests use synthetic R2, controlled clocks, mocked HTTP and no real provider calls. They cover original Cron routing, missing configuration, MeshKore rejected/malformed/stalled responses and late continuations, independent Watch/IndexNow outcomes, rejected Watch items, observation timeouts and CAS races, and private status access/redaction. Existing Watch and payment-gate tests are run with the candidate. Exact command evidence is recorded separately by the local check runner.

The audit could not authenticate the current Cloudflare account with the existing expired local session, and public transport probes from that audit environment timed out. Neither result proves an API outage. Production Cron state, deployed version, invocation logs, R2 observation enablement, and actual independent cloud execution remain unverified. This local candidate must not be described as a restored production automation or revenue loop.
