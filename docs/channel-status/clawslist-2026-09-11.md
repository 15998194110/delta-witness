# ClawsList distribution — 2026-09-11

Status: **live external machine-commerce distribution; no customer revenue yet**.

## What changed

The first one-shot used the superseded `clawslist.net` API and failed on a public-read HTTP 503 before any identity or listing was created. The retry was repaired against the current `https://clawslist.dev/api` contract and completed successfully without cash spend, wallet signature, paid canary, or pricing change.

Before the external write, `scripts/check-owner-pricing.mjs` and `scripts/verify-owner-pricing-live.mjs` passed. Live public challenges were independently verified at the current owner-authorized ladder: Capture **1 USDC**, Public Preflight **5 USDC**, Guarded-Action Pilot **10 USDC**, Base `eip155:8453`, canonical Base USDC, unchanged Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367`.

## External write and readback

ClawsList agent registration returned HTTP 201:

- agent id: `dqn8GxFmpfCuSxy7bjrvb`
- name: `DELTA Witness`
- status: `active`

Three `api-access` listings were created and then read back through the authenticated ClawsList API as active, with direct DELTA endpoints and machine-payment metadata:

| Product | Listing id | Price | Endpoint |
|---|---|---:|---|
| Capture | `PIy3TKBL8_VM0J_y1L7By` | 1 USDC | `POST https://delta-witness-api.ruphussten.workers.dev/v1/capture` |
| Public Preflight | `ShSptZQ5ogohZrJfmLZ2e` | 5 USDC | `POST https://delta-witness-api.ruphussten.workers.dev/v1/preflight` |
| Guarded-Action Pilot | `JgvxR2SiW5mQ2E9v0uxzb` | 10 USDC | `POST https://delta-witness-api.ruphussten.workers.dev/v1/guarded-action-pilot` |

Each listing read back with `category=api-access`, `status=active`, `mpp_price_currency=usdc`, and its exact current price in `mpp_price_amount`. The `mpp_endpoint` is the corresponding live DELTA x402 endpoint. This uses the published MPP/x402 compatibility property: MPP clients can consume existing x402 services without requiring a DELTA protocol rewrite.

The new ClawsList API key was never printed. It was encrypted with the existing operator encryption secret and preserved as GitHub Actions artifact `10263292005` from run `34598412601`, together with the agent id. No plaintext credential was committed.

## Revenue reconciliation

The same completed run independently scanned canonical Base USDC Transfer logs for the DELTA Treasury through block `51169945` (50,000-block lookback):

- `treasury_received_candidates = 0`
- `total_usdc = 0`
- `unclassified_usdc = 0`
- `transfers = []`

Therefore this channel currently contributes **distribution only**:

- external paid customer settlements attributable to ClawsList: `0`
- `treasury_received`: `0 USDC`
- customer revenue: `0 USDC`
- recognized contribution margin: `0`

Listing creation/readback is not a buyer request, authorization, settlement, or receipt. Future ClawsList traffic must still reconcile `payment_required → payment_verified → fulfillment/proof → canonical Treasury receipt` before customer revenue is recognized.

Execution commit: `3dd51276cd4cd52372fa9a523faf4525e0f8cddf`. The temporary one-shot workflow was removed after successful completion in cleanup commit `fa485517c8073abf81d1427a628303e739875db3`.
