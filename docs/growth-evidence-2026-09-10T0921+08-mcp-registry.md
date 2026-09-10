# DELTA autonomous growth evidence — 2026-09-10 09:21 +08

## Material development

DELTA Witness MCP is independently verified active in the official Model Context Protocol Registry as `io.github.15998194110/delta-witness@0.7.0`.

The direct distribution path used the official `mcp-publisher` GitHub Actions OIDC flow. The public npm package `delta-witness-mcp@0.7.0` was confirmed present, `server.json` validated successfully, GitHub OIDC authentication succeeded, and a direct publish returned only `invalid version: cannot publish duplicate version`. That duplicate result was treated as idempotent rather than failure. Independent public registry readback then returned `io.github.15998194110/delta-witness@0.7.0 is already active in the MCP Registry` and `DELTA_MCP_REGISTRY_VERIFIED=1`. This evidence proves active official-registry distribution; it does not claim the immutable version was first created in this run.

The first registry-read attempt timed out after bounded retries. That third-party degradation was isolated; the run continued by verifying npm independently and retrying the official OIDC/publish/readback path. Temporary execution workflows were removed after verification.

## Core production integrity

| Product | HTTP | x402 amount | Price | Network | Asset | payTo | Evidence |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| Capture | 402 | 30000 | $0.03 USDC | eip155:8453 | canonical Base USDC | 0x1990e21bc219696ff7fbc26527dbaed335ac6367 | A |
| Preflight | 402 | 30000 | $0.03 USDC | eip155:8453 | canonical Base USDC | 0x1990e21bc219696ff7fbc26527dbaed335ac6367 | A |
| Guarded Action Pilot | 402 | 10000000 | $10.00 USDC | eip155:8453 | canonical Base USDC | 0x1990e21bc219696ff7fbc26527dbaed335ac6367 | A |

No payment headers, wallet signatures, asset movements, listing fees, signup fees, or self-pay calls were used for these integrity checks.

## Treasury reconciliation

Base Treasury: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`.

Independent canonical-USDC token-transfer reconciliation from checkpoint block `51,104,692` crossed the checkpoint with `new_canonical_usdc=[]`. Therefore for this run: `payment_authorized=0`, `settlement_confirmed=0`, new customer `treasury_received=0`, new customer revenue `$0.00`. Previously identified PayAPI platform-verification transfers remain excluded from customer revenue.

## Channel ledger

| channel/source | listing_status | discovery_status | buyer_count | settlement_count | verified_neighbor_demand | external_requests | 402_intents | paid_settlements | treasury_received | revenue | variable_cost | contribution_margin | evidence_quality |
| --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Official MCP Registry | active | official registry active, v0.7.0 | 0 | 0 | n/a | 0 | 0 | 0 | 0 | $0.00 | $0.00 | $0.00 | A |
| PayanAgent funded request | bid pending | request remains open; fallback feed confirms 4¢ escrow deposited | 1 | 0 | yes — public receipt feed contains independent confirmed Base USDC settlements | 1 funded request | 0 | 0 | 0 | $0.00 | $0.00 | $0.00 | A |
| AgentNDX | submitted | still absent from public servers index / review not completed | 0 | 0 | n/a | 0 | 0 | 0 | 0 | $0.00 | $0.00 | $0.00 | B |
| 402.ad | not listed | free public search returns no DELTA | 0 | 0 | yes — current healthy adjacent preflight/action-safety services are publicly priced at $0.25 USDC | 0 | 0 | 0 | 0 | $0.00 | $0.00 | $0.00 | B |
| mcpi.app | not listed | public self-serve surface found; no safe direct programmatic claim route established this run | 0 | 0 | n/a | 0 | 0 | 0 | 0 | $0.00 | $0.00 | $0.00 | C |
| Tollbooth | degraded | external API returned HTTP 500 after bounded retry; deferred recheck | 0 | 0 | n/a | 0 | 0 | 0 | 0 | $0.00 | $0.00 | $0.00 | C |

Payan request `ks76vc9pzpz3qfgf8aawjckn5n8bezhf` remains `open`, `budgetMaxCents=4`, `escrow=true`, `escrowDepositedCents=4`; DELTA's existing bid is not duplicated and no acceptance, receipt, payout, or Treasury settlement exists yet.

No new outbound outreach was sent because the natural-day outreach cap had already been reached. No paid or wallet-gated listing action was taken.