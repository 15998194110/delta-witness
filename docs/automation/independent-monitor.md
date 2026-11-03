# Independent monitoring release gate

This change is local preparation. No scheduler, provider account, notification destination or production flag was activated. `.github/workflows/operations-observer.yml` intentionally has only `workflow_dispatch`, plus exact approved source SHA and enablement guards. Adding its recurring trigger and creating/configuring third-party checks require separate production authorization.

## Authority and failure domains

Core's R2 order, settlement and fulfillment records remain payment/delivery authority. Cron observations and monitoring receipts do not authorize charges, fulfill orders or establish revenue. Cloudflare Cron invokes existing business lanes; the wrapper records scheduled/start/completion times and failures without replacing those lanes. Original scheduled/recovery consumers keep their existing CAS identities, checkpoints, bounded retries and deadlines. Failures do not disable Cron or dispatch replacement financial work.

| Domain | Responsibility | Failure evidence |
|---|---|---|
| Cloudflare | Core business lanes; immutable invocation events plus bounded CAS projection | `/internal/operations/cron`, authenticated/no-store; started but unfinished records and degraded completions |
| GitHub Actions candidate | Read-only independent observation of Core; retains its own artifact | Three missing expected slots, duplicate run, expired lease, failed completion, source unavailable; no business replay |
| Healthchecks candidate | Independent wall-clock deadman timers for BOTH primary Cron classes and the GitHub observer | Can signal absence when both Cloudflare and GitHub fail; native notification configuration/delivery still needs external acceptance |

The third system must have its own owner notification integration and timer. Sending its pings through Cloudflare's outbox would defeat independence. Separate checks are required for Cron3, Cron15 and the observer. A Healthchecks `200 OK` confirms a heartbeat receipt only; it does not establish that an alert email was delivered. Rate-limited/not-found `200` bodies are rejected. Secret ping UUID URLs belong only in provider secret stores.

This is separation across three providers, not a claim that every network, mailbox or identity failure is independent. The exact third-party receiver and fallback contacts must be validated before release; a shared mailbox outage remains a material failure mode.

## Records and bounded behavior

`src/cron-observer.ts` writes private immutable start/completion events with `scheduled_at`, `started_at`, `completed_at`, run ID, a 200-second execution lease and outcome. A CAS projection retains 48 runs per Cron class; later success cannot replace earlier failed event bytes. It is an intentionally bounded view, never a complete historical inventory. Only explicit CAS rejection receives up to three attempts; unknown write acknowledgement receives no blind rewrite.

The wrapper does not suppress paid recovery merely because monitoring storage is down. Observation writes are fenced at two seconds, provider pings at four seconds with bounded bytes; original lane outcomes are awaited independently. Missing evidence is degraded, and provider control outcome is distinguished from business work outcome. Failure details never include provider response bodies, private proof data or credentials.

`scripts/independent-monitor.mjs` uses a fixed Core origin and fixed Healthchecks origin, refuses redirects, bounds response bytes and permits only two GET attempts. Every assessment lists expected/missing slots and the most recent known success. It accepts at most 48 recent runs per class, rejects malformed/future/duplicate identities and requires fresh observation time. A third missed expected slot triggers an issue; active executions exceeding their lease and repeated invocations remain visible. Older immutable failure history remains in Core even when outside the recent assessment window. An unavailable Core returns unknown, never healthy.

Configuration candidates: `CRON_OBSERVER_ENABLED`, `CRON_EXTERNAL_HEARTBEAT_ENABLED`, `CRON3_HEALTHCHECKS_PING_URL`, `CRON15_HEALTHCHECKS_PING_URL`; Actions `DELTA_INDEPENDENT_MONITOR_ENABLED`, `DELTA_APPROVED_MONITOR_SHA`, `DELTA_MONITOR_ACTIVE_SINCE`, `DELTA_OPERATIONS_ADMIN_SECRET`, `DELTA_MONITOR_HEALTHCHECKS_PING_URL`. No actual credentials or enablement values are added to the repository.

For later approved activation: bind exact source SHA, configure three external checks with explicit UTC periods/grace and tested owner contacts, then authorize the independent workflow's recurring schedule. Test failure receipt and silence expiry before enabling the primary pings. Do not rely on a successful manual workflow run as proof of future scheduling. GitHub's documented scheduled-event delays/drops mean its observer alone cannot meet the missed-run requirement.

## Isolated fault evidence and limits

`scripts/rehearse-independent-monitor.mjs <fresh-output-directory>` starts separate real local OS processes. It observes a healthy fixture, force-kills the primary, runs the observer again, and then verifies a separate timer signals absence after both child processes exit. All transport maps to explicit loopback fixtures; unknown remote hosts are rejected, ambient credentials are removed, and there is no external notification. This is real local process termination and protocol behavior, not actual Cloudflare/GitHub/Healthchecks outages or a 48-hour soak.

P0-1 remains externally open until the exact cloud runtime and third-provider timers are configured with authorization and verified alert delivery. Source code or local ping acceptance cannot close that gate. A restarted original consumer, not the monitor, owns any recovery of a paid obligation.

## Actual read-only finding

The latest three accessible Discovery Pulse runs were successful but started at 2026-11-02 20:49:57Z, 2026-11-03 02:56:17Z and 2026-11-03 10:58:24Z. The inspected remote master `455f7be8278205f78e2099b85c45867ba39163b6` declares hourly `21 * * * *`. These observations show six-to-eight-hour gaps among the returned runs, not proof of a specific scheduler failure. The workflow metadata endpoint was unsupported by the connector, and only three runs were retrieved. Job success does not establish customer income. Sanitized response evidence is retained privately in `P0_EXTERNAL_READONLY_1.json` under the release evidence root.

Official contracts checked: [Healthchecks ping API](https://healthchecks.io/docs/http_api/), [check periods and grace](https://healthchecks.io/docs/configuring_checks/), [explicit failure signals](https://healthchecks.io/docs/signaling_failures/), [GitHub scheduled events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
