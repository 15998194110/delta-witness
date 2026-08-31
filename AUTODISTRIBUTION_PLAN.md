# DELTA v0.5 — Autonomous Distribution Architecture

## Principle

Do not require every buyer to search for “DELTA”. Put the same proof engine behind distribution hosts that already own user or agent demand.

## Revenue rails

### 1. Direct x402
Buyer/agent → DELTA core → USDC on Base → Treasury.

### 2. Marketplace billing
Buyer → marketplace checkout/subscription/PPE → marketplace inserts hidden server-side secret → DELTA Partner Gateway → shared Browser Run + R2 → marketplace payout.

This keeps product execution centralized while allowing many independent storefronts.

## Channels

### Fully automatable after one-time credentials
- Cloudflare core Worker deployment
- Cloudflare partner-gateway deployment
- npm package release via Trusted Publishing
- PyPI package release via Trusted Publishing
- Official MCP Registry via GitHub OIDC
- Postman collection synchronization via Postman API key
- Apify Actor source deployment via APIFY_TOKEN
- IndexNow and discovery endpoint health pulse

### One-time marketplace setup, then automated updates
- RapidAPI: create provider listing, choose pricing, set backend to partner gateway, set hidden proxy secret. RapidAPI then authenticates/bills customers and forwards requests.
- Apify monetization: KYC + PPE event `proof-created` + Actor store publication. Subsequent source updates deploy automatically.
- Chrome Web Store: developer account, Store listing + Privacy tabs, OAuth/service-account authorization. Google still reviews releases; code upload/publish can then be automated by API.
- Base App: one-time app registration/account ownership. Subsequent web deployment is automatic. Human checkout should be implemented before treating it as a monetization channel.

## Current deployment order
1. Core x402 production
2. Partner Gateway production with a randomly generated high-entropy secret
3. RapidAPI listing → partner gateway
4. Apify Actor → partner gateway
5. npm + PyPI discovery clients
6. MCP Registry
7. Postman API Network
8. Human checkout
9. Browser extension / Base App after human checkout exists

## Why Chrome/Base are gated
Shipping a browser extension or Base surface before a human can complete checkout would create traffic without a transaction path. Distribution is only valuable when it terminates in a paid action.
