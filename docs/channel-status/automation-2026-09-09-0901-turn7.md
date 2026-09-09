# DELTA growth checkpoint — 2026-09-09 09:01 Asia/Shanghai

Conservative accounting remains authoritative: directory/index events and package downloads are discovery/adoption signals, not buyers, settlements or revenue. `value_authored`, `payment_authorized`, `settlement_confirmed` and `treasury_received` remain separate.

## New free distribution: Walnut World

The immediately preceding one-shot operator run submitted the public DELTA GitHub repository to Walnut World through its no-account public-source index form. Evidence commit `b93e04f3b813db219702ae0ab5bf94850f92c240` records HTTP 303 to `https://walnut.world/w/delta-witness`; Walnut search readback for the repository returned HTTP 200 and contained DELTA/repository text. Walnut publicly describes itself as an index of models, skills, agents, plugins, MCP servers, apps and sites and accepts public GitHub sources without an account. This is discovery, not a paid buyer event.

## MCP adoption signal and conversion blocker

Fresh public Socket readback for `delta-witness-mcp` reports 29 weekly downloads for the published MCP package. Treat this as package retrieval activity only: it does not identify unique users or prove any API call or payment.

A conversion mismatch was found in the repository MCP instructions: the example/default spend cap was 0.10 USDC while the owner-approved public Preflight experiment is 1 USDC. The MCP implementation therefore rejects a 1 USDC Preflight unless the buyer explicitly increases `DELTA_MAX_USD_PER_CALL`; this is a buyer safety control, not a production pricing failure. The published package remains subject to its installed version and is not claimed updated by a repository-only documentation change.

Repository README fix commit `0ddc0db2a634a7ac46b2a4c1ae5ae2f4b0c73c2c` now states that 0.10 intentionally permits Capture but blocks the current 1 USDC Preflight, and gives a separate explicit 1.00 opt-in only after a fresh `delta_quote`. No runtime, package publish, wallet signature or spend authority was changed.

## Fresh market research

Two new/expanded surfaces were verified from current public sources:

- CyberAgents Exchange (Tenable): free, vendor-neutral cybersecurity directory for agents, skills, MCP servers and playbooks; contributions are GitHub pull requests. Tenable announced an OpenAI-GPT-cyber-model-powered Inspector for Exchange components, expected in September 2026. DELTA's MCP witness/preflight role is strongly aligned, but this run did not fabricate a submission because the available GitHub connection does not expose a safe fork/PR path into the external Tenable repository.
- Hober: Base-mainnet agent-commerce escrow/job marketplace plus x402 and MCP/SDK access. Provider-side commerce fees are material (roughly 10% when evaluator is used) and registration/account authority was not established, so no listing or wallet action was attempted.
- req402: Base-mainnet x402 marketplace with free setup but a 5% successful-transaction facilitator fee and an account/dashboard-oriented publishing flow; no account or wrapper migration was created.

## Outreach

No new qualifying human reply was found in the active DELTA outreach inbox. The current Asia/Shanghai natural-day cold-start allowance is already exhausted by three first contacts sent earlier today to Shopper, Robauto/AgentHub and Hyperbrowser. No additional email was sent and no unanswered contact was chased.

## Treasury / paid funnel

The freshest completed one-shot reconciliation in the preceding operator commit scanned canonical Base USDC transfers to Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367` from block `51060235` through `51063081` and found `incoming_count=0`; its D1 revenue-candidate query returned `candidate_rows=0`. Therefore this checkpoint recognizes no new `settlement_confirmed`, `treasury_received`, revenue, variable cost or contribution margin.
