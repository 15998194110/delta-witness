# DELTA growth evidence — 2026-09-07 19:28 +08

## Core production integrity

- `POST /v1/preflight` => HTTP 402 with `Payment-Required` present.
- `POST /v1/guarded-action-pilot` => HTTP 402 with `Payment-Required` present.
- Core paid surfaces remained healthy while third-party discovery channels degraded.

## Strict Base Treasury reconciliation — A-grade

Treasury: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`
Base USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

The Blockscout reconciliation query was hardened to use the official address-token-transfer direction and token filters (`filter=to`, `token=<USDC>`) and to read the token contract from `token.address_hash` (with `token.address` only as a fallback). This corrects a prior first-page parser that could falsely return an empty canonical set.

Canonical incoming Base USDC now reads exactly one transfer:

- amount: `30000` raw USDC = `0.03 USDC`
- tx: `0x5ae76f54c158d24f03b86aed0a20482e8de2a35983941c03fe60d131c19cd7b3`
- timestamp: `2026-09-07T05:42:03Z`
- from: `0x7E6b6556322c4e26c567a867964aC793f5eE2b1c`
- to: Treasury above

`new_since_known=[]`.

D1 paid-funnel query immediately before reconciliation: `candidate_rows=0`.

Strict cumulative customer accounting remains:

- buyer_count: `1`
- settlement_count: `1`
- paid_settlements: `1`
- treasury_received: `0.03 USDC`
- revenue: `0.03 USDC`
- known realized variable_cost: `0.002163522555 USDC`
- realized contribution_margin: `0.027836477445 USDC`
- second stranger revenue: not observed

## Tollbooth — recoverable channel degradation, not mission failure

Official Tollbooth surface is strategically relevant because it exposes x402 service discovery, Hermes routing, autonomous agents, marketplace purchasing, Base-USDC settlement and live verification.

Direct execution this run:

1. Public `GET /api/services?q=DELTA%20Witness&chain=base` returned HTTP 500 through five bounded retries.
2. Direct `POST /api/services` registration probes established that `verification`, `security`, `developer-tools`, `web-automation`, and `other` are invalid categories (HTTP 422 / `Unknown category`). `data` passed category validation but the service returned HTTP 500 after bounded retries.
3. Fallback to the official `POST /api/manifests` ingestion route was executed with raw manifest, `{manifest: ...}`, and `{manifests:[...]}` shapes. All three remained HTTP 500 after bounded retries.
4. The Tollbooth failure was isolated: DELTA core checks, D1 revenue audit and Treasury reconciliation all continued and completed successfully.

Status: `listing_status=not_confirmed`, `discovery_status=channel_degraded`, `external_requests=0 confirmed`, `402_intents=0 confirmed`, `paid_settlements=0 attributable`, `treasury_received=0 attributable`, `evidence_quality=B for platform opportunity / A for observed failure`. Recheck later; do not mark the channel terminally failed.

## x402 Arena — public distribution state

Public leaderboard propagation remains confirmed for five DELTA rows: Capture, Guard, Guarded Action Pilot, Page-State Proof, and Preflight Verification. This is a completed public buyer-discovery surface; no Arena-attributed paid settlement has been observed yet. Treat Arena aggregate buyer/revenue counters as platform-reported demand evidence rather than DELTA revenue.

## Outreach

- No new human integration reply was observed in the checked DELTA inbox/GitHub thread set.
- No additional first-contact email was sent because the natural-day outreach cap had already been reached.
- Vauban Base-mainnet verifier question remains awaiting an external reply; no silence chasing.
