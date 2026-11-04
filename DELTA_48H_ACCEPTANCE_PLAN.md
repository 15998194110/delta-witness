# DELTA 48-hour unattended acceptance

NOT STARTED. This is a production evidence contract, not a scheduled local test or proof of cloud execution. No synthetic transaction can satisfy commercial acceptance.

Start only after exact candidate/version/config readback, approved release, verified backup/rollback, real external monitoring and authorized notification destination. Record immutable window ID, UTC start/end, release SHA, Worker version, binding/config hashes, schedule activation evidence and approved fault scope. Minimum actual elapsed time is 48 hours; future timestamps and accelerated clocks do not qualify. Material fixes start a new window and retain failed windows.

| Requirement | Evidence and decision rule |
|---|---|
| Scheduler continuity | Enumerate expected UTC slots from effective cron; retain scheduled/start/completed/last-success, invocation/run IDs, business outcome and persistence receipt. Duplicates never fill missing slots. With the current cadence, a 48h window has 960 three-minute, 192 fifteen-minute and 48 hourly slots. |
| Independent failure detection | Third missed expected slot after documented grace creates stable episode. Main domain unavailable, observer unavailable and both unavailable must be distinguishable. Third provider produces an independently retrievable real alert. |
| Recovery | Original task ID, lease/fence, checkpoint and bounded retries survive restart. Failed/unknown work remains visible after another lane succeeds. No unsafe redispatch for lost ACK. |
| Notifications | Original intent, provider email ID, authenticated receipt, delivery meaning and explicit owner ACK remain separate. Verify reject/429/unknown and recovery using only approved destinations. No proof of human reading from email delivery. |
| Treasury | Consecutive checkpoint ranges with hashes/RPC sources, explicit gaps and reorg status. Preserve unknown source/cost/refund states. All-RPC outage resumes original cursor; short zero scan cannot be called all-time zero revenue. |
| Orders | Original authorization/settlement/fulfillment/receipt identities; no duplicate charge; original proofs verified; failed historical observation produces retained actionable liability. No silently disappearing quarantine. |
| Isolation | IndexNow, catalog failure or notification outage cannot stop Treasury or erase order work. Independent monitor observes failures in its own domain. |
| Cost | Actual provider invoice/usage/allocation sources or explicit UNKNOWN. Positive estimates alone cannot unlock expansion. |
| Long absence | No local device/browser/chat heartbeat needed. Credential permissions/expiry and quota errors are visible and escalate without deleting obligations. |

Fault injection that stops services, denies storage or disrupts RPC is limited to an independently authorized isolated cloud replica. Production observation must not intentionally lose customer work. A local process kill validates local recovery only; it is not a real provider outage. Close the local computer for the cloud observation window without using the computer as the monitoring engine.

Each run exports source reference, observation time, exact release, bounded coverage and digest. Missing results => UNKNOWN/STALE, not zero. Failures have cause class (scheduler absent / queued / runner absent / timeout / business failure / persistence unknown / notification unconfirmed), owner and original checkpoint.

Window PASS requires complete expected-slot accounting, all material incidents recovered or explicitly accepted with tracked residual obligations, no unhandled payment safety violation, independent alert evidence and stable Treasury coverage. Absence of real orders is reported explicitly: availability acceptance may pass while paid-production recovery and revenue remain unverified. [Commercial Gate 5](DELTA_REVENUE_OPERATIONS.md) additionally requires an independent genuine buyer, valid output, actual Treasury receipt and attributable actual cost/margin.
