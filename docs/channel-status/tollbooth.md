# Tollbooth channel status

Observed: 2026-09-09T00:07+08:00

- channel/source: Tollbooth (`trytollbooth.com`)
- listing_status: unconfirmed / recoverable channel degradation
- discovery_status: official docs and marketplace surface live; service registry API still degraded
- buyer_count: 0 attributable DELTA buyers from this channel
- settlement_count: 0 attributable DELTA settlements from this channel
- verified_neighbor_demand: yes — Tollbooth publicly reports live Base/x402 services and settled USDC activity; adjacent only, not DELTA revenue
- external_requests: 0 confirmed buyer requests
- 402_intents: 0 attributable buyer intents
- paid_settlements: 0 new
- treasury_received: 0 new after block 51040989 through Blockscout head 51047132
- revenue_usdc: 0 new
- variable_cost_usdc: 0 new realized amount established in this run
- contribution_margin_usdc: 0 new realized amount established in this run
- evidence_quality: A for DELTA D1 paid-funnel absence; A- for Blockscout Treasury reconciliation; A- for Tollbooth channel degradation

Current pricing authority is the repository `AGENTS.md` plus `docs/preflight-price-experiment-2026-09-08.md`: public Capture 0.03 USDC, public Preflight 1 USDC, Guarded Action Pilot 10 USDC, existing authenticated Partner Preflight and Watch base 0.03 USDC. Do not reuse the older public-Preflight 0.03 standing mandate.

## 2026-09-09 recovery recheck

1. Re-read Tollbooth's current official documentation before execution. It still documents unauthenticated `POST /api/services` registration, live x402 verification, and direct USDC settlement to the listed wallet. Its public marketplace surface was reachable and reported live activity. No listing/sign-up fee or wallet authorization was used.
2. A bounded recovery run first attempted `GET /api/services?q=DELTA%20Witness` to avoid duplicates. The request returned HTTP 500 on all four attempts with exponential backoff.
3. Because readback was unavailable, the run attempted the three authorized production services independently using the documented `ai-inference` category accepted in the prior validation path: Capture 0.03, Preflight 1, and Guarded Action Pilot 10, all paying to Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367`. Every `POST /api/services` returned HTTP 500 on all four attempts. Final exact readback also returned HTTP 500 on all four attempts.
4. This reproduces the earlier Tollbooth service-registry degradation across a later run while Tollbooth's documentation and public frontend remain reachable. It is still isolated as a third-party registry API failure, not a DELTA core production failure. No duplicate listing is claimed because no successful service response or readback exists.
5. DELTA D1 paid-funnel reconciliation completed independently and returned `candidate_rows=0` for the checked two-hour window: no `payment_verified`, partner request, paid capture completion, or Watch candidate requiring revenue classification.
6. Direct public Base JSON-RPC endpoints returned HTTP 403 from the GitHub runner despite retries across `mainnet.base.org`, PublicNode, and LlamaRPC. This was treated as a recoverable channel restriction rather than a failed Treasury mission.
7. Treasury reconciliation immediately fell back to Base Blockscout. Both the legacy token-transfer endpoint and v2 token-transfer endpoint returned HTTP 200. The legacy query found no canonical Base USDC transfer to Treasury from block 51040990 onward; Blockscout's current block endpoint reported head 51047132. Therefore there is no new canonical Base USDC Treasury receipt in 51040990-51047132.
8. Temporary execution workflows were removed after evidence collection. No listing fee, paid canary, wallet signature, asset movement, self-payment, or automatic reinvestment occurred.

Operational disposition: continue deferred recheck on the normal growth cycle. Tollbooth failures remain recoverable, but repeated 500s mean this channel should not displace working discovery surfaces until its registry API becomes responsive. Any future Tollbooth-funded verification payment must be classified as a platform test and excluded from customer revenue unless independent buyer evidence proves otherwise.

Historical note: the earlier 2026-09-07 recheck also produced repeat HTTP 500 responses after category validation. Its Treasury fallback found only the already-known 0.03 USDC receipt. That historical receipt remains unclassified as realized sprint net until independent payer/proof and actual fee/refund/liability evidence are complete.