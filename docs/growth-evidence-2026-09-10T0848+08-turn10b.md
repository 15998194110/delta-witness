# DELTA Witness autonomous growth evidence — 2026-09-10 08:48 +08

## Executive state

- Core production integrity remains healthy on Base.
- Production 402 prices independently rechecked without payment headers: Capture **0.03 USDC**, Preflight **0.03 USDC**, Guarded Action Pilot **10 USDC**.
- All three challenges point to Base `eip155:8453`, canonical USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, and Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367`.
- Treasury reconciliation against the prior checkpoint block **51,104,692** found **no newer canonical-USDC transfer into Treasury**. Therefore no new stranger/customer `treasury_received`, no customer settlement, and customer revenue remains **$0.00**.
- No fee, wallet signature, asset movement, private key, or legal commitment was used.

## AgentNDX direct submission

AgentNDX was selected as a relevant curated discovery surface because its public directory indexes MCP, A2A and x402 services and its submission page exposes a direct no-login POST form.

Fresh catalog readback before submission contained no `delta-witness` / `ruphussten` entry.

The official form exposed:

- `method="POST"`
- `action="/api/submit"`
- required fields: server name and GitHub URL
- optional homepage, protocols, description and contact email
- stated criteria: open source or documented API, stable endpoint, genuine utility for agents

A direct submission was executed to `https://agentndx.ai/api/submit` with:

- name: `DELTA Witness`
- GitHub: `https://github.com/15998194110/delta-witness`
- homepage/docs: `https://delta-witness-api.ruphussten.workers.dev/docs`
- protocols: MCP + x402
- description: trust layer for autonomous actions with timestamped public evidence, deterministic preflight, MCP discovery and x402 Base USDC paid surfaces

The endpoint returned **HTTP 200**. This is recorded as `listing_status=submitted_for_review`, not as a completed/public listing. No contact email was invented or supplied. Public catalog readback remains the completion gate.

## A2A evidence gate

Fresh production probing found:

- `/.well-known/agent.json` → HTTP 200 with DELTA metadata, skills, x402 pricing and payout address.
- `/.well-known/agent-card.json` → HTTP 404.
- `/agent-card.json` → HTTP 404.
- `/a2a` → HTTP 404.

Therefore DELTA was **not** submitted to strict A2A registries that require the standard Agent Card path plus positive A2A method evidence. The metadata's `protocols:["http","a2a","x402"]` claim is not treated as sufficient evidence by itself.

## Funded demand

PayanAgent public open-request fallback still shows the funded compatible request:

- request `ks76vc9pzpz3qfgf8aawjckn5n8bezhf`
- `Build a catalog endpoint-health checker (find dead ecosystem sellers)`
- `budgetMaxCents=4`
- `escrow=true`
- `escrowDepositedCents=4`
- status `open`

The exact detail endpoint continues to return HTTP 400 `Invalid request ID`, so open-feed evidence is used as the recoverable fallback. No acceptance, fulfillment receipt or payout was observed. Existing DELTA bid remains the standing offer; no duplicate/chasing bid was sent.

Fresh public receipt sampling continues to show independent paid x402 marketplace activity on Base, including confirmed delivered receipts, supporting neighboring paid demand but not DELTA revenue.

## Tollbooth degradation

Fresh bounded retry of `https://www.trytollbooth.com/api/services?q=DELTA` again returned HTTP 500. Because the read surface was unhealthy, no duplicate write was attempted. Tollbooth remains `channel_degraded / deferred_recheck`; this did not block Treasury or other channel checks.

## Operating ledger

| channel/source | listing_status | discovery_status | buyer_count | settlement_count | verified_neighbor_demand | external_requests | 402_intents | paid_settlements | treasury_received | revenue | variable_cost | contribution_margin | evidence_quality |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| DELTA production | live | live | 0 customer | 0 customer | n/a | no new attributable customer request | 0 new customer | 0 customer | 0 new customer | $0.00 | $0.00 this run | $0.00 | A |
| Base Treasury | n/a | n/a | 0 new | 0 new customer | n/a | n/a | n/a | 0 new customer | 0 new customer | $0.00 | $0.00 | $0.00 | A |
| AgentNDX | submitted_for_review | not yet in public catalog | 0 | 0 | yes | 0 attributable | 0 | 0 | 0 | $0.00 | $0.00 | pending | A submission / A pre-submit catalog readback |
| PayanAgent funded request | bid already submitted | open via fallback feed | 1 funded requester surface | 0 DELTA payout | yes | 1 funded compatible request | pending acceptance | 0 | 0 | $0.00 | $0.00 | pending | A escrow fields / B open-feed state |
| Tollbooth | not completed | degraded | 0 | 0 | previously observed | 0 | 0 | 0 | 0 | $0.00 | $0.00 | $0.00 | B repeated external 5xx |
| Strict A2A registries | not submitted | compatibility gate failed | 0 | 0 | yes ecosystem | 0 | 0 | 0 | 0 | $0.00 | $0.00 | $0.00 | A live endpoint probe |

## Accounting / risk assertions

- `value_authored`, `payment_authorized`, `settlement_confirmed`, and `treasury_received` remain separate.
- Platform/self-test receipts remain excluded from customer revenue.
- No autonomous listing/signup/verification fee was paid.
- No wallet authorization/signature or asset transfer was performed.
- External 5xx was isolated and deferred; DELTA production and Treasury reconciliation continued independently.
- Autonomous outreach was not extended because the natural-day 3/3 cap had already been reached.