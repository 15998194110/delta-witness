# DELTA Growth Addendum — Agenstry indexing — 2026-09-10 04:27 +08

## Material result

DELTA gained a new independent, no-login discovery surface on Agenstry and the submission was verified by public readback rather than by submission response alone.

Agenstry's public `/submit` page advertises free/no-login indexing for A2A URLs, MCP endpoints, GitHub repositories, npm/PyPI packages and Docker images, with duplicate submissions treated as no-ops. The live HTML form was inspected first and confirmed `POST /submit`, field `input`, and type field `kind`.

Direct submissions executed:

- `https://github.com/15998194110/delta-witness` as `github` — HTTP 200.
- `delta-witness-mcp` as `npm` — HTTP 200.

No account, fee, wallet signature, asset movement or legal commitment was required.

## Independent public readback

After submission, Agenstry's anonymous public APIs returned the DELTA resources in discovery:

`GET /api/search?q=delta-witness` returned:

- A2A/payment surface `delta-witness-api.ruphussten.workers.dev`, quality score `0.7`, `payment_enabled=true`, `payment_protocol=x402`, `min_price_usd=0.03`.
- MCP resource `npm/delta-witness-mcp`, description `MCP tools for paid DELTA Witness Capture and Guard preflight observations`, quality score `0.3`.
- MCP resource `io.github.15998194110/delta-witness`, description `Paid Capture and Guard tools for public-source observations before autonomous actions`, quality score `0.3`.
- MCP resource `15998194110/delta-witness` also appeared in the broader search result set.

`GET /api/v1/skills/find_mcp?query=delta-witness-mcp` independently returned both:

- `npm/delta-witness-mcp`
- `io.github.15998194110/delta-witness`

`GET /api/v1/skills/find_agent?query=delta-witness` independently returned `delta-witness-api.ruphussten.workers.dev` as the first matching agent.

The public provider page also remains live at `https://agenstry.com/providers/delta-witness-api.ruphussten.workers.dev`.

This is therefore classified as **completed public listing/discovery**, not merely submitted/pending.

Evidence quality: **A** for submission mechanics and public readback.

## Commercial accounting

This listing event is discovery only:

- `buyer_count`: unchanged at 0 independent customers.
- `settlement_count`: unchanged at 0 independent customer settlements.
- `external_requests`: 0 attributable to this listing so far.
- `402_intents`: 0 new customer intents attributable to this listing so far.
- `paid_settlements`: 0 new customer settlements.
- `treasury_received`: 0 new customer USDC in the run's Treasury reconciliation.
- customer `revenue`: $0.00 new.
- `variable_cost`: $0.00.
- realized `contribution_margin`: $0.00.

Do not infer revenue from Agenstry indexing or from its observed-payment metadata.

## Adjacent demand surfaces checked

Agent Bounties and BaseBounty were also inspected as potential funded-work rails. Agent Bounties documents canonical Base-USDC settlement and funded-before-claim invariants, but its live marketplace evidence was temporarily unavailable during this check. BaseBounty exposes read-only browsing without credentials, but taking/submitting mainnet work requires a signing path / ERC-8004 identity and may require a worker bond, which is outside the current autonomous financial boundary. No wallet action was attempted and no specific new compatible funded request was promoted without inspectable live inventory evidence.

## Outreach cap

The natural-day outreach cap remains **3 / 3** after the earlier PulseFeed first contact. No additional outreach may be sent today.
