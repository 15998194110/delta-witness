# DELTA Witness v0.3.1 — Acquisition/Mainnet Build

Goal: get the first payment from an unrelated buyer/agent, then compound discovery automatically.

## What changed

- **Base mainnet**: `eip155:8453`.
- **PayAI facilitator**: public production facilitator, no API key required for the initial free tier.
- **Intro price**: `$0.01 USDC` per fresh proof to match the x402 market's low-friction pay-per-call norm.
- **Bazaar discovery metadata** in the x402 v2 402 response.
- Machine discovery surfaces:
  - `/.well-known/x402`
  - `/.well-known/x402.json`
  - `/x402.json`
  - `/openapi.json`
  - `/.well-known/openapi.json`
  - `/llms.txt`
  - `/llms-full.txt`
  - `/AGENTS.md`
  - `/accepted`
- Human/search discovery surfaces:
  - minimal landing page at `/`
  - `/docs`
  - eight intent-specific `/use-cases/*` pages
  - `/robots.txt`
  - `/sitemap.xml`
  - shareable `/p/:proofId` verifier pages
- Free `/v1/demo` reuses the existing tested proof if it is still in R2.
- Invalid/private targets are rejected before payment challenge.
- Additional DNS private-address screening.
- Artifact size caps.
- Repeat use of the same payment signature returns the same proof; a different URL with the same payment is rejected.
- Raw capture artifacts remain private in R2.

## Revenue loop

`crawler/agent -> discovery metadata -> x402 402 -> $0.01 USDC -> capture -> public proof link -> more discovery`

The treasury remains receive-only from the Worker perspective:

`0x1990e21bc219696ff7fbc26527dbaed335ac6367`

Never put the treasury private key in Worker secrets.

## Deploy

```bash
npm install
npm run check
npm run deploy
```

Then verify:

1. `/health` => `0.3.1`.
2. `/v1/quote` => Base mainnet + PayAI + `$0.01`.
3. `/.well-known/x402`, `/openapi.json`, `/llms.txt`, `/robots.txt`, `/sitemap.xml` => 200.
4. Valid unpaid `POST /v1/capture` => x402 v2 402 with Base mainnet USDC terms and `extensions.bazaar` metadata.
5. Invalid/private URL => 400 **before** 402.
6. Make a single low-value real mainnet payment and capture `https://example.com`.
7. Confirm USDC reaches treasury and `/p/:id` renders.
8. Search PayAI Bazaar for the resource after settlement; discovery may be asynchronous.

## External distribution after deploy

Highest leverage order:

1. PayAI Bazaar auto-discovery from live x402 traffic.
2. x402-bazaar aggregators that ingest PayAI/CDP/third-party catalogs.
3. x402-list (it also auto-imports from public Bazaar/x402scan sources; manual workers.dev submission costs $1 USDC).
4. x402scan via `openapi.json` + `x-payment-info`.
5. MCP Registry only after a remote MCP tool exists; do not add MCP complexity before the first paid HTTP call.

## Product truth boundary

Say: "tamper-evident observation" or "web proof".
Do not say: "proof that the source claim is true" or "guaranteed court-admissible evidence".
