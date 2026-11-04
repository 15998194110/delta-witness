# DELTA — single final production decision

Decision date: 2026-11-04 Asia/Shanghai. **Local candidate qualified within the stated scope / PRODUCTION NOT DEPLOYED / REVENUE NOT VALIDATED.** Broad production approval remains **NO-GO** until the external prerequisites below are established. This is the single decision for this handoff; historical reports are supporting history, not competing release instructions.

## Exact candidate and preserved baseline

Runtime source: **`770449062da06d844a14aefabebbc2601677550d`**, branch `codex/cloud-operations-20261103`. Parent `b20f1b1`; previous local fixes remain in its ancestry. Fetch confirmed remote master `455f7be8278205f78e2099b85c45867ba39163b6`, with no remote-only commits. No reset, push, merge, deployment, data migration, secret update, real notification, payment or channel registration was performed. Documentation-only commits after this runtime snapshot do not change the tested candidate.

Frozen source fingerprint: `d226274ee9666c4ae8f3cee821dcdce3bc02492e6863bd7e365c69c58eaebe38`. This fingerprint covers source, tests, scripts, package locks and workflows, not the subsequently written reports.

| Exact built artifact | SHA256 / provenance |
|---|---|
| Candidate Core Worker | `06995a4105a5547afdf9c87d2641794862cc93f039894b1d167712e2c0ceb78f` — [manifest](../DELTA-final-production-20261104/candidate-worker-1/build-evidence.json) |
| Compatible fallback Worker | `c0bf205a78fdfacb0fdf093d70860c15fdbe6859a0e895177171508ea120cde6` — [manifest](../DELTA-final-production-20261104/compatible-worker-1/build-evidence.json) |
| Gateway, Pages, MCP | [44-file build manifest](../DELTA-final-production-20261104/adapter-build-1/build-evidence.json); Pages association fields remain nonempty and byte-equal to the existing source |
| Python SDK | [validation and wheel/sdist evidence](../DELTA-production-readiness-20261104/FINAL-python-validation.json) |

Fallback is a reviewed composition of old product `0dbf2b3`, the selected candidate recovery consumer, zero-byte recovery-input guard and candidate dependency lock. It is not the untouched historical binary. Native tests use the untouched old Worker as a negative control. This qualifies the tested order recovery scope, not all production orders or the fallback's complete monitoring configuration.

The transfer pack contains these exact bytes, the ten requested reports plus security audit, source and synthetic/local evidence with a file-hash index. It excludes credentials, provider configuration homes, live private artifacts and customer pipeline contents. No package or registry version was published; product metadata remains 0.7.1 and any future publication must verify immutable version availability.

## What was actually fixed

- Original paid obligations now survive access revocation, raw-retention expiry and recovery quarantine as explicit reconciliation/remediation responsibility. Available original bytes can restore the original delivery. Lost historical observation is not fabricated; replacement observation or refund has no automatic authority.
- Original paid-undelivered records feed the existing alert system using original settlement age and stable incident identity. Whole-page inventory reads or cursor confirmations that fail degrade the invocation. An individual unknown order remains UNKNOWN for re-observation; it does not automatically create a confirmed debt alert or make that invocation degraded. Later healthy work cannot erase an existing failed run or obligation.
- Notification transport keeps unknown send states distinct from permission to resend; repeated accepted polling no longer exhausts history. Signed raw-body receipts bind to the original provider message and persist replay-safe custody without inventing delivery or human acknowledgment.
- IPv6/private-address bypasses and incomplete DNS views fail closed. Demand scanning has bounded time, bytes and traversal; external service failures are isolated from Treasury work.
- Financial expansion decisions use the existing evidence graph and remain HOLD on unknown costs or incomplete scope. Confirmed negative margin blocks expansion, not entitled paid recovery. Formal 1/5/10-USDC prices are unchanged.
- Core-only release approval no longer implicitly grants migration, secret replacement, marketplace probes or all-channel publication. Exact operation scopes and reviewed variable policy are checked; critical Actions are pinned and Pulse provider credentials are step-scoped.
- Compatible dependency patches removed reported npm advisories for Core, MCP, gateway and Base App. Optional Apify remains excluded; no unsafe major override was used to manufacture a clean audit.

## Decisive local evidence

| Verification | Actual result and limitation |
|---|---|
| Core typecheck | PASS, exact runtime SHA; [record](../DELTA-cloud-operations-20261103/FINAL-typecheck-1.json) |
| Core full regression / historical compatibility | 81 files, **1,289 passed / 1 skipped**; stable source; [record](../DELTA-cloud-operations-20261103/FINAL-core-1.json), [log](../DELTA-cloud-operations-20261103/FINAL-core-1.log). Skip is the historical binary's unavailable direct `storeCapture` export test, not a failed test converted to PASS; native old/new recovery provides separate evidence. |
| Bounded concurrent workload | 200 synthetic orders, concurrency 8, 100 completed + 50 recovered; 25 settlement-unknown and 25 inconsistent artifacts deliberately unresolved. 200 original settlement attempts / 175 synthetic confirmations / 175 Browser mocks; [trace](../DELTA-final-production-20261104/order-workload-1.json). No real revenue/cost asserted. |
| Native process faults / rollback | Six scenarios PASS, 34 local workerd processes; exact candidate/fallback bytes unchanged. Includes strong process kill, failed startup, R2/D1 outage, lost CAS ACK, paid-priority recovery, unknown settlement, missing original proof and real loopback HTTP recovery. [Summary](../DELTA-final-production-20261104/native-summary.json) links every result and hash. |
| Main and auxiliary monitor stopped | PASS using candidate independent observer, separate local processes and a third-timer fixture; [invocation](../DELTA-final-production-20261104/monitor-deadman-final-1-invocation.json), [result](../DELTA-final-production-20261104/monitor-deadman-final-1/result.json). External requests 0; actual notification delivery null. |
| Adapter regression | JS 67; MCP 50; gateway 16; Base App 90; Python 30 PASS. Type/syntax checks and isolated builds pass. [JS record](../DELTA-cloud-operations-20261103/FINAL-js-client-1.json), [adapter audit](DELTA_SECURITY_AUDIT.md), [Python record](../DELTA-production-readiness-20261104/FINAL-python-validation.json). Intermediate adapter runs are source-stable; exact-source build manifest is above. |
| Prices / workflow / build | Owner pricing and authority PASS; 45 workflow YAML files parsed; candidate and gateway builds were network-denied `--dry-run`, zero uploads; Pages/MCP/Python local builds only. [price](../DELTA-cloud-operations-20261103/FINAL-price-1.json), [authority](../DELTA-cloud-operations-20261103/FINAL-price-authority-1.json), [build](../DELTA-cloud-operations-20261103/FINAL-adapter-build-1.json). |
| Live readback | Bounded public read-only requests failed from this environment; [record](../DELTA-final-production-20261104/public-readonly.json). This is not evidence that DELTA is down. Current deployed revision, bindings and original proof preservation were not newly certified. |

Test counts are supporting reproducibility data, not business acceptance. All financial/Browser/provider fault fixtures are synthetic. Failed intermediate runs, incomplete harness logs and previous source snapshots remain retained; only the above qualified runs establish the final local result. No local simulation is a 48-hour production run.

## Gate decision and remaining responsibility

| Gate | Status | Evidence still required / responsible party |
|---|---|---|
| 1 Engineering | **Local qualified scope PASS; broad release conditional** | Core and selected adapters pass local checks. Provider browser socket/subresource egress and hard work termination remain unverified; Apify release HOLD. Codex must qualify effective provider constraints after account access or review a constrained target policy. |
| 2 External integration | **BLOCKED / not falsely simulated** | Cloudflare login/read-only inventory; independent third-domain timers and recipient; native notification delivery; actual bill/service allocation/refund coverage; provider security/time limits. Owner supplies required account consent/credentials, Codex verifies readback. |
| 3 Controlled release | **NOT AUTHORIZED / NOT DEPLOYED** | Exact SHA, scopes, variable policy, backup/restore and in-flight obligation inventory approval. Codex then executes only approved operations. |
| 4 48-hour unattended | **NOT STARTED** | Actual cloud interval with expected-slot accounting, independent alert receipt, continuous Treasury coverage, retained obligations and original recovery evidence. Codex executes after Gate 3. |
| 5 Commercial validation | **NOT VERIFIED** | Independent buyer purpose/authorization, unique settlement, original delivery, canonical Treasury receipt and attributable actual costs/margin. No owner canary or directory traffic substitutes. |

This report deliberately does not use unconditional “ENGINEERING READY” or “PRODUCTION VALIDATED”. The documented provider prerequisites prevent claiming complete public-capture security or production readiness. Missing original historical bytes are handled as a visible, actionable obligation; they do not require endless attempts to reconstruct an impossible historical observation.

### Material limits that remain open

1. **Browser Quick Actions**: official session Guardrails do not apply to this API. DoH/URL checks do not pin browser sockets or prove all subresources resist DNS rebinding. A caller deadline does not prove the provider stops work/billing immediately. This needs actual provider assurance and an approved isolated probe or separately reviewed target restrictions. [Security audit](DELTA_SECURITY_AUDIT.md).
2. **External wiring**: real independent monitoring, sender/recipient approval, provider receipts, secret/access/bucket settings and credential lifetime have not been verified. Callback code and mock receipts are not a connected production service.
3. **Finance**: no fresh complete Treasury history, itemized bills, fee/refund coverage or qualified production source-verifier contract was acquired. Actual revenue/cost/margin remain UNKNOWN; a zero-due invoice notice is not zero cost. [Finance audit](DELTA_TREASURY_AND_COST_AUDIT.md).
4. **Inventory and fallback scope**: bounded Capture/Preflight pages do not certify all legacy/Pilot/partner/Watch obligations. Before release, inventory and qualify every in-flight category; preserve monitoring when selecting the compatibility fallback. No destructive data rollback or original evidence rewrite is authorized.
5. **Optional distribution**: Apify has five high/four moderate remaining advisories and an unqualified CLI dependency graph, so it stays outside the candidate release scope. Current directory identities/prices, published package versions and stale historical operator records require readback before later commercial activation. No new channels are added.

## What DELTA can and cannot do now

The local candidate can enforce the existing automatic authorized-purchase contract, preserve payment identities, recover durable original proofs, retain unfulfilled liabilities, reconcile bounded evidence without false totals, persist and safely reconcile notifications, isolate scheduler/channel failures, and execute a scoped compatible rollback in the tested environment. It does not depend on a chat window for those code paths.

It cannot yet be represented as newly running unattended in production, connected to a real independent alert recipient, free from provider egress/resource uncertainty, fully reconciled against actual costs, or producing verified independent customer profit. The existing production service was not changed by this work.

The single human handoff is [DELTA_OWNER_ACTIONS.md](DELTA_OWNER_ACTIONS.md). After those external conditions and exact production approval, execution follows [the release runbook](DELTA_PRODUCTION_RELEASE_RUNBOOK.md) and [48-hour acceptance](DELTA_48H_ACCEPTANCE_PLAN.md), then one genuine paid workflow, ten genuine repeat uses, a second independent host and funded recurring service. The long-term 50,000-USDC goal remains a goal, not a promise or achieved revenue.

## Unified document index

1. [Actual architecture](DELTA_FINAL_ARCHITECTURE.md)
2. [Failure matrix](DELTA_FAILURE_MATRIX.md)
3. [Payment and fulfillment audit](DELTA_PAYMENT_AND_FULFILLMENT_AUDIT.md)
4. [Treasury and costs](DELTA_TREASURY_AND_COST_AUDIT.md)
5. [Monitoring and alerting](DELTA_MONITORING_AND_ALERTING.md)
6. [Production release runbook](DELTA_PRODUCTION_RELEASE_RUNBOOK.md)
7. [48-hour acceptance plan](DELTA_48H_ACCEPTANCE_PLAN.md)
8. [Revenue operations](DELTA_REVENUE_OPERATIONS.md)
9. [One owner action list](DELTA_OWNER_ACTIONS.md)
10. This final GO/NO-GO decision

Supplement: [Security and dependency audit](DELTA_SECURITY_AUDIT.md).
