# DELTA Autonomous Growth Evidence — 2026-09-10 13:40 +08 (corrected)

## Executive result

This run produced one new completed discovery listing and one material production-integrity correction:

1. DELTA Witness was submitted directly to Not Human Search through its free public API and was crawled/indexed successfully.
2. A final owner-authority check detected that Public Preflight had drifted to `$0.03` even though the latest `AGENTS.md`, the September 8 owner approval, and the owner's later explicit instruction require **Public Preflight = `$1.00`**. The drift was corrected, regression-locked, fully verified, deployed, and live-checked.

No listing fee, account fee, wallet signature, asset movement, paid canary, or irreversible commitment was used. Customer-revenue status did not change.

## Current authoritative pricing

The current owner authority is:

| Product | Authorized price |
|---|---:|
| Public Capture | `$0.03` |
| Public Preflight | **`$1.00`** |
| Guarded Action Pilot | `$10.00` |
| Existing authenticated Partner Preflight floor | `$0.03` |
| Watch check base price | `$0.03` |

Older automation text or external cached listings that say Public Preflight `$0.03` are stale and must not override this authority.

## Production Preflight drift — detection and correction

A fail-fast production check observed:

- Capture: HTTP `402`, `30000` raw USDC — correct.
- Public Preflight: HTTP `402`, **`30000` raw USDC** — incorrect against owner authority; expected `1000000`.

Root cause evidence in the repository showed `wrangler.jsonc` had been rolled back to `PREFLIGHT_BASE_PRICE_USD: "0.03"`, while the payment hard-gate regression already expected Public Preflight `1000000` raw. `tests/pricing.test.ts` also contained one stale config assertion expecting `$0.03`.

Correction executed:

- `wrangler.jsonc`: Public Preflight restored from `0.03` to `1`.
- `tests/pricing.test.ts`: owner-approved config regression restored to `PREFLIGHT_BASE_PRICE_USD: "1"`.
- First verification correctly failed before deployment because the stale pricing assertion remained; deployment was skipped.
- After correcting that assertion, the full core suite passed: **55/55 tests**, TypeScript check, generated Wrangler types, and Worker dry-run/build.
- Corrected Worker deployed successfully.
- Production Worker version: `492dad9c-88b9-4b27-a264-698fa5f0c717`.

Post-deploy live verification:

| Product | HTTP | Raw Base USDC amount | Price | Network | Pay-to |
|---|---:|---:|---:|---|---|
| Capture | 402 | `30000` | `$0.03` | `eip155:8453` | `0x1990e21bc219696ff7fbc26527dbaed335ac6367` |
| Public Preflight | 402 | **`1000000`** | **`$1.00`** | `eip155:8453` | `0x1990e21bc219696ff7fbc26527dbaed335ac6367` |
| Guarded Action Pilot | 402 | `10000000` | `$10.00` | `eip155:8453` | `0x1990e21bc219696ff7fbc26527dbaed335ac6367` |

`/.well-known/agent.json` and `/openapi.json` also remained live after deployment.

This supersedes the earlier incorrect statement in this document that the observed `$0.03` Public Preflight was healthy. It was production drift, not the current standing mandate.

## Treasury reconciliation — continuous and independent

Treasury: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`  
Network: Base (`eip155:8453`)  
Canonical USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

The initial long direct-RPC sweep successfully scanned through Base block `51,112,524` before the Base public RPC began returning HTTP 429; PublicNode required a personal archive token and LlamaRPC was blocked by a challenge. These provider failures were isolated as external channel degradation and did not invalidate the production correction.

A bounded small-window continuity sweep then succeeded directly through Base official RPC:

- start block: `51,111,595`
- latest block: `51,115,094`
- overlap with prior successful direct scan: yes (`51,111,595` through `51,112,524`)
- new canonical USDC Treasury transfers in this continuity window: **0**
- `unclassified_usdc`: `$0.00`
- evidence quality: **A — direct canonical USDC logs**

The overlap means there is no gap between the long scan and the final continuity scan.

An independent Blockscout Base v2 token-transfer fallback returned exactly two canonical USDC incoming transfers currently visible for the Treasury:

1. tx `0x5ae76f54c158d24f03b86aed0a20482e8de2a35983941c03fe60d131c19cd7b3`, block `50,985,188`, `30000` raw = `$0.03`.
2. tx `0xdac6c2ccc3857685b52dfdd18322dd3968d2f074a2d3ecc64434b9b4c7219fe9`, block `51,091,432`, `30000` raw = `$0.03`.

Both are from `0x7e6b6556322c4e26c567a867964ac793f5ee2b1c`, the independently classified PayAPI platform-verification payer. They remain real `treasury_received` technical settlements but are explicitly excluded from customer revenue.

D1 paid-funnel audit after the correction returned:

- `candidate_rows=0`
- no new customer `payment_verified`
- no new attributable paid delivery

Therefore:

- new independent-customer `payment_authorized`: **0**
- new independent-customer `settlement_confirmed`: **0**
- new independent-customer `treasury_received`: **`$0.00`**
- new customer revenue: **`$0.00`**

## Not Human Search — completed live indexing

Direct execution used:

`POST https://nothumansearch.ai/api/v1/submit`

with DELTA's production origin. The submission returned HTTP `201` and `submitted for crawling`. The immediate readback returned 404 while propagation occurred; a bounded retry then returned the live record.

Current official readback:

- HTTP: `200`
- site id: `73c78905-1b05-4e57-8975-d01717a21f69`
- domain: `delta-witness-api.ruphussten.workers.dev`
- name: `DELTA Witness — Trust Layer for Autonomous Actions`
- `agentic_score=65`
- `crawl_status=success`
- `has_llms_txt=true`
- `has_openapi=true`
- `has_structured_api=true`
- `has_schema_org=true`
- last crawled: `2026-09-10T05:39:42.198345Z`
- listing/discovery evidence quality: **A — direct official submit + official live readback**

This is a completed public discovery listing. It is not a customer invocation, 402 intent, paid settlement, or revenue.

## MCP.Directory

The corrected direct no-account submission path reached MCP.Directory's real submit endpoint and returned HTTP `409` with `This repository has already been submitted. We'll review it soon!`.

- listing status: existing submission / review pending
- discovery status: not yet verified public
- no duplicate submission created
- evidence quality: **B**

## PayanAgent funded demand

A funded compatible buyer request remains visible in the public discovery feed:

- request id: `ks76vc9pzpz3qfgf8aawjckn5n8bezhf`
- title: `Build a catalog endpoint-health checker (find dead ecosystem sellers)`
- budget: `$0.04`
- escrow: true
- escrow deposited: `4` cents
- receipt id: `kn76vdyp5sb7kk2bqs130mhrx98bf90e`
- status: open

DELTA already has a prior bid on this exact request; no duplicate or silence-chasing bid was sent. The request-detail route continues to behave inconsistently while the discovery feed remains live, so that route is treated as recoverable third-party degradation.

PayanAgent's existing public offer metadata may still show a `$0.03` Preflight offer. That is external cached/offer metadata and is **not** authority for DELTA's current Public Preflight production price, which is `$1.00` after the correction above.

## Other discovery checks

`x402.new` responded successfully to public API checks but did not return DELTA for the tested search/q/host parameters. No listing claim is made there yet; this is a discovery propagation watch, not a failure of DELTA production.

## Required operating ledger

| channel/source | listing_status | discovery_status | buyer_count | settlement_count | verified_neighbor_demand | external_requests | 402_intents | paid_settlements | treasury_received | revenue | variable_cost | contribution_margin | evidence_quality |
|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| Not Human Search | live / indexed | public official site record | 0 attributable | 0 | n/a | 0 attributable | 0 | 0 | `$0.00` customer | `$0.00` | `$0.00` listing cost | `$0.00` | A |
| DELTA Base production | active | Capture `$0.03` / Public Preflight `$1` / Pilot `$10` healthy | 0 attributable new | 0 customer new | n/a | 0 attributable new | 0 attributable new | 0 customer new | `$0.00` customer new | `$0.00` | n/a until fulfillment | n/a until sale | A |
| Treasury | n/a | direct Base RPC + Blockscout fallback reconciled | 0 new customer | 0 new customer | n/a | n/a | n/a | 0 new customer | `$0.00` customer new | `$0.00` | n/a | n/a | A direct continuity / independent explorer corroboration |
| PayanAgent | existing offers + existing bid | funded request remains discoverable | 1 known funded compatible request | 0 DELTA new | strong neighboring receipt evidence | 1 known funded open request | 0 new attributable | 0 DELTA new | `$0.00` | `$0.00` | `$0.00` this run | `$0.00` realized | A for public funded feed / degraded detail route |
| MCP.Directory | previously submitted / review pending | not verified public yet | 0 | 0 | n/a | 0 | 0 | 0 | `$0.00` | `$0.00` | `$0.00` | `$0.00` | B |

## Revenue conclusion

- new stranger/customer Treasury receipt: **none**
- new customer paid settlement: **none**
- new customer revenue: **`$0.00`**
- completed high-value distribution event: **Not Human Search live indexing**
- verified core production failure found and corrected: **Public Preflight restored from erroneous `$0.03` to owner-approved `$1.00`**

No platform verification, self-test, prior canary, listing exposure, bid, or directory acceptance is counted as customer revenue.