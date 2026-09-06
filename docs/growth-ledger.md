# DELTA external growth ledger

This ledger is deliberately conservative. Platform reach is not DELTA buyer count. A crawler probe is not revenue. Revenue is recognized only when a non-project payer produces `treasury_received` on Base and the receipt can be reconciled to DELTA settlement/proof/telemetry.

| observed_at | channel/source | listing_status | discovery_status | buyer_count | settlement_count | external_requests | 402_intents | paid_settlements | treasury_received_usdc | revenue_usdc | variable_cost_usdc | contribution_margin_usdc | evidence_quality | evidence / notes |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| 2026-09-07T03:02:05+08:00 | Agent402 x402 index / Smart Order Router | accepted | routable; public index refresh pending | 0 | 0 | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | 0.00 | A | Official `POST /api/index/register` returned HTTP 200 with `listed=true`, `toolCount=5`, `networks=[eip155:8453]`, `routable=true`, `health=1`. Registration is free and non-custodial. Do not infer buyer activity from registration probe. |
| 2026-09-07T03:02:05+08:00 | PayanAgent funded requests | n/a | degraded | 0 | 0 | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | 0.00 | B | `GET /api/v1/requests?status=open&limit=100` returned HTTP 500 on four bounded retries. Channel outage isolated; no conclusion about current funded inventory. |
| 2026-09-07T03:02:05+08:00 | Base Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367` | n/a | reconciled | 0 | 0 | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | 0.00 | A | Blockscout Base token-transfer API returned HTTP 200; no incoming canonical Base USDC transfers were present in the latest returned page. |
| 2026-09-07 | SwarmBazaar | pending_review | submitted, not yet public | 0 | 0 | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | 0.00 | B+ | Free listing submission previously returned HTTP 200 `ok=true`, `payment=null`; do not resubmit while review is pending. |
| 2026-09-07 | x402 Arena | live | verified | 0 | 0 | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | 0.00 | B | Existing Capture and Preflight listings are active/verified; platform probes are discovery evidence only until a real paid settlement reconciles to Treasury. |

## Accounting states

`value_authored` → `payment_authorized` → `settlement_confirmed` → `treasury_received`

Only `treasury_received` from a non-project payer can become customer revenue. Exclude canary/test/self-pay, platform self-tests, registration probes, crawler traffic, directory badges, and uncorroborated marketplace counters.
