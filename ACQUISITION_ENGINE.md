# DELTA Acquisition Engine v0.6

> CURRENT OWNER PRICING (2026-09-10): Capture / authenticated Partner Capture / authenticated Partner Preflight / each NEW Watch check = **1 USDC**; Public Preflight = **5 USDC**; Guarded-Action Pilot = **10 USDC**. Read `AGENTS.md` and `docs/pricing-policy-2026-09-10.md` before every run. Conflicting old prices, automatic repricing and paid-canary instructions below are superseded. Historical receipts and prepaid obligations are not rewritten.

## Current revenue-first expansion handoff — 2026-09-17 12:45 JST

Read `docs/channel-status/revenue-expansion-2026-09-17-1245.json` before another prospect contact, reply or registry action. It is the newest repository handoff and supplements, but does not replace, the canonical Commercial Operator workspace.

- **There is no numerical daily/per-day DELTA outreach cap.** Scale through more independently qualified unique targets, while keeping one personalized first contact per target, official public business contacts/routes only, Gmail/operator-record dedupe before each send, no duplicate first contacts, no chasing silence, and immediate stop on rejection.
- Six additional unique targets were contacted once after domain/contact suppression checks: Lindy (`1a0ad6cf07beaf09`), AgentCard (`1a0ad6d7883beb32`), Locus / PayWithLocus (`1a0ad6ed487e9e82`), PayOS (`1a0ad6f119c10e16`), BeyondStyle (`1a0ad6f6e9ba9318`) and Payman AI (`1a0ad704e71079ab`). **Suppress all six from any further cold first contact.** They remain Grade-C commercial demand until explicit reply, funded request or independent customer settlement appears. Technical compatibility is not buyer demand.
- Locus, PayOS, BeyondStyle and AgentCard are currently the strongest new buyer/integration surfaces because they already sit in paid-tool discovery, agent payment or autonomous-shopping flows. The proposed entry point is deliberately narrow: one genuine buyer-authorized **1 USDC Public Capture** immediately before a selected action that depends on public price, availability, vendor terms, returns/refund policy or similar public state. Do not ask for broad integration before one real use is identified.
- Kernel, Arcade.dev and FluxA were qualified but **not contacted**: no independently verified direct public business email was found, and their official forms could not be safely executed with available browser tooling; FluxA's form additionally requires a phone value not available in the current operator context. Do not guess addresses or invent form data.
- Robauto / AgentHub remains the only explicit-interest integration thread. Founder Jalali Hartman had said DELTA was interesting, offered to work on verification and requested the concrete use case. A current-price answer was already sent in-thread; there is still no newer substantive inbound. Do not chase silence.
- Fresh live verification at **2026-09-17T03:38:02Z** confirmed Public Capture 1 USDC, Public Preflight 5 USDC and Guarded-Action Pilot 10 USDC with Base `eip155:8453`, canonical USDC and Treasury. Direct Treasury reconciliation covered Base blocks **51,363,473–51,413,472** and found **0** canonical-USDC Treasury receipt candidates in that explicit 50,000-block range. A contemporaneous Blockscout overlap check from block 51,411,636 through 51,413,469 also returned 0. Do not generalize these ranges to an all-time zero claim.
- The corrected paid-funnel audit completed at about **2026-09-17T03:40:42Z** with `candidate_rows=0`. Current AgentPact remains 3 active offers at **1 / 5 / 10 USDC**, 16 external requests, zero DELTA-native funded-compatible requests/deals and zero paid settlements. AgentExchange has 2 requests and zero funded-compatible match. Additional funded-demand sources show 16 adjacent funded requests but zero DELTA-native funded requests; MoltJobs shows 10 funded rows but zero DELTA-native match; WorkPnP shows zero funded rows. PayanAgent is recoverably degraded with HTTP 500 and does not block Treasury or other channels.
- Sprint counted customer transactions remain **0 / 50** under the strict counting invariant. Cold outreach, technical fit, platform listings and adjacent funded research/code work are not counted. New variable cost and contribution margin remain **unknown/null**, not zero.
- Rye's attempted public contact `nate@rye.com` previously produced Gmail 550 5.1.1 address-does-not-exist failures. Suppress that address and do not guess a replacement. Firmly and Crossmint retain prior duplicate/corrective-contact history; suppress them from additional first contacts unless explicit human inbound arrives. Crossmint automated support acknowledgements are not integration intent.
- Paywitness remains deferred after bounded 503 Service Suspended readbacks. Arispay's free seller path remains gated on secure persistence of its developer credential; do not create an orphaned seller identity. Existing x402 Arena and AgentPact identities/offers must be reused, never duplicated.
- No fees, wallet signatures, asset movement, paid tests, KYC/legal commitments or new recurring growth loop were authorized by this handoff. Keep the fixed sprint deadline **September 21 13:43:28 JST** unchanged.

## Prior handoff — 2026-09-17 10:32 JST

The 10:32 JST state is retained for audit continuity. It recorded the superseding no-daily-limit outreach rule, the Robauto explicit-interest reply/answer, earlier unique contacts (including Composio, AgentScore, x402 Agentic and Five Dollar Workday), Rye's 550 failure, Firmly/Crossmint suppression, then-current Treasury/paid-funnel evidence, and deferred Paywitness/Arispay constraints. When it conflicts with the 12:45 JST handoff above, use the newer evidence above while preserving historical facts.

North star: first **independent customer** payment, then repeatable CAC ≈ 0 channels.

Formula:

`Revenue = Discovery Surface × Qualified Intent × Payment Conversion × Delivery Success × Repeat Usage × ARPU`

The system expands Discovery Surface without adding sales labor.

## Revenue evidence invariant

A Base USDC transfer into Treasury is `treasury_received`, but it is not automatically customer revenue. Revenue is recognized only after the payer and DELTA proof/telemetry reconcile to a non-project, non-canary, non-self-pay, non-platform-verification buyer.

Known platform/test verifier wallets must remain excluded in `scripts/reconcile-treasury.mjs`. The 2026-09-07 receipt previously labeled `First Stranger Revenue` is superseded by `docs/growth-evidence-2026-09-10T0125+08-payapi-reclassification.md`: the same payer later produced an explicitly identified PayAPI paid verification call, so both same-wallet receipts are classified PayAPI platform verification rather than independent customer revenue. Until a different independently evidenced buyer settles, recognized customer revenue remains `$0.00`.

## Runtime acquisition in v0.6

- `/SKILL.md` — agent-consumable purchase instructions.
- `/distribution.json` — machine-readable distribution manifest.
- `/postman.json` — importable Postman collection.
- `/indexnow-key.txt` + scheduled IndexNow submission — automatic Bing/participating-engine URL notification.
- Daily Worker cron submits commercial/static pages only; customer proof pages remain `noindex` by default.
- Existing x402 Bazaar discovery metadata remains the primary machine-purchase path.

## Bootstrap rule

Agentic Market/Bazaar discovery may use external platform verification only when the platform funds its own verification call. One explicitly labeled project canary may be used only if a bootstrap remains necessary after every free publication surface is live; it must never be counted as customer revenue. Platform-funded verification likewise remains a technical settlement/treasury receipt but is never customer revenue.
