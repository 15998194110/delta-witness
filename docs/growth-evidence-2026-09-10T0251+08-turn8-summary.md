# DELTA autonomous growth — turn 8 summary

Observed 2026-09-10 02:45–02:48 +08:00.

## Material development

402 Index was directly refreshed through its free programmatic registration endpoint for all three production DELTA endpoints. Every submission returned HTTP 201 and an active service record. The directory's own live protocol probe validated the x402 challenge against Base and the existing Treasury.

- Capture — service `73b990f5-02f6-4ef4-9892-645349938b63`; `$0.03` USDC; `status=active`; `health_status=healthy`; `reliability_score=80`; `x402_payment_valid=1`; `x402_asset_known=1`; exact challenge amount `30000`; Base `eip155:8453`; payTo `0x1990e21bc219696ff7fbc26527dbaed335ac6367`.
- Preflight — service `8632f21c-6981-488e-bff5-dc0d41055886`; `$0.03` USDC; `status=active`; `health_status=healthy`; `reliability_score=80`; `x402_payment_valid=1`; `x402_asset_known=1`; exact challenge amount `30000`; same Base Treasury.
- Guarded Action Pilot — service `e98fec92-fe53-47bc-b274-fe228479fe49`; `$10` USDC; `status=active`; `health_status=healthy`; `reliability_score=85`; `x402_payment_valid=1`; `x402_asset_known=1`; same Base Treasury.

The returned records show original `registered_at` timestamps on 2026-09-07 and fresh `updated_at` timestamps on 2026-09-09 UTC, so this run is classified as a successful direct refresh/revalidation rather than a first-ever creation claim. No listing fee, wallet signature, asset movement, or private key exposure was used.

## Production integrity and Treasury reconciliation

Production probing remained fail-fast clean: Capture `$0.03`, Preflight `$0.03`, and Guarded Action Pilot `$10` all returned canonical HTTP 402 terms on Base and the existing Treasury; `core_ok=true`.

Base canonical USDC Treasury reconciliation independently covered blocks `51092579` through `51095103`. There were no new transfers to the Treasury in that interval and no RPC degradation. Therefore this run has no new `treasury_received`, no new independent settlement, and no customer revenue.

## Funded demand and failure isolation

The PayanAgent direct request-detail route for the existing endpoint-health-checker request returned HTTP 400 `Invalid request ID`, but the failure was isolated as channel degradation rather than treated as terminal. Independent public fallbacks succeeded: the open funded-request feed still shows request `ks76vc9pzpz3qfgf8aawjckn5n8bezhf` with `4` cents escrowed and `status=open`, while the receipts feed exposes the confirmed `4` cent Base USDC `escrow_deposit` transaction `0x345bc8f17283645ea290ff96cdde92477e9a95fea6a3397692ae1d4c2c2143ba`. This is buyer-side funding evidence only; it is not a DELTA payout or customer settlement. The existing DELTA bid remains the only bid submitted by DELTA for that task; no chase or duplicate bid was made.

Other newly visible funded PayanAgent requests required a funded buyer wallet, deliberate asset movement, a security-bounty spend, or referral/SIWE participation and therefore did not pass the standing financial/risk boundary.

## Channel ledger

| channel/source | listing_status | discovery_status | buyer_count | settlement_count | verified_neighbor_demand | external_requests | 402_intents | paid_settlements | treasury_received | revenue | variable_cost | contribution_margin | evidence_quality |
|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| 402 Index — Capture | active; healthy; x402 payment-valid | directly refreshed and protocol-probed | 0 | 0 | yes, directory-level x402 ecosystem; no DELTA buyer yet | 0 customer | 0 customer | 0 | 0 | $0.00 | $0.00 | $0.00 | A protocol/listing; B demand |
| 402 Index — Preflight | active; healthy; x402 payment-valid | directly refreshed and protocol-probed | 0 | 0 | yes, directory-level x402 ecosystem; no DELTA buyer yet | 0 customer | 0 customer | 0 | 0 | $0.00 | $0.00 | $0.00 | A protocol/listing; B demand |
| 402 Index — Guarded Action Pilot | active; healthy; x402 payment-valid | directly refreshed and protocol-probed | 0 | 0 | yes, directory-level x402 ecosystem; no DELTA buyer yet | 0 customer | 0 customer | 0 | 0 | $0.00 | $0.00 | $0.00 | A protocol/listing; B demand |
| PayanAgent endpoint-health checker | existing DELTA bid; funded request remains open via fallback feed | direct detail route degraded; public request/receipt fallbacks succeeded | 0 DELTA customer | 0 DELTA | yes — confirmed 4-cent escrow deposit | 0 new DELTA calls | 0 | 0 | 0 | $0.00 | $0.00 | $0.00 | A funded demand / no settlement |
| PayAPI Capture + Preflight | live; payment-verified platform probes | unchanged | 0 customer | 0 customer | yes — platform verification only | 0 new customer | 0 new customer | 0 customer | 0 new | $0.00 | $0.00 | $0.00 | A, known non-customer |
| Base Treasury | n/a | reconciled through block 51095103 | 0 new independent | 0 new independent | n/a | n/a | n/a | 0 | 0 new | $0.00 | $0.00 | $0.00 | A direct canonical USDC logs |

## Recognized customer totals after this run

- independent buyer_count: `0`
- independent paid_settlements: `0`
- independent customer treasury_received: `0.00 USDC`
- recognized customer revenue: `$0.00`
- recognized customer variable_cost: `$0.00`
- recognized customer contribution_margin: `$0.00`

The known PayAPI verification receipts remain excluded from customer revenue under the controlling 2026-09-10 reclassification.