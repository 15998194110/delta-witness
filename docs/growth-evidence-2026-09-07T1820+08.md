# DELTA growth evidence — 2026-09-07 18:20 +08

This snapshot is deliberately conservative. Platform reach, crawler probes and self-reported marketplace metrics are not DELTA buyer count or customer revenue.

## Strict revenue reconciliation

- Production checks on `POST /v1/preflight` and `POST /v1/guarded-action-pilot` still returned HTTP `402` with `Payment-Required`.
- Fresh D1 paid-funnel audit returned `candidate_rows=0`; there is no new `payment_verified` candidate to promote into a settlement claim.
- Base Blockscout returned HTTP `500` four times during the Treasury read, then recovered under bounded retry. The successful canonical ERC-20 read still contains only the already-confirmed first stranger USDC receipt:
  - tx: `0x5ae76f54c158d24f03b86aed0a20482e8de2a35983941c03fe60d131c19cd7b3`
  - from: `0x7E6b6556322c4e26c567a867964aC793f5eE2b1c`
  - to: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`
  - timestamp: `2026-09-07T05:42:03Z`
  - amount: `0.03 USDC` from the previously reconciled DELTA Preflight settlement.
- No additional canonical incoming Base USDC was found.

Current strict cumulative customer economics therefore remain:

| metric | value |
|---|---:|
| buyer_count | 1 |
| settlement_count | 1 |
| paid_settlements | 1 |
| treasury_received | 0.03 USDC |
| revenue | 0.03 USDC |
| variable_cost | 0.002163522555 USDC |
| contribution_margin | 0.027836477445 USDC |

For this run specifically: no new `value_authored` paid fulfillment, no new `payment_authorized`, no new `settlement_confirmed`, and no new `treasury_received`.

## x402 Arena discovery and direct registration

A fresh scan found DELTA already publicly present on x402 Arena under five rows: `delta-witness-capture`, `delta-witness-guard`, `delta-witness-guarded-action-pilot`, `delta-witness-page-state-proof`, and `delta-witness-preflight-verification`. Their public DELTA rows showed no Arena-attributed revenue, queries or buyers at observation time.

The official free registration endpoint was exercised directly rather than left as a note:

- `delta-witness-preflight` was independently re-probed as a valid x402 endpoint and `POST https://core.x402arena.gg/register` returned HTTP `201` with `status=active`, `verified=true`, endpoint `/v1/preflight`, `pricing=0.03 USDC`, `network=eip155:8453`, correct Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367`, and `bazaarCompatible=true`.
- Attempts to register the canonical `delta-witness-capture` and `delta-witness-guarded-action-pilot` names returned HTTP `409 Agent name already taken` after bounded retries. Because those names were already visible in the public Arena, this is classified as existing-registration confirmation rather than channel failure.
- Immediate operator-API readback did not yet expose the newly created Preflight alias, so propagation is still pending. No incremental buyer demand is claimed.

Evidence-quality caveat: x402 Arena's own public documentation says marketplace revenue events are currently self-reported through its events endpoint and that on-chain verification is still forthcoming. Therefore its aggregate marketplace buyer/revenue counters are not accepted as A-grade verified neighboring paid demand. DELTA-attributable Arena metrics remain `buyer_count=0`, `settlement_count=0`, `external_requests=0`, `402_intents=0`, `paid_settlements=0`, `treasury_received=0`, `revenue=0` until independent settlement/Treasury evidence appears.

## Outreach and integration checks

- PayAPI Market: the already-sent personalized first contact to its official business channel has no human reply yet. No duplicate follow-up was sent.
- Vauban / GitHub issue #16: no new human reply after the Base-mainnet verifier question. No chase was sent.

## Newly verified opportunity state

- PayAPI Market remains a high-priority settlement-verification surface because its public process says verification uses a real paid call, listings are free, and providers keep 100%. Existing outreach is pending, so no duplicate contact was made.
- 24K Labs Gold-402 is a free curated x402 directory whose official contribution path is a pull request. No pay-to-list requirement was found. Direct PR execution is deferred until an authorized external-repository write/fork path is available; this is a deferred channel, not a failed mission.

Temporary GitHub Actions instrumentation used for the Arena registration/readback was removed after evidence capture; no temporary growth workflow remains in the repository.
