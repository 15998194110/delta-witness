# DELTA Growth Evidence — 2026-09-11 05:03 +08

## Pricing / production gate

- Owner pricing policy: `owner-2026-09-10-1-5-10`.
- Live no-payment readback immediately before x402mpp listing write:
  - Public Capture: HTTP 402, `1 USDC`, raw `1000000`.
  - Public Preflight: HTTP 402, `5 USDC`, raw `5000000`.
  - Guarded-Action Pilot: HTTP 402, `10 USDC`, raw `10000000`.
- Network: Base `eip155:8453`.
- Canonical USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- Pay-to Treasury: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`.
- Header/body price match: true for all three public products.

## Channel evidence matrix

| channel/source | listing_status | discovery_status | buyer_count | settlement_count | verified_neighbor_demand | external_requests | 402_intents | paid_settlements | treasury_received | revenue | variable_cost | contribution_margin | evidence_quality |
| --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| MCPRepository | `live` | public canonical page HTTP 200 | 0 | 0 | not used as buyer evidence | 0 | 0 | 0 | 0 | $0 | $0 | $0 | A — direct public page readback after accepted official CLI submission |
| x402mpp | `queued` | not yet visible in public machine index at 2026-09-10T21:02:46Z | 0 | 0 | not yet evaluated | 0 | 0 | 0 | 0 | $0 | $0 | $0 | A for submission receipt / pending for public discovery |
| Base Treasury | n/a | canonical USDC logs scanned | 0 | 0 | n/a | 0 | 0 | 0 | 0 | $0 | $0 | $0 | A — direct canonical USDC logs |

## Completed distribution action — MCPRepository

- Official no-account CLI path executed: `npx -y mcp-index https://github.com/15998194110/delta-witness`.
- Submission run: `https://github.com/15998194110/delta-witness/actions/runs/34529089802`.
- Submission returned success and queued the canonical repository for validation.
- Fresh public readback at `2026-09-10T21:02:48Z` returned HTTP `200` for `https://mcprepository.com/15998194110/delta-witness`.
- Public page title: `DELTA Witness v0.7 - MCP Server`.
- Public description: `DELTA Witness v0.7 MCP Server: delta-witness`.
- Canonical source identifier visible on page: `15998194110/delta-witness`.
- Classification: completed high-value listing; no duplicate seller identity created.

## New x402 discovery action — x402mpp

- Official site implementation exposes `POST https://api.x402mpp.sh/submit` with JSON `{url, company}` and describes success as queueing the URL for the next discovery cycle.
- Pre-write public machine-index dedupe found `0` existing matches for the canonical DELTA host.
- Submitted canonical manifest: `https://delta-witness-api.ruphussten.workers.dev/.well-known/x402`.
- Receipt: HTTP `202`, `status=queued`, submission id `sub-b800f7e62c9ae5ae958f1c1b`.
- Submission run: `https://github.com/15998194110/delta-witness/actions/runs/34529726347`.
- Fresh public index readback at `2026-09-10T21:02:46Z` still found `0` DELTA matches; therefore status remains `queued`, not live/verified.
- No repeat submission was made.

## Treasury reconciliation

Fresh independent reconciliation completed at `2026-09-10T20:57:04.931Z` over Base blocks `51092237–51142236` (50,000-block lookback):

- `treasury_received_candidates = 0`
- `total_usdc = 0`
- `known_non_customer_usdc = 0`
- `unclassified_usdc = 0`
- `transfers = []`
- evidence quality: `A_direct_canonical_USDC_log`

The historical PayAPI platform-verification receipt is outside this current lookback window. There is no customer receipt or unclassified receipt in the freshly scanned window.

## Outreach / buyer state

- Recent DELTA-related inbound mail was checked; no new explicit-interest reply was found in this run.
- No new outreach was sent in this run.
- No funded compatible buyer request passed the required payment/escrow evidence threshold in this run.

## Operational hygiene

- One-shot MCPRepository submission workflow retired after success.
- One-shot x402mpp submission workflow retired after receipt.
- One-shot Treasury retry workflow retired after successful canonical-script reconciliation.
- One-shot distribution visibility workflow retired after readback.
- No duplicate listing write or duplicate seller identity created.
