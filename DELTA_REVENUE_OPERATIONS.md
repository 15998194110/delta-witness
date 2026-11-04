# DELTA revenue operations

Reviewed 2026-11-04. Status: local operating contracts prepared; current independent paid customer, recurring workflow and actual positive margin **not validated**. The 50,000-USDC target is a goal, not revenue or a promise. [Final gate decision](DELTA_FINAL_GO_NO_GO.md) controls activation.

## One Core and one business authority

Capture/Preflight/Pilot remain the existing Core. MCP, SDKs, Pages and partner adapters remain thin consumers. Existing Discovery Pulse is the diagnostic/demand-scan workflow; Cloudflare is the original paid-recovery/Watch execution plane. A new seller, growth loop, buyer identity or ChatGPT-dependent scheduler is not created.

The original canonical operator files were actually read at `C:/Users/10122/Documents/ChatGPT/运营/RUPHUS_OPERATOR_2026-09-05/data/`. Their hashes still match the prior [operator-contract audit](docs/repair/2026-11-02-business-operator-contract.md):

| File | SHA256 | Interpretation |
|---|---|---|
| `pipeline.json` | `77b847a0c8297bdebc5b12ac4791bac926628560bb4d1adc6513b27ef2fd99e0` | Four historical opportunities and a suppression list; last modified 2026-09-13. STALE for current demand. |
| `sprint.json` | `b44b3c5ebce0e8e6204735b19516b78103673031729ee760df168017bfe92040` | Historical closed sprint; not a current revenue ledger or authority to restart it. |

Neither file was modified. No customer contact data was copied into this repository. [Operator coordination](scripts/operator-coordination.mjs) preserves the original file and unknown fields, uses same-target/domain action identity, and refuses duplicate/unknown sends without original provider readback. Production writers must all adopt the same claim boundary before activation; an old script writing the file directly is not safe concurrent coordination. Gmail SENT and suppression evidence must be rechecked through approved read-only adapters. No outreach was sent here.

## Prices and buying path

| New request | Authorized price |
|---|---:|
| Public Capture | 1 USDC |
| Public Preflight | 5 USDC |
| Guarded-Action Pilot | 10 USDC |
| Partner Capture / Preflight | 1 USDC |
| New Watch check | 1 USDC |

[Owner policy](docs/pricing-policy-2026-09-10.md) stays authoritative. Historical settled and prepaid promises retain original facts. A paid buyer does not need a new owner approval for each legitimate eligible invocation. A buyer's own spend limits/signature rules remain binding.

For procurement/browser/workflow agents the decision is factual: preserve a public source immediately before a consequential action; use Preflight when deterministic expected content/hash comparison matters; a negative condition is a valid delivered observation, not permission to execute the buyer's consequential action. Output does not assert source truth. Agent schema and price must describe the actual POST route; acceptance requires current machine readback and an independently funded caller, not a directory screenshot.

## Commercial evidence and conservative scanning

Stage authority: discovered listing → current qualified need → declared budget → independently verified funding/authorization → original payment authorization → settlement → original proof delivery → canonical Treasury receipt → refund-adjusted recognized customer revenue → actual contribution margin. Adjacent research/code-build requests are not fulfilled by existing DELTA products. A stated budget alone is not spend authorization.

[Existing funded-demand scanner](scripts/scan-external-funded-demand.mjs) now bounds each read at 15 seconds / 2 MB, refuses redirects, caps retries at three, uses bounded iterative object traversal instead of recursive unbounded descent, and returns per-channel degradation independently. Importing the module is inert. Partial/failed inventory sets aggregate totals to null, preserving the observed subset separately. An official API inventory response is marked **observed provider claim**, not independently verified escrow/buyer budget. These changes avoid both scanner exhaustion and false zero/success reporting. Tests: [funded-demand boundaries](tests/funded-demand-boundaries.test.mjs).

Old marketplace price/method records are historical snapshots. No external registration/update or blanket recrawl was performed. Before eventual activation, inspect existing canonical listings, derive first-party prices from Core quotes, and refresh only the existing authorized identity. Unsupported/free-of-buyer-budget platforms stay deprioritized; Apify/channel expansion waits for actual net payout/fees. No provider signature/payment/claim was attempted.

## Execution priority and recovery

1. Preserve and reconcile settlement-unknown and paid-undelivered obligations; recover original proof where available. Missing historical observations enter explicit remediation responsibility, never forged fulfillment or a second charge.
2. Maintain Treasury continuity and account evidence, independently of directory outages. Reconcile original incoming receipts, fees, refunds and known exclusions before recognizing revenue.
3. Process explicit-interest existing threads within original authorization and suppression rules. One first contact per target; no chasing silence, mass spam or alternate identity to evade rejection. Uncertain send outcome requires original provider readback.
4. Inspect existing high-intent buyer feeds; qualify public source fit, freshness, concrete budget evidence, authorized machine payment and expected positive economics. Do not claim/bid on pay-to-work or signed-wallet routes without exact authority.
5. Monitor outcomes on the same original order/payment identity, identify genuine repeat uses, and persist per-channel evidence. Do not count repeated retries/child proofs/prepaid uses as new purchases.

Actual expense review uses [financial evidence](src/financial-evidence.ts) `expansion_gate`. UNKNOWN or negative actual contribution margin holds expansion. A positive selected subset cannot certify global inventory or erase old liabilities. Existing paid recovery continues regardless of this gate.

## Growth milestones and practical boundary

| Milestone | Required evidence | Does not qualify |
|---|---|---|
| First independent customer | Independent source/purpose; unique original payment; verified fulfillment; Treasury receipt; actual cost allocation and positive margin | Project canary, platform validation, reimbursed/self-generated purchase, 402 |
| Same workflow repeats ten times | Ten real paid uses with unique payment/service identities and legitimate repeated need | Artificially split orders or replay |
| Second independent host | Another genuine integration reuses Core and its own authorized buyer budget | Another seller alias or duplicate registry entry |
| Sustained Partner / Watch | Actual prepaid money/platform billing evidence plus finite entitlement, payout and obligation accounting | Server billing assertion alone or unlimited free polling |

Current Watch finite quota and idempotent slot/outbox tests exist; Partner/Apify original-business billing coordination exists locally. They do not prove real platform deposit/payout or buyer identity provenance. See [Watch/partner audit](docs/repair/2026-11-02-watch-partner-results.md), [business correlation](tests/business-correlation.test.ts) and [accounting audit](DELTA_TREASURY_AND_COST_AUDIT.md).

Runtime, buyer pipeline, finance and alert panels must each show source/time/scope and UNKNOWN/STALE independently. No new customer or positive margin is inferred from this local report. Remaining external actions are consolidated in [owner actions](DELTA_OWNER_ACTIONS.md); this document does not start a campaign, change price or activate a scheduler.
