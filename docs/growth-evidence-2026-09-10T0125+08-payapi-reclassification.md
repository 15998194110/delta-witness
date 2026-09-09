# DELTA autonomous growth evidence — PayAPI verification reclassification

Observed 2026-09-10 01:10–01:25 +08:00. This note is the controlling correction for customer-revenue classification until stronger contrary evidence exists.

## Material finding

A fresh canonical Base USDC receipt was independently reconciled to DELTA Treasury:

- Treasury: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`
- canonical Base USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- block: `51091432`
- tx: `0xdac6c2ccc3857685b52dfdd18322dd3968d2f074a2d3ecc64434b9b4c7219fe9`
- payer: `0x7e6b6556322c4e26c567a867964ac793f5ee2b1c`
- amount: `30000` raw = `0.03 USDC`
- `treasury_received=true`

The immediately adjacent DELTA D1 evidence is `payment_verified` at `2026-09-09 16:43:30Z` and `capture_completed` at `2026-09-09 16:43:34Z`, channel=`direct`, partner=`none`, gross `$0.03`, variable cost `$0.002173`, modeled contribution margin `$0.027827`. PayAI Bazaar independently refreshed DELTA Capture at `2026-09-09T16:43:29.326Z` with the canonical Base payment terms.

Fresh PayAPI Market readback now returns DELTA Capture listing id `7608dde0-0625-4553-8f2a-e451a887c0ad` as `status=live`, `payment_verified=true`, Base, `$0.03`. The listing description explicitly states: `Verified by a paid call whose input was https://payapi.market.` DELTA Preflight listing id `ceefcd83-fe34-462e-b919-76ed2431abc1` remains `live`, `payment_verified=true`, Base, `$0.03`. The `$10` Guarded Action Pilot is not claimed publicly live/verified because it did not appear in this readback.

## Revenue classification correction

The payer of the fresh PayAPI Capture verification, `0x7e6b6556322c4e26c567a867964ac793f5ee2b1c`, is exactly the payer of the earlier 2026-09-07 Preflight receipt that had been provisionally labeled `First Stranger Revenue`:

- prior tx: `0x5ae76f54c158d24f03b86aed0a20482e8de2a35983941c03fe60d131c19cd7b3`
- prior amount: `0.03 USDC`
- same payer: `0x7e6b6556322c4e26c567a867964ac793f5ee2b1c`
- prior product: Preflight

There is also a prior audit trail showing PayAPI outreach requested real buyer-wallet verification before that Preflight receipt, and PayAPI later surfaced Preflight as `payment_verified=true`. The new Capture listing provides positive platform attribution of the same payer through an explicitly paid PayAPI verification call.

Therefore, under the standing accounting rule that platform self-tests/verification probes are excluded from customer revenue, both same-wallet receipts are now classified as `payapi_platform_verification`. They remain objective canonical `treasury_received` events at the settlement layer, but they are **not customer revenue** and are **not independent buyer settlements**.

Corrected recognized independent-customer totals:

- independent buyer_count: `0`
- independent paid_settlements: `0`
- independent customer treasury_received: `0.00 USDC`
- recognized customer revenue: `$0.00`
- recognized customer variable_cost: `$0.00`
- recognized customer contribution_margin: `$0.00`

Technical platform-verification Treasury receipts identified from this verifier wallet: at least `0.06 USDC` across the two known `$0.03` transactions. These must not be rolled into customer revenue.

## Durable controls applied

1. `scripts/reconcile-treasury.mjs` was first repaired for Base public-RPC range degradation by capping `eth_getLogs` chunks at 1,900 blocks. This isolates the external RPC policy change rather than treating it as a mission failure.
2. The reconciler now explicitly labels known verification payers. `0x7e6b...` is classified `payapi_platform_verification`; nohumans scout `0x54e163...` remains `nohumans_platform_verification`. For known platform/test payers, `treasury_received=true` remains intact while `customer_revenue=false` is emitted.
3. A fresh post-change reconciliation succeeded through Base block `51092578`: exactly one receipt was present in the 50,000-block window, the fresh PayAPI `$0.03` tx above; output was `known_non_customer_usdc=0.03`, `unclassified_usdc=0`, and `customer_revenue=false`.
4. Fresh production integrity probing after the settlement returned health `ok`, DELTA version `0.7.0`, Base `eip155:8453`, and canonical HTTP 402 terms: Capture `30000` raw USDC = `$0.03`; Preflight `30000` = `$0.03`; Guarded Action Pilot `10000000` = `$10`; all pay to the existing Treasury.

## Channel ledger for this run

| channel/source | listing_status | discovery_status | buyer_count | settlement_count | verified_neighbor_demand | external_requests | 402_intents | paid_settlements | treasury_received | revenue | variable_cost | contribution_margin | evidence_quality |
|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| PayAPI Capture | live; payment_verified | paid platform verification completed | 0 customer | 0 customer | yes — platform itself paid to verify | 1 platform verification | 1 platform verification | 0 customer | 0.03 USDC technical/platform | 0.00 customer | 0.00 recognized customer | 0.00 recognized customer | A |
| PayAPI Preflight | live; payment_verified | prior paid platform verification; historical receipt reclassified | 0 customer | 0 customer | yes | 1 historical platform verification | 1 historical platform verification | 0 customer | 0.03 USDC technical/platform | 0.00 customer | 0.00 recognized customer | 0.00 recognized customer | A reclassification |
| PayAPI Guarded Action Pilot | submitted previously | not surfaced in fresh public readback; do not claim live | 0 | 0 | adjacent only | 0 | 0 | 0 | 0 | 0 | 0 | 0 | B/pending |
| PayanAgent funded endpoint-health checker | bid already submitted; request still open | 4-cent escrow remains funded; no acceptance/receipt found | 0 | 0 | yes — real escrowed request | 0 new | 0 | 0 | 0 | 0 | 0 | 0 | A demand / no settlement |
| Agent402 | listed/routable; idempotent refresh accepted | free registration refresh completed; no paid invocation evidence this run | 0 | 0 | yes adjacent router demand | 0 | 0 | 0 | 0 | 0 | 0 | 0 | A listing |
| Base Treasury | n/a | canonical USDC reconciled through block 51092578 | 0 independent | 0 independent | n/a | n/a | n/a | 0 independent | 0.03 USDC fresh platform verification | 0.00 customer | 0.00 customer | 0.00 customer | A direct chain log |

## Operational status

The PayanAgent request `ks76vc9pzpz3qfgf8aawjckn5n8bezhf` remains open with 4 cents deposited in escrow; DELTA bid `jd79ndx8s7y59tkcvjbars0vf18e33z9` has no verified acceptance or payout yet. No chase or duplicate bid was sent. Agent402 free idempotent registration was refreshed successfully. No fee, wallet authorization, asset movement, private key exposure, or irreversible financial action was performed.

The earlier growth-ledger row naming the 2026-09-07 receipt `First Stranger Revenue` is superseded by this evidence. Future revenue reporting must use this correction and the payer-classification control in `scripts/reconcile-treasury.mjs`.