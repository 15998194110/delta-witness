# CODEX MASTER HANDOFF — DELTA Witness

## Mandate
Take end-to-end engineering and distribution ownership of DELTA Witness. Do not stop at “deployment succeeded.” The business objective is autonomous profitable acquisition: a stranger or autonomous agent discovers DELTA without manual outreach, pays, receives a proof automatically, and the transaction is contribution-margin positive.

The human owner should not be required for ongoing sales, customer support, content posting, deployment, pricing, or routine operations. Ask for human action only when a provider legally/security-wise requires one-time login, KYC, billing approval, OAuth consent, developer agreement, domain purchase, or secret entry. Never ask the user to paste seed phrases, wallet private keys, exchange passwords, or bank credentials into chat/code.

## Current production facts
- Existing API: https://delta-witness-api.ruphussten.workers.dev
- Known successful E2E proof URL: https://delta-witness-api.ruphussten.workers.dev/v1/proofs/56347db8-1aa5-447f-a0e4-3bb052d7aa89
- Treasury public address: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`
- Existing Cloudflare R2 bucket to preserve: `delta-witness-proofs`
- Existing Worker name to preserve/upgrade: `delta-witness-api`
- Current source bundle is v0.5-autodistribution. Treat it as an input, not as trusted production-ready code.

## Critical product correction
Do NOT assume DELTA wins only by users explicitly searching for “web proof.” That is latent/rare demand. Preserve `/v1/capture`, but shift product strategy toward demand-embedded infrastructure:

1. **Capture** — preserve what a public page says now.
2. **Guard / Preflight** — automatically verify whether source inputs changed before an agent/user executes a consequential action.
3. **Watch** — register a public source once and automatically detect/certify later changes.
4. **Partner/Reseller gateway** — let downstream platforms collect payment and call DELTA automatically.

Long-term positioning: **Trust Layer for Autonomous Actions**, not merely “screenshot evidence.”

## P0 — Inspect, compile, and protect production
Before deploying anything:
1. Unpack the repo and inspect all source, workflows, Wrangler config, partner gateway, SDKs, and channel adapters.
2. Run dependency install, typecheck/build/tests. Fix every failure.
3. Note: the v0.5 source currently appears to report `version: "0.4.0"` in `/health`; fix version drift everywhere.
4. Fetch current production `/health`, `/v1/quote`, proof manifest, and all existing public discovery endpoints. Record a before-state.
5. Preserve existing R2 objects. Never delete or publicly expose archived proof artifacts.
6. Make a Git repository / commit baseline if one does not already exist.
7. Add tests for URL validation, private-network blocking, redirect handling, payload limits, payment middleware, replay/idempotency, and proof manifest integrity.

## P1 — Mainnet-safe autonomous revenue
The current source config targets Base mainnet (`eip155:8453`) and USDC. Validate rather than blindly deploy.

Hard gates:
- An unpaid request MUST NOT start Browser Run or incur capture work.
- Settlement must be verified before delivery.
- Prevent payment replay / duplicate fulfillment.
- Idempotency for retrying settled requests.
- Public URL only; block localhost, RFC1918/link-local/metadata endpoints, credential URLs, unsafe ports, and DNS rebinding where feasible.
- Bound redirects, rendered size, capture duration, Browser Run time, R2 size, and max per-request cost.
- Raw artifacts private by default; public verifier exposes metadata/hashes only.
- Treasury wallet is receive-only from application perspective. No Treasury private key in server or CI.
- If an attester wallet is introduced, make it a separate low-value hot wallet stored only in provider secret management.
- Record actual Browser Run milliseconds and estimate variable cost per fulfilled order.

Do ONE explicitly labeled canary mainnet purchase only if required to activate Bazaar/indexing. Never classify owner/canary transactions as organic revenue.

## P2 — Add acquisition/attribution telemetry before scaling
We cannot optimize profit without funnel data. Add privacy-conscious server-side events, preferably Cloudflare-native (Analytics Engine/D1/Queues as appropriate), for:
- landing/docs/use-case page view (aggregate where possible)
- channel/referrer
- quote/402 issued
- payment verified
- capture started
- capture completed/failed
- proof opened
- repeat call
- partner/reseller source
- actual browser milliseconds / storage bytes / estimated variable cost
- gross price / estimated contribution margin

Support `channel`/partner attribution safely via metadata or signed partner identity. Build a small internal dashboard or query script showing:
`channel -> qualified requests -> 402 -> paid -> delivered -> repeat -> gross revenue -> variable cost -> contribution margin`.

Optimize for **profit per autonomous distribution surface**, not vanity traffic.

## P3 — Build demand-embedded products
### A. `/v1/preflight` (DELTA Guard)
Design a machine-friendly endpoint that lets an agent verify a public source before executing a consequential action. Start deterministic/simple rather than hallucination-heavy AI. Possible inputs:
- URL
- expected content/hash/known prior proof id
- fields/selectors or textual expectations
- value_at_risk / freshness requirement

Return structured `safe`, `changed`, `observed_at`, `diff`, proof reference, and machine-readable reason. Keep factual semantics precise: DELTA proves observation/change, not truth.

Make the endpoint discoverable in OpenAPI, MCP, SKILL.md, x402 metadata, SDKs, and partner adapters.

### B. Watch
Implement the smallest economically sane watch product. Avoid creating an unbounded free polling liability. Use explicit prepaid quota, per-check/per-change charging, or a platform billing rail. Support webhook delivery. Only run checks if expected contribution margin is positive. If x402 cannot support autonomous recurring debit cleanly, use platform billing/prepaid credits rather than inventing unsafe wallet custody.

## P4 — Autonomous distribution surfaces
Use ONE core service and thin adapters. Do not fork business logic per marketplace.

### Tier S / highest priority
1. **x402 / Bazaar / Agentic Market / x402 aggregators**
   - Correct x402 v2 metadata and input/output schema.
   - Verify automatic discovery.
   - If first settle is needed, use the labeled canary.
   - Check secondary indexing/aggregation.

2. **MCP ecosystem**
   - Publish a production MCP adapter exposing Capture + Guard (and Watch when sane).
   - npm package + official MCP Registry.
   - Mirror/claim on relevant MCP discovery surfaces where official automation is supported.
   - Make installation zero-config except payment-capable client/wallet.

3. **Search / AEO**
   - Sitemap + robots + valid structured content.
   - IndexNow only where supported.
   - Do NOT misuse Google Indexing API for ordinary pages.
   - Create high-intent, factual use-case pages; avoid mass thin SEO spam.
   - Keep private proof pages `noindex` by default.

4. **Base-native distribution**
   - Register in Base developer/app surfaces if still supported/current.
   - Build a minimal Mini App: Paste URL -> quote/pay -> proof.
   - Reuse core API; no duplicated capture logic.

### Tier A
5. **Postman API Network** — public workspace/collection auto-synced via API.
6. **Apify** — thin Actor calling partner gateway; pay-per-event if viable; KYC only once. Measure net payout after platform costs.
7. **RapidAPI / API marketplaces** — platform bills end user, hidden/signed partner gateway calls DELTA. Validate proxy secret and rate limits.
8. **npm + PyPI SDKs** — publish with Trusted Publishing/OIDC where available; provenance enabled.
9. **n8n / workflow ecosystems** — thin node/template that calls DELTA; prioritize workflows where proof is a natural step.

### Tier B / only after core economics work
10. **Browser extension** — contextual human acquisition (“Preserve this page”, later “Protect this purchase/terms”). No default capture of private pages; explicit user action/permission.
11. Other extension/app stores only if maintenance remains automated and economics justify it.

Do not use spammy automated posting, fake accounts/reviews, unsolicited mass outreach, or tactics that violate platform rules. The distribution advantage should come from official registries, search, integrations, downstream dependencies, and product-generated discovery.

## P5 — Partner gateway / machine reseller economics
Keep two rails:
- **Direct**: x402 -> USDC -> Treasury -> DELTA Core.
- **Platform/reseller**: marketplace handles buyer/payment -> authenticated partner gateway -> DELTA Core.

Make it possible for another agent/product to resell DELTA without a bespoke contract where the payment rails permit it. Downstream service may charge its own customer more than DELTA costs. DELTA must still authenticate the platform/partner request and maintain rate/cost controls.

## P6 — Release train
Target: one tagged release updates every automatable surface.

Use CI/CD to publish/deploy:
- Cloudflare core Worker
- partner gateway
- npm
- PyPI
- MCP Registry metadata
- Postman collection/workspace
- Apify Actor
- docs/discovery metadata
- search/indexing pulse

Use OIDC/Trusted Publishing where supported. For other providers, store secrets in GitHub/Cloudflare/provider secret stores, not files. Never commit secrets.

If a platform requires one-time human bootstrap:
1. Do everything possible first.
2. Present ONE concise blocking request with exact provider/action and why it cannot be automated.
3. Resume immediately after authorization.

## P7 — Pricing / profitability
Do not hard-code $0.01 forever. Create an evidence-based pricing system.
- Floor price > expected settlement fee + browser cost + storage/compute + failure allowance + target margin.
- Cached/cheap verification may be lower priced than fresh browser capture.
- Guard price can scale with freshness/depth, not with the customer's value-at-risk unless transparently justified.
- Platform channels must account for platform revenue share and payout fees.
- Automatically disable/raise price on routes or target classes that become contribution-margin negative.

Use experiments where possible, but never deceptive pricing.

## Success metrics / acceptance criteria
### Engineering acceptance
- Production healthy and rollbackable.
- Existing proof objects preserved.
- Core and gateway compile/test cleanly.
- x402 mainnet payment path works safely.
- Channel attribution + unit economics available.
- Capture + Guard exposed in docs/OpenAPI/MCP/discovery.
- At least the top automated distribution surfaces are actually published/indexed, not merely documented.

### Business acceptance
The primary milestone is **First Stranger Revenue**:
A wallet/user/agent not controlled by the owner independently discovers DELTA through a distribution surface, pays real value, receives valid output, and the fulfillment is contribution-margin positive.

Do not count:
- owner wallet
- test/canary wallets
- self-purchases
- manually solicited friends

After first organic revenue, optimize for:
1. repeat autonomous calls,
2. margin-positive distribution channels,
3. integration hosts that invoke DELTA as a dependency,
4. Guard/Watch recurring usage.

## Reporting style
Work autonomously. Do not stop to ask strategic questions that can be resolved through code/docs/testing. Report only:
- completed milestones,
- material risks or discovered contradictions,
- one-time human authorization blockers,
- first organic revenue / meaningful funnel evidence,
- decisions to kill or deprioritize unprofitable channels.

When assumptions about current provider/platform rules matter, verify against current official documentation before implementing.
