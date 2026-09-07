# DELTA growth evidence — 2026-09-07 17:25 +08

Conservative accounting remains in force. Discovery, registry probes, HTTP 402 challenges and platform verification are not revenue. Only a non-project Base USDC receipt reconciled to DELTA settlement/proof/telemetry is recognized as customer `treasury_received`.

## Material distribution: true402

| field | observed value |
|---|---|
| channel/source | true402 machine-native x402 marketplace |
| listing_status | live / registered |
| discovery_status | exact public registry query returns DELTA |
| buyer_count | 0 attributable on true402 |
| settlement_count | 0 attributable on true402 |
| verified_neighbor_demand | yes — true402 public catalog exposes settled calls on adjacent first-party x402 stalls |
| external_requests | 0 attributable paid requests in this run |
| 402_intents | 0 customer intents recognized; our production verification probes excluded |
| paid_settlements | 0 new |
| treasury_received | 0 new USDC |
| revenue | 0 new USDC |
| variable_cost | 0 recognized in this run |
| contribution_margin | 0 recognized in this run |
| evidence_quality | A listing / A treasury |

The official free no-account registry endpoint `POST https://true402.dev/api/v1/services/register` returned HTTP 201 while reading DELTA's provider-authoritative `/.well-known/x402-service.json`. The resulting public listing is:

- id: `7e147a75-78fb-4ef3-b35b-538a599df023`
- name: `delta-witness-guarded-action-pilot`
- endpoint: `https://delta-witness-api.ruphussten.workers.dev/v1/guarded-action-pilot`
- pricing: `10.00 USDC / pilot`
- chain: `base`
- facilitator: `https://facilitator.payai.network`
- payTo: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`
- capabilities: guarded-action-pilot, browser-verification, page-state-proof, preflight-verification, workflow-safety, shopping, procurement

A follow-up public `GET /api/v1/services?q=DELTA%20Witness&limit=100` returned exactly one DELTA result with that id and endpoint. Production `/v1/preflight` and `/v1/guarded-action-pilot` were independently re-probed immediately beforehand and both returned the expected HTTP 402 plus `Payment-Required` header.

The initial registration attempt supplied a fallback Preflight manifest, but true402 correctly preferred DELTA's provider-hosted `/.well-known/x402-service.json`; therefore the authoritative live listing is the already production-verified $10 Guarded Action Pilot, not the fallback $0.03 Preflight SKU. No incompatible or duplicate listing was fabricated.

true402 explicitly states third-party stalls are free to list, buyers pay the provider directly, and the marketplace does not ingest third-party settlement history into its own reputation ledger. Accordingly DELTA's true402 `transactions/trustScore` remain zero and are not treated as evidence against the independently confirmed First Stranger Revenue.

## Treasury + telemetry reconciliation

A fresh D1 paid-funnel query covering the latest two hours returned `candidate_rows=0`; there is no new `payment_verified`, paid capture or other paid-funnel candidate requiring settlement matching in that window.

Fresh Base Blockscout reconciliation initially returned HTTP 500 and was retried automatically. After bounded retry it returned the canonical USDC transfer set for the Treasury. Exactly one incoming canonical USDC transfer remains:

- tx: `0x5ae76f54c158d24f03b86aed0a20482e8de2a35983941c03fe60d131c19cd7b3`
- timestamp: `2026-09-07T05:42:03Z`
- from: `0x7E6b6556322c4e26c567a867964aC793f5eE2b1c`
- to: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`
- token: canonical Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

This is the already reconciled First Stranger Revenue. There is no second/new canonical USDC receipt in the fresh result. Cumulative recognized customer revenue therefore remains `0.03 USDC`, with previously reconciled variable cost `0.002163522555 USDC` and realized contribution margin `0.027836477445 USDC`.

## Other channel decisions this run

- **x402 List:** attractive agent-first directory with machine API and on-chain traction metrics, but its published rules require a one-off `$1` x402 payment for services hosted on free-compute domains such as `workers.dev`. No payment was made because DELTA's financial boundary prohibits autonomous listing/verification fees. Status: `fee_blocked`, not failed.
- **Agora402:** requires a paid starter/featured listing. No payment attempted. Status: `fee_blocked`.
- **PayAPI Market / Actionbook / Trouve / Browser Agent:** recent mail checked; no new human integration intent was present in this run. No additional outreach was sent.
- **Vauban / GitHub issue #16:** no new reply after DELTA asked for an exact Base-mainnet verifier path. No production compatibility claim is made until one is supplied and tested.
- **Sunra:** the previously used public outreach address bounced as non-existent/unreceivable. That address is retired; no retry to guessed/private addresses.

## Current cumulative strict accounting

- confirmed stranger buyers: `1`
- paid settlements: `1`
- treasury_received: `0.03 USDC`
- recognized customer revenue: `0.03 USDC`
- realized variable cost: `0.002163522555 USDC`
- realized contribution margin: `0.027836477445 USDC`
- Second Stranger Revenue: not yet observed
