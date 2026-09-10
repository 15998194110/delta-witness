# DELTA Witness v0.7

> CURRENT OWNER PRICING (2026-09-10): Capture / authenticated Partner Capture / authenticated Partner Preflight / each NEW Watch check = **1 USDC**; Public Preflight = **5 USDC**; Guarded-Action Pilot = **10 USDC**. Read `AGENTS.md` and `docs/pricing-policy-2026-09-10.md` before every run. Conflicting old prices, automatic repricing and paid-canary instructions below are superseded. Historical receipts and prepaid obligations are not rewritten.

[![AllMCPs](https://allmcps.com/api/badge/delta-witness?style=directory)](https://allmcps.com/mcp/delta-witness)

DELTA Witness is a Trust Layer for Autonomous Actions. It observes public sources, records timestamped hashes, and lets software make deterministic preflight decisions without claiming that a source is truthful.

## Production products and current pricing

- Capture: `POST /v1/capture` preserves what a public page says now — **$1.00 USDC**.
- Public Preflight: `POST /v1/preflight` compares a fresh observation with prior proof hashes or explicit text rules — **$5.00 USDC**.
- Guarded-Action Pilot: `POST /v1/guarded-action-pilot` provides the higher-value evidence pilot — **$10.00 USDC**, only promoted for paid use after production verification on Base with the Treasury below.
- Watch: authenticated resellers can prepay a finite number of checks and receive HMAC-signed webhooks — **$1.00 USDC per new check**.
- Partner gateway: authenticated Partner Capture and Partner Preflight are **$1.00 USDC per new billable request** under the current owner pricing authority.

Direct Capture, Public Preflight, and Guarded-Action Pilot use x402 v2 with Base mainnet USDC. Settlement completes before Browser Run begins. The treasury is receive-only from the application:

`0x1990e21bc219696ff7fbc26527dbaed335ac6367`

Never place the treasury private key in Worker, CI, source, or chat.

The current owner-authorized public pricing is **$1 Capture / $5 Public Preflight / $10 Guarded-Action Pilot**; authenticated Partner Capture, Partner Preflight, and each new Watch check are **$1**. Historical settled/idempotent deliveries and already-prepaid obligations retain their original paid identity; they are not double-charged or retroactively repriced.

## Safety and economics

- Public HTTP(S) targets on ports 80/443 only; credential URLs, private/link-local/metadata networks, private DNS answers, DNS rebinding, and unsafe redirects are rejected.
- Request, redirect, time, Browser Run, artifact, and storage bounds are enforced.
- Raw artifacts remain private in `delta-witness-proofs`; verifier routes expose metadata and hashes and are `noindex`.
- Fulfillment is idempotent and a settled payment cannot fulfill a different request.
- Customer-facing prices are fixed by the current owner pricing policy rather than autonomously changed by modeled cost floors. If actual fulfillment economics become negative, DELTA records a pricing-margin alert for operator review instead of silently inventing a new customer price.

## Verify locally

```powershell
npm ci
npm run verify
npm run bazaar
```

`npm run bazaar` performs a read-only scan of the public Bazaar catalog and reports whether DELTA's x402 resource is indexed. It never submits a payment or changes catalog state.

The partner gateway, SDKs, MCP server, and Apify adapter have their own verification commands. The tagged release workflow verifies every artifact, applies D1 migrations, records the current Worker version, deploys core and gateway, then publishes authorized registries.

## Production discovery

- [API and product guide](https://delta-witness-api.ruphussten.workers.dev/docs)
- [OpenAPI](https://delta-witness-api.ruphussten.workers.dev/openapi.json)
- [x402 v2 catalog metadata](https://delta-witness-api.ruphussten.workers.dev/.well-known/x402)
- [Agent skill](https://delta-witness-api.ruphussten.workers.dev/SKILL.md)
- [Distribution manifest](https://delta-witness-api.ruphussten.workers.dev/distribution.json)
- [MCP metadata](https://delta-witness-api.ruphussten.workers.dev/.well-known/mcp/server.json)

The known legacy proof remains available at `/v1/proofs/56347db8-1aa5-447f-a0e4-3bb052d7aa89`. Its historical manifest predates v0.6 self-integrity fields, so the verifier reports `legacy_unverifiable` rather than inventing certainty.
