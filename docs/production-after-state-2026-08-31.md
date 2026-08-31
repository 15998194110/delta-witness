# DELTA Witness production after-state — 2026-08-31

## Deployments and rollback points

| Surface | Current production | Immediate rollback point |
| --- | --- | --- |
| Core Worker | `d22aafd8-f8e4-4a5d-a318-d4d4ff46e86b` at `https://delta-witness-api.ruphussten.workers.dev` | `aa58565e-6d8c-4ec8-a2c2-1f79295508e5` |
| Partner gateway | `58746f35-fadd-435a-a11f-9875aad5b20f` at `https://delta-witness-partner-gateway.ruphussten.workers.dev` | `d53c4b94-6298-4f11-8650-f150891675d4` (last code upload before v0.6 gateway changes) |
| Base standard web app | `356a26b1-9f39-4ec0-be8c-2a38c3aec9e1` at `https://delta-witness-app.pages.dev` | `38306f0a-d703-4347-a8fa-87810a3504b9` |

## Acceptance evidence

- Core: TypeScript clean, dry-run build clean, 35 tests passing.
- Partner gateway: TypeScript clean, dry-run build clean, 6 tests passing.
- Base app: TypeScript and production build clean, 3 payment-boundary tests passing, desktop/mobile browser acceptance clean, no console errors.
- MCP server: TypeScript/build clean, 2 tests passing.
- JavaScript client: syntax clean, 1 test passing.
- Python client: source compilation, sdist, and wheel build clean.
- Apify Actor: syntax clean; pay-per-event floor and budget checks occur before DELTA invocation.
- Capture and Guard return x402 v2 HTTP 402 with Base mainnet `eip155:8453`, 30,000 atomic USDC ($0.03), the configured treasury, and `paymentFlow: upfront`.
- Unsafe private target is rejected with HTTP 400 before a payment challenge.
- D1 changed from 2 to 7 `qualified_request`/`payment_required` events during acceptance while `capture_started`, `capture_completed`, and `payment_verified` remained absent. This confirms unpaid acceptance traffic did not enter fulfillment.
- R2 remained exactly 5 objects / 22.6 kB before and after unpaid acceptance. The fifth object is the bounded Watch scheduler cursor; no proof object was deleted or exposed.
- Existing proof `56347db8-1aa5-447f-a0e4-3bb052d7aa89` remains readable, proof routes remain `noindex`, and direct raw-artifact guesses return 404.
- Core discovery, OpenAPI, SKILL, MCP metadata, Postman, sitemap, three factual use-case pages, and `llms-full.txt` return HTTP 200.
- Partner OpenAPI and robots return HTTP 200, disclose no gateway secret names/values, and unauthenticated fulfillment returns HTTP 401.
- Base app, robots, sitemap, CSP, live floor-aware quote, and public IndexNow ownership file return HTTP 200.
- IndexNow returned HTTP 202 for both hosts, meaning the first submissions were received pending key verification.
- PayAI Bazaar scan covered all 27,862 listed resources and found zero DELTA matches. No paid canary was used to force cataloging.
- Resume drift check (2026-08-31): Core, gateway, Base App, existing proof, x402 metadata, and MCP metadata remained healthy; unpaid Guard remained HTTP 402 and a loopback target remained HTTP 400 before payment. R2 remained 5 objects / 22.6 kB. Current telemetry contains only discovery/quote/unpaid-proof-open activity (`page_view` 17, `quote_issued` 29, `qualified_request` 8, `payment_required` 8, `proof_opened` 14); no `payment_verified`, `capture_completed`, `watch_checked`, or paid `partner_request` events.

## Revenue and acquisition state

- Organic paid calls: 0.
- Organic gross revenue: $0.
- Owner/canary transactions: 0 and excluded from revenue by policy.
- Current direct unit estimate: $0.03 gross, $0.0028825 expected variable cost, $0.0271175 expected contribution margin before channel-specific costs.
- The Base web app is publicly deployed and can perform injected-wallet x402 payment without custody or a server-side payer key.
- Search discovery pulses are live in code and both production hosts have been submitted to IndexNow.
- Bazaar publication still requires a real third-party settlement according to the facilitator's discovery flow; forcing it with an owner purchase was intentionally declined.

## One-time external bootstrap still required

These are provider-account actions and cannot be completed from the current authenticated environment:

1. Create/connect a GitHub repository and approve Actions secrets/OIDC so the tagged release train can deploy every surface.
2. Configure npm Trusted Publishing for `delta-witness-ruphussten` and `delta-witness-mcp`, then publish; MCP Registry GitHub OIDC follows npm publication.
3. Configure PyPI Trusted Publishing for `delta-witness-ruphussten`.
4. Authorize Postman API access and workspace/collection identifiers.
5. Complete Apify account/KYC/store terms and configure its token plus partner secret.
6. Register the deployed app in Base.dev and accept the current developer agreement/builder-code setup.
7. Create/approve marketplace listings and payout/KYC for RapidAPI or any other reseller that will bill the end customer.

No treasury private key, seed phrase, exchange credential, or bank credential is needed or permitted for these steps.
