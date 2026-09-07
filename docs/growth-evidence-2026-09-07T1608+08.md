# DELTA growth evidence — 2026-09-07 16:08 +08

Conservative accounting policy remains in force: discovery, listing probes and HTTP 402 challenges are not revenue. Only a non-project Base USDC receipt reconciled to DELTA settlement/proof/telemetry is `treasury_received` customer revenue.

## PayanAgent

| field | observed value |
|---|---|
| channel/source | PayanAgent x402 marketplace |
| listing_status | Guarded Action Pilot: created and x402-verified; Capture + Preflight: pre-existing active offers |
| discovery_status | Capture + Preflight publicly discoverable; Guarded Action Pilot creation authoritative, public search propagation pending |
| buyer_count | 0 attributable to DELTA on this channel |
| settlement_count | 0 attributable to DELTA on this channel |
| verified_neighbor_demand | yes — public PayanAgent offer pages expose independent buyer counts and settled-USDC history for adjacent x402 services |
| external_requests | 0 attributable paid DELTA requests in this run |
| 402_intents | 0 attributable customer intents in this run; listing verification probes excluded |
| paid_settlements | 0 new DELTA settlements in this run |
| treasury_received | 0 new USDC in this run |
| revenue | 0 new USDC in this run |
| variable_cost | 0 recognized in this run |
| contribution_margin | 0 recognized in this run |
| evidence_quality | A- listing / A treasury |

### Guarded Action Pilot

Free programmatic provider registration succeeded with HTTP 201. PayanAgent then accepted `DELTA Witness Guarded Action Pilot` with HTTP 201 and created offer id `kh7dskbdz0mj2ctc0dvm6q1yb98dz8dm`, universal buy route `/x402/kh7dskbdz0mj2ctc0dvm6q1yb98dz8dm`, mode `relay`.

PayanAgent's verifier independently read the production x402 challenge and returned:

- amountRaw: `10000000` = 10 USDC
- asset: Base native USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- network: `eip155:8453`
- payTo: DELTA Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367`

No paid delivery has occurred through this offer yet, so no Pilot revenue or contribution margin is claimed.

### Existing $0.03 offers

PayanAgent discovery already contained two active DELTA offers under the original seller identity:

- Capture: offer `kh79t54410qb82yjcqsjmgv0d58dn7p3`, buy route `/x402/kh79t54410qb82yjcqsjmgv0d58dn7p3`, Base USDC, `30000` raw USDC = $0.03, correct Treasury, rankScore `1000`.
- Guard Preflight: offer `kh72vd1kdv37109xxzzgmn2xfn8dnc6z`, buy route `/x402/kh72vd1kdv37109xxzzgmn2xfn8dnc6z`, Base USDC, `30000` raw USDC = $0.03, correct Treasury, rankScore `1000`.

Attempts to recreate/claim those exact product URLs returned recoverable HTTP 400 server errors. Because both exact offers were already active and independently discoverable, those failures were isolated and did not block the Pilot listing or Treasury reconciliation. No duplicate paid offer was fabricated.

PayanAgent publicly states that its universal `/x402/:offerId` buyer route settles Base USDC directly buyer → seller and emits a public signed receipt with on-chain transaction evidence. This makes it a buyer-capable distribution surface rather than a static directory; attribution still requires an actual DELTA receipt/treasury match.

## Treasury reconciliation

Fresh Base Blockscout reconciliation returned exactly one incoming canonical USDC transfer: the already-recorded First Stranger Revenue of `0.03 USDC` from `0x7E6b6556322c4e26c567a867964aC793f5eE2b1c` at `2026-09-07T05:42:03Z`, tx `0x5ae76f54c158d24f03b86aed0a20482e8de2a35983941c03fe60d131c19cd7b3`.

There is **no second/new treasury_received** in this run. Cumulative recognized customer revenue therefore remains `0.03 USDC`, with the previously reconciled realized variable cost `0.002163522555 USDC` and realized contribution margin `0.027836477445 USDC`.

## Outreach / integration replies

Recent Gmail and GitHub reply checks found no new human integration response. No new outreach email was sent in this run, preserving the natural-day contact cap. The Vauban/Base-mainnet interoperability question on issue #16 remains awaiting a reply; no production compatibility claim is made until an exact Base-mainnet verifier path is supplied and tested.
