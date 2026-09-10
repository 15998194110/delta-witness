# DELTA Witness autonomous growth evidence — 2026-09-10 08:06 +08

## Executive state

- Core production integrity: healthy on the last full discovery pulse; DELTA v0.7.0 paid surfaces remained live on Base.
- Production prices preserved: Capture $0.03, Preflight $0.03, Guarded Action Pilot $10.
- Treasury: `0x1990e21bc219696ff7fbc26527dbaed335ac6367` on Base (`eip155:8453`), canonical USDC `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`.
- Fresh independent Treasury reconciliation completed through Base block **51,104,692** at `2026-09-10T00:05:35Z`.
- Treasury candidates in the 50,000-block audit window: one 0.03 USDC transfer, tx `0xdac6c2ccc3857685b52dfdd18322dd3968d2f074a2d3ecc64434b9b4c7219fe9`, payer `0x7e6b6556322c4e26c567a867964ac793f5ee2b1c`, classified `payapi_platform_verification` and therefore `customer_revenue=false`.
- `unclassified_usdc=0`; no new stranger/customer `treasury_received`, no customer settlement, customer revenue remains **$0.00**.
- One Base RPC `eth_getLogs` 429 occurred during reconciliation and recovered on retry; reconciliation completed successfully and independently of marketplace health.

## Tollbooth marketplace attempt

Tollbooth was selected as a free/no-account marketplace surface with documented service registration and manifest-ingestion APIs and public x402 settlement activity. Direct execution was attempted instead of stopping at research.

### Direct registration

1. POST `/api/services` for Capture, Preflight, and Guarded Action Pilot with initial categories returned HTTP 422 `Unknown category`.
2. The public GET `/api/services` discovery endpoint then returned HTTP 500 after bounded retries. This was treated as recoverable channel degradation, not mission failure.
3. Category fallback probes were executed. `data` and `tools` did not return the validation-level 422 seen on clearly invalid categories; instead they returned HTTP 500 after retries, consistent with an upstream/server-side failure after category validation. Other candidates (`data-api`, `web-data`, `verification`, `tooling`, `developer`, `utility`, `other`, `research`, `web`, `api`) returned HTTP 422 unknown-category.

### Official manifest fallback

The official `/api/manifests` path was then tried using three `agent402/manifest@1` manifests carrying the exact DELTA Base asset, Treasury and prices. Three supported/fallback payload shapes were attempted with bounded retry/backoff:

- `{manifests:[...]}` wrapper: HTTP 500
- raw manifest array: HTTP 500
- single manifest: HTTP 500

Four independent catalog readback attempts also returned HTTP 500. `MANIFEST_INGEST_SUCCESS=0`.

Conclusion: Tollbooth is currently a **degraded external channel**. The listing is **not claimed completed**. The failure does not affect DELTA production integrity or Treasury reconciliation and is deferred for recheck rather than treated as terminal.

## Funded buyer demand scan

### PayanAgent

Previously identified funded request remains the preferred compatible opportunity:

- request `ks76vc9pzpz3qfgf8aawjckn5n8bezhf`
- title: Build a catalog endpoint-health checker
- 0.04 USDC escrow deposit confirmed on Base
- DELTA bid `jd79ndx8s7y59tkcvjbars0vf18e33z9`
- latest public scan: request still open; no acceptance, fulfillment receipt, payout or DELTA Treasury settlement.

Other PayanAgent funded requests observed either required a funded buyer wallet/real x402 purchase, wallet signing/asset movement, or security-test value movement and were rejected by the standing financial/risk boundary.

### Taskmarket

A fresh public API scan found ten open funded tasks, including 2–4 USDC research/build bounties and a 0.01 USDC Firefox execution task. The Taskmarket worker submission path requires a worker-wallet EIP-191 signature. No submission was made because autonomous wallet authorization/signing is explicitly out of scope. High-competition bounties with dozens to hundreds of submissions were not pursued where expected contribution margin was unattractive.

## Discovery / neighbor-demand notes

- Existing DELTA discovery surfaces continue to include Agent402.Tools, Agenstry, 402 Index, PayAPI, x402 Arena, Market402 and agent-tools.cloud.
- Fresh independent x402 ecosystem observation continues to show paid neighboring services and paid verification/preflight-like demand; this supports external market existence but is not counted as a DELTA buyer or settlement.
- Fee-gated surfaces (including examples requiring listing/payment fees) were skipped under the no-autonomous-fee rule.
- Surfaces requiring an unverified business email or acceptance of account/legal terms were not auto-registered.
- Daily autonomous outreach cap was already exhausted at 3/3 for the natural day; no additional outreach was sent.

## Operating ledger

| channel/source | listing_status | discovery_status | buyer_count | settlement_count | verified_neighbor_demand | external_requests | 402_intents | paid_settlements | treasury_received | revenue | variable_cost | contribution_margin | evidence_quality |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| DELTA production | live | live | 0 customer | 0 customer | n/a | no new attributable customer request proven | 0 new customer | 0 customer | 0 new customer | $0.00 | $0.00 this run | $0.00 | A production/Treasury |
| Base Treasury | n/a | n/a | 0 new | 0 new customer | n/a | n/a | n/a | 0 new customer | 0 new customer | $0.00 | $0.00 | $0.00 | A canonical USDC logs through block 51,104,692 |
| PayAPI verification | existing verified listings | discovered | 0 customer | platform verification only | yes, platform test | platform verification traffic | platform/test | platform/test | known historical verification receipt(s) | excluded | $0 DELTA-paid | excluded from customer margin | A chain + attribution |
| PayanAgent funded request | bid submitted | open | 1 funded requester surface | 0 DELTA payout | yes | 1 funded compatible request | not yet accepted | 0 | 0 | $0.00 | $0.00 | pending | A escrow receipt / B open-state |
| Taskmarket | no DELTA submission | 10 funded tasks discovered | multiple requester surfaces | 0 DELTA | yes | 10 open tasks scanned | 0 DELTA | 0 | 0 | $0.00 | $0.00 | $0.00 | A public API for task state |
| Tollbooth | not completed | channel degraded | 0 attributable | 0 | small public paid marketplace activity observed | 0 attributable | 0 | 0 | 0 | $0.00 | $0.00 | $0.00 | B external API attempts; repeated 5xx |

## Risk / accounting assertions

- No listing/signup/verification fee was paid.
- No wallet was authorized or signed, no private key was exposed, and no asset was moved.
- No legal commitment was accepted.
- Platform self-tests and verification transfers remain excluded from customer revenue.
- `value_authored`, `payment_authorized`, `settlement_confirmed`, and `treasury_received` remain distinct.
- External dependency 5xx/429 failures were isolated; DELTA core integrity checks remain fail-fast while third-party degradation is retried/fallbacked/deferred.
