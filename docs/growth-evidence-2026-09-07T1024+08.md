# DELTA growth evidence — 2026-09-07 10:24 +08

Conservative accounting applies: discovery is not buyer activity; an unpaid 402 probe is not revenue; only non-project `treasury_received` reconciled to DELTA can be recognized as customer revenue.

| channel/source | listing_status | discovery_status | buyer_count | settlement_count | verified_neighbor_demand | external_requests | 402_intents | paid_settlements | treasury_received_usdc | revenue_usdc | variable_cost_usdc | contribution_margin_usdc | evidence_quality |
|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| Agent402 Smart Order Router — Guarded Action Pilot | live / routable | exact semantic query `guarded action pilot` ranks DELTA #1; score=21, health=1, Base, $10 | 0 | 0 | yes | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | 0.00 | A |
| Agent402 Smart Order Router — Capture | live / routable | exact semantic query `page-state proof` ranks DELTA #1; score=21, health=1, Base, $0.03 | 0 | 0 | yes | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | 0.00 | A |
| agent-tools.cloud x402 directory | live | IDs 22856/22857/22858 all read back `health=ok`, exact Base USDC payment terms and canonical Treasury | 0 | 0 | yes | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | 0.00 | A |
| Coinbase x402 Bazaar | not_indexed | complete scan of 28,239 resources returned zero DELTA matches | 0 | 0 | yes | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | 0.00 | A |
| Base Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367` | n/a | independent canonical USDC reconciliation returned `TREASURY_RESULT=[]` | 0 | 0 | n/a | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | 0.00 | A |
| PayanAgent funded-request API | n/a | degraded after bounded retries: HTTP 500 | unknown | unknown | unknown | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | 0.00 | B |
| true402 readback | previously accepted | transient DNS degradation after bounded retries; prior listing state is not invalidated | 0 | 0 | unknown | 0 | 0 | 0 | 0.00 | 0.00 | 0.00 | 0.00 | B |

## Material routing propagation

Fresh Agent402 registration readback returned `listed=true`, `toolCount=6`, `networks=["eip155:8453"]`, `routable=true`, `health=1`.

The exact buyer-router query `guarded action pilot` now returns DELTA first:

- seller: `https://delta-witness-api.ruphussten.workers.dev`
- slug: `guardedActionPilot`
- method/route: `POST /v1/guarded-action-pilot`
- price: `10` USDC
- score: `21`
- health: `1`
- network: `eip155:8453`
- `routerDispatchEligible=false`
- `routerDispatchReason=settlement_required`
- Base detail: `below the settlement floor`

This is a genuine discovery/ranking milestone, but it is not a paid call. Agent402's returned dispatch legend states that on Base, `settlement_required` means the router only pays sellers whose on-chain settlement history is above its floor from enough distinct payers. DELTA must not manufacture this history with self-pay or canaries.

The exact query `page-state proof` likewise returns DELTA Capture first at score 21, health 1, price $0.03, and the same legitimate settlement-history gate.

## Independent adjacent paid-demand evidence

The same live routing/discovery surfaces show current paid demand adjacent to DELTA's use case, without attributing it to DELTA:

- Agent402 `preflight browser purchase` route: Oblique browser evidence endpoint reports Bazaar `calls30d=700`, `payers30d=16` and is router-eligible.
- agent-tools broker: x402node pre-action/on-chain verification service reports `tx_30d=4557`.
- agent-tools broker: URL preflight service reports `tx_30d=169`.
- agent-tools broker: prompt-quality/payment preflight reports `tx_30d=137`.
- agent-tools broker: x402 endpoint preflight/reputation reports `tx_30d=95`.

These are neighbor-demand signals only. They do not count as DELTA buyers, settlements, revenue, or contribution margin.

## Production contract and revenue reconciliation

External hosted-runner checks confirmed all three current production payment contracts remained healthy:

- Capture: HTTP 402, x402 v2, $0.03 USDC.
- Preflight: HTTP 402, x402 v2, $0.03 USDC.
- Guarded Action Pilot: HTTP 402, x402 v2, exactly $10 USDC.

The independent Base Blockscout canonical USDC query returned `TREASURY_RESULT=[]`. Therefore this evidence pulse recognizes:

- `external_requests = 0` attributable to independent buyers
- `402_intents = 0` attributable to independent buyers
- `paid_settlements = 0`
- `treasury_received = 0.00 USDC`
- `customer_revenue = 0.00 USDC`
- realized `contribution_margin = 0.00 USDC`

The dominant external blocker remains legitimate settlement history / Bazaar indexing, not a DELTA production failure.