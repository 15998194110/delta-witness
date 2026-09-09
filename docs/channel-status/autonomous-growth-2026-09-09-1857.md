# DELTA autonomous growth status — 2026-09-09 18:57 +08:00

Conservative accounting rules remain unchanged: discovery/listing/probe activity is not buyer revenue. Only non-project canonical Base USDC received by Treasury and reconciled to DELTA settlement/proof/telemetry is customer revenue.

| channel/source | listing_status | discovery_status | buyer_count | settlement_count | verified_neighbor_demand | external_requests | 402_intents | paid_settlements | treasury_received | revenue | variable_cost | contribution_margin | evidence_quality |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| DELTA core / Base Treasury | live | Capture and Preflight production 402s restored and verified at $0.03 to canonical Treasury; Guarded Action Pilot remains $10 | 0 new | 0 new | n/a | 0 recognized new customer requests | 0 recognized new customer intents | 0 new | 0.00 USDC new | 0.00 USDC new | n/a | n/a | A |
| PayanAgent x402 marketplace | live: Capture, Preflight, Guarded Action Pilot | routed challenge verified end-to-end: $0.03 / $0.03 / $10, Base eip155:8453, exact Treasury | 0 new | 0 new | 4 funded adjacent technical requests reviewed; only the existing $0.04 endpoint-health checker is compatible without prohibited wallet spending/security risk | 1 known compatible funded request remains open | 1 known bid/offer path from prior run; no new accepted intent | 0 new | 0.00 USDC new | 0.00 USDC new | public Capture/Preflight model estimate $0.0028825/call; Pilot challenge advertises $0.004 | public Capture/Preflight model estimate $0.0271175/call; Pilot challenge advertises $9.996 | A listing/402; A escrow existence; no settlement evidence |
| Agent402 | live | registration refresh accepted: listed=true, 6 tools, Base, routable=true, health=1; immediate generic search propagation not claimed | 0 new | 0 new | platform adjacent demand only | 0 attributed | 0 attributed | 0 | 0.00 | 0.00 | n/a | n/a | A registration / B discovery propagation |

## Core integrity repair

A fresh Payan route probe showed a material contradiction: its catalog metadata advertised DELTA Preflight at $0.03 while the live routed 402 challenge returned $1.00. Repository source also had `PREFLIGHT_BASE_PRICE_USD="1"`, contrary to the current owner mandate to keep public Capture/Preflight at $0.03. The source configuration and pricing-integrity test were aligned to $0.03; 55/55 tests passed; Cloudflare Worker version `3129c908-ed4d-466e-8ae0-4fb8c1acdf8b` was deployed. The first immediate post-deploy probe still observed propagation lag on Preflight. An R2 override check found no `pricing-overrides/preflight.json` object; after bounded recheck, direct production and Payan-routed challenges both verified Capture=$0.03 and Preflight=$0.03. Payan-routed Guarded Action Pilot independently remained $10, all three using canonical Base USDC and Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367`.

## Treasury reconciliation

Independent canonical Base USDC reconciliation completed through block `51080564` with zero new candidate transfers in the scanned window. Therefore this run records `treasury_received=0`, `revenue=0`, and no new `settlement_confirmed`; prior First Stranger Revenue remains historical and is not re-counted.

## Demand/risk gating

PayanAgent exposed multiple funded escrow requests, but newly observed x402 example tasks require DELTA to fund/sign a buyer wallet, and a bug-bounty request requires security testing plus asset movement. Those were not bid because they violate the current financial/risk boundary or have uneconomic contribution margin. The known $0.04 catalog endpoint-health checker remains the only compatible funded request already bid in the prior run; no duplicate bid was submitted. Daily outreach quota was already exhausted at three first-contact emails, so no additional outreach was sent and silence was not chased.

IndexNow core submission encountered repeated upstream 429 responses surfaced through a 502 wrapper and was isolated as recoverable channel degradation; Base-app IndexNow succeeded independently. No third-party channel failure blocked Treasury reconciliation or other checks.
