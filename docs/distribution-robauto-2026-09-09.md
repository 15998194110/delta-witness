# Robauto AgentHub distribution evidence — 2026-09-09

## Outcome

DELTA Witness was submitted to the live Robauto AgentHub listing edge advertised by Robauto's public discovery responses:

`https://hkeytqaukllckucnhzey.supabase.co/functions/v1/public-api/listings`

All three submissions returned HTTP `201`, `ok: true`, `status: live`, and were independently read back from that same live endpoint. The public `robauto.ai/api/public/listings` GET snapshot was still stale immediately after submission; Robauto's own documentation states that `/api/public/*` GET paths are static snapshots while POST requests use the live edge URL advertised in the response.

### Live listings

| Product | Listing ID | Public price | Endpoint |
| --- | --- | ---: | --- |
| DELTA Witness Capture | `ee9f5a24-be7b-4331-b2aa-17c696316646` | 0.03 USDC | `https://delta-witness-api.ruphussten.workers.dev/v1/capture` |
| DELTA Witness Preflight | `6006eed4-3ca8-47fb-ab62-dd311a9b15a6` | 1 USDC | `https://delta-witness-api.ruphussten.workers.dev/v1/preflight` |
| DELTA Witness Guarded Action Pilot | `9f5fb8f7-84d2-4971-ac80-9fd3f7fa44f8` | 10 USDC | `https://delta-witness-api.ruphussten.workers.dev/v1/guarded-action-pilot` |

The live readback returned `count: 11` and exactly three `agent_handle: delta-witness` matches. No listing fee, account signup, wallet signature, asset movement, or paid boost was used.

## Production verification after listing

A separate read-only production verification confirmed all three x402 endpoints return HTTP `402` on Base `eip155:8453`, canonical Base USDC, to Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367`, with amounts:

- Capture: `30000` raw = 0.03 USDC
- Public Preflight: `1000000` raw = 1 USDC
- Guarded Action Pilot: `10000000` raw = 10 USDC

This matches current owner authority in `AGENTS.md` and does not alter pricing.

## Treasury reconciliation

Immediately after the distribution action, `scripts/reconcile-treasury.mjs` scanned canonical Base USDC transfers over blocks `51023294` through `51073293` using `https://mainnet.base.org` and found:

- `treasury_received_candidates: 0`
- `total_usdc: 0`
- evidence quality: `A_direct_canonical_USDC_log`

Therefore this distribution action does not increment buyer count, paid settlements, treasury received, or customer revenue. The historical 0.03 USDC receipt remains outside realized-net classification until the non-project payer, DELTA proof, and actual fees/refunds/liabilities are reconciled.

## Credential hygiene

Robauto's create response emitted one-time listing claim tokens. Those values are deliberately omitted from this evidence record. The Actions run that captured the raw create responses was deleted through GitHub's workflow-run API with HTTP `204`; a subsequent fetch returned `404 Not Found`. The claim-token-bearing raw log is therefore no longer retained as a public Actions run. The listing IDs and live readback above are the durable non-secret evidence.
