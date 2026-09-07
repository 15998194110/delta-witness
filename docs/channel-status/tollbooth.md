# Tollbooth channel status

Observed: 2026-09-07T22:48+08:00

- channel/source: Tollbooth (`trytollbooth.com`)
- listing_status: unconfirmed / recoverable channel degradation
- discovery_status: official docs live; service APIs degraded during execution
- buyer_count: 0
- settlement_count: 0
- verified_neighbor_demand: yes — Tollbooth publicly reports live Base/x402 services and settled USDC activity; adjacent only, not DELTA revenue
- external_requests: 0 confirmed buyer requests
- 402_intents: 0 attributable buyer intents
- paid_settlements: 0 new
- treasury_received: 0 new
- revenue_usdc: 0 new
- variable_cost_usdc: 0 new
- contribution_margin_usdc: 0 new
- evidence_quality: A for DELTA core/Treasury state; A- for Tollbooth channel state

Execution evidence:

1. DELTA production health returned version `0.7.0`; Capture, Preflight and Guarded Action Pilot each returned valid HTTP 402 challenges with Base mainnet, canonical Base USDC, Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367`, and raw amounts `30000`, `30000`, `10000000`.
2. First direct Tollbooth registrations used an unsupported category and correctly returned HTTP 422 `Unknown category`; this was treated as actionable validation feedback, not terminal failure.
3. Retried with Tollbooth's documented `ai-inference` category. Each `POST /api/services` was retried with bounded backoff and returned HTTP 500. `GET /api/services`, exact `GET /api/services/:slug`, array `POST /api/manifests`, and single-manifest `POST /api/manifests` were also retried/fallback-tested and returned HTTP 500. This isolates the condition as a Tollbooth service-API degradation rather than a DELTA production failure.
4. Base Blockscout returned repeated HTTP 503 during the first Treasury reconciliation, so reconciliation automatically fell back to the public Base JSON-RPC. USDC `Transfer` logs from the First Stranger Revenue block through current head returned exactly one incoming transfer to the Treasury: the already-known tx `0x5ae76f54c158d24f03b86aed0a20482e8de2a35983941c03fe60d131c19cd7b3`, amount raw `30000` = `0.03 USDC`. No later incoming canonical Base USDC was present.
5. DELTA D1 telemetry from 2026-09-07 13:30Z through the run contained unpaid `payment_required`, quote/page/proof events but no new `payment_verified` or `capture_completed`; therefore no new customer settlement is recognized.

Operational disposition: deferred recheck on the normal growth cycle. Do not escalate unless the Tollbooth API remains degraded across later runs and materially blocks revenue. Do not count Tollbooth probes or any future platform-funded verification payment as customer revenue.
