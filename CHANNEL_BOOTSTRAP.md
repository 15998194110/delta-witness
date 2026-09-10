# Channel bootstrap order

> CURRENT OWNER PRICING (2026-09-10): Capture / authenticated Partner Capture / authenticated Partner Preflight / each NEW Watch check = **1 USDC**; Public Preflight = **5 USDC**; Guarded-Action Pilot = **10 USDC**. Read `AGENTS.md` and `docs/pricing-policy-2026-09-10.md` before every run. Conflicting old prices, automatic repricing and paid-canary instructions below are superseded. Historical receipts and prepaid obligations are not rewritten.

1. Agentic Market / x402 Bazaar — validate live endpoint, then seed one labeled canary settle only if indexing requires it.
2. x402-list — wait for automatic Bazaar/x402scan import before paying any submission fee.
3. IndexNow — the v0.6 cron submits the small set of factual static pages daily.
4. Postman API Network — import `distribution/postman/DELTA-Witness.postman_collection.json`; public workspace.
5. Official MCP Registry — requires an npm-published adapter package and registry auth.
6. Smithery/Glama — reuse the MCP adapter; publish/claim.
7. Base Dashboard — register app, measure Base transacting users; mini-app after core human checkout exists.
8. Apify Store — only after provider KYC; use PPE so agentic users can discover/pay automatically.
9. RapidAPI — conventional API market after a non-x402 wrapper and payout setup.
10. Chrome/Firefox extension — after a simple human payment surface exists.
