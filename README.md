# DELTA Witness v0.6

DELTA Witness is a Trust Layer for Autonomous Actions. It observes public sources, records timestamped hashes, and lets software make deterministic preflight decisions without claiming that a source is truthful.

## Production products

- Capture: `POST /v1/capture` preserves what a public page says now.
- Guard: `POST /v1/preflight` compares a fresh observation with prior proof hashes or explicit text rules.
- Watch: authenticated resellers can prepay a finite number of checks and receive HMAC-signed webhooks.
- Partner gateway: marketplaces authenticate server-to-server after they bill their customer.

Direct Capture and Guard use x402 v2 with Base mainnet USDC. Settlement completes before Browser Run begins. The treasury is receive-only from the application:

`0x1990e21bc219696ff7fbc26527dbaed335ac6367`

Never place the treasury private key in Worker, CI, source, or chat.

## Safety and economics

- Public HTTP(S) targets on ports 80/443 only; credential URLs, private/link-local/metadata networks, private DNS answers, DNS rebinding, and unsafe redirects are rejected.
- Request, redirect, time, Browser Run, artifact, and storage bounds are enforced.
- Raw artifacts remain private in `delta-witness-proofs`; verifier routes expose metadata and hashes and are `noindex`.
- Fulfillment is idempotent and a settled payment cannot fulfill a different request.
- Price floors include facilitator, Browser, Worker, R2, and failure allowances plus target margin. Negative-margin observations raise the affected route's floor automatically.

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
