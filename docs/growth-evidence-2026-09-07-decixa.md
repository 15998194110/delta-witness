# DELTA growth evidence — Decixa — 2026-09-07

## Channel state

| field | value |
|---|---|
| channel/source | Decixa |
| listing_status | indexed — 3 production endpoints accepted by official publish API |
| discovery_status | public listing URLs return HTTP 200; unauthenticated machine `detail` / `discover` readback is access-gated with HTTP 403 and an instruction to request API-key access, so agent-API discovery readback is not claimed |
| buyer_count | 0 Decixa-attributed |
| settlement_count | 0 Decixa-attributed |
| external_requests | 0 attributed |
| 402_intents | 0 attributed |
| paid_settlements | 0 attributed |
| treasury_received | 0 incremental USDC |
| revenue | 0 incremental USDC |
| variable_cost | 0 incremental USDC |
| contribution_margin | 0 incremental USDC |
| evidence_quality | A for official external probe + publish response; discovery API readback remains access-gated |

## Authoritative submission evidence

Decixa's official `POST /api/submit/verify` independently probed all three production endpoints and returned `ok=true`, `total=3`, `verified=3`, `failed=0`. Each endpoint returned HTTP 402 with schema completeness `1` and exact production settlement terms:

- Capture — Base `eip155:8453`, canonical Base USDC, `30000` raw units = 0.03 USDC, exact Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367`.
- Preflight — Base `eip155:8453`, canonical Base USDC, `30000` raw units = 0.03 USDC, exact Treasury.
- Guarded Action Pilot — Base `eip155:8453`, canonical Base USDC, `10000000` raw units = 10 USDC, exact Treasury.

The subsequent official `POST /api/submit/publish` returned HTTP 201 with `ok=true`, provider id `b0be99e9-e8e8-49d6-85de-506fd1696a81`, and message `3 endpoint(s) indexed, 0 already indexed`.

Created API listings:

- Capture: id `78ea3d38-da37-4521-95f8-0338207f6e1f` — `https://decixa.ai/apis/78ea3d38-da37-4521-95f8-0338207f6e1f`
- Preflight: id `a2f4d378-1faf-4635-b7f8-f5e04cba27c6` — `https://decixa.ai/apis/a2f4d378-1faf-4635-b7f8-f5e04cba27c6`
- Guarded Action Pilot: id `79864d2f-f1de-41e7-8ab3-137e0590346e` — `https://decixa.ai/apis/79864d2f-f1de-41e7-8ab3-137e0590346e`

All three public listing URLs returned HTTP 200 in fallback readback. Decixa's unauthenticated `/api/agent/detail/{id}` and `/api/agent/discover` calls returned HTTP 403 with `Automated bulk access is not allowed. Contact partnerships@decixa.ai for API key access.` This is isolated as an access-gated discovery API, not treated as a failed listing.

## Independent DELTA / Treasury reconciliation from the same run

Before listing work continued, external production checks confirmed `/health` was `ok` on version `0.7.0`, `/v1/preflight` returned the expected HTTP 402, and `/v1/guarded-action-pilot` returned the expected HTTP 402.

A strict canonical Base USDC query for Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367` returned only the already-confirmed First Stranger Revenue transfer: tx `0x5ae76f54c158d24f03b86aed0a20482e8de2a35983941c03fe60d131c19cd7b3`, payer `0x7E6b6556322c4e26c567a867964aC793f5eE2b1c`, amount `30000` raw USDC = 0.03 USDC. No second canonical incoming customer USDC was present. The D1 paid-funnel audit for the preceding two hours returned no `payment_verified`, `capture_started`, `capture_completed`, or `capture_failed` rows.

Therefore cumulative strict customer-revenue state remains: buyer_count 1, settlement_count 1, paid_settlements 1, treasury_received/revenue 0.03 USDC, variable_cost 0.002163522555 USDC, contribution_margin 0.027836477445 USDC. Decixa verification/listing probes are excluded from buyer intent, settlement, and revenue.

## Failure isolation note

One hosted workflow was marked failed only because the script asserted HTTP 200 after Decixa's successful publish returned HTTP 201. The response body itself was authoritative success (`ok=true`, three new indexed endpoints). A separate fallback readback then completed successfully and confirmed all three public listing URLs returned HTTP 200. The access-gated Decixa machine APIs remain a deferred channel recheck / partnership-API path and do not block Treasury reconciliation or other channels.
