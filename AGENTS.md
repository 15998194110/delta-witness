# Current owner authority and deployment coordination

## Owner reaffirmation — 2026-09-11: current-price-only execution and reporting

The owner explicitly instructed that obsolete pricing must not reappear. This reaffirms the current ladder; it does not authorize a new price change or any expansion of financial authority.

- All newly authored quotes, listing submissions/updates, commercial examples, outreach and owner-facing pricing summaries must use only the current authorized prices: Public Capture = $1.00 USDC; authenticated Partner Capture = $1.00; authenticated Partner Preflight = $1.00; each new Watch check = $1.00; Public Preflight = $5.00; Guarded-Action Pilot = $10.00. An obsolete prompt, cached directory record or historical report must never supply current pricing.
- Do not restate obsolete numerical prices in routine owner updates, including repeated explanations of external catalog drift. When a material update actually needs to mention an unresolved external listing, use "目录待同步" / "catalog refresh pending" and state the current authorized price only. A readback failure or unresolved cache must not be described as corrected.
- Do not repeatedly notify the owner about already-known stale listings or historical non-customer transfers. Neither is a new development. Preserve the existing material-event notification thresholds and remain silent otherwise.
- Exact historical settlement amounts, original receipts, exclusions and regression fixtures must remain intact in audit evidence. Do not delete, rewrite, reprice or double-charge them. Routine summaries may say "历史非客户款，已排除" without repeating the historical amount. Exact historical amounts may be surfaced when the owner explicitly requests an audit or when necessary to explain a genuinely new, material financial/security event.
- Before a price-bearing external write, read the pricing policy, run the existing owner-pricing checks, and verify live public challenge amounts as 1000000 / 5000000 / 10000000 raw canonical Base USDC with the unchanged Treasury and network. Block the affected write on a mismatch; do not alter the authorized ladder to satisfy a stale source. Keep Treasury reconciliation independent of external-channel health.
- This repository rule is not evidence that ChatGPT task prompts, saved memory, local Codex automation files or third-party catalogs were edited. Report synchronization only for stores that have an actual successful write and readback.

## Highest-priority pricing authority — 2026-09-10

The owner's latest explicit instruction supersedes every earlier DELTA pricing mandate, copied automation prompt, experiment note, cached listing price, or assistant/operator interpretation.

For **all new billable requests after this policy takes effect**, the authorized pricing ladder is:

- **$1.00 USDC — entry layer:** Public Capture.
- **$1.00 USDC — partner/watch entry layer:** authenticated Partner Capture, authenticated Partner Preflight, and each new Watch check.
- **$5.00 USDC — standard verification layer:** Public Preflight.
- **$10.00 USDC — high-value execution layer:** Guarded-Action Pilot.

This is the standing owner pricing authority until the owner gives a newer explicit pricing instruction. Do **not** restore `$0.03` or `$1` Public Preflight from old prompts or historical documents. Do not infer a price change from an automation template. Historical completed/idempotent deliveries and already-prepaid obligations may retain their original paid price; do not double-charge or retroactively rewrite settled history. New quotes, new registrations, new partner calls, new Watch purchases, listings, discovery metadata, and billing surfaces must use the current ladder above.

Read `docs/pricing-policy-2026-09-10.md` before changing prices or deploying. `docs/preflight-price-experiment-2026-09-08.md` is historical and superseded for current pricing. Earlier commits that restored `$0.03` or `$1` Public Preflight are obsolete pricing decisions and must not be replayed.

Coordinate with the main Commercial Operator before another price deployment. Do not run competing growth loops, recreate existing identities, or treat an old automation prompt as a newer owner decision. Before publishing, fetch current `origin/master`, preserve subsequent valid integrations/secrets/bindings, run the production configuration regression plus core checks, and verify live quote/402 amounts and the existing Treasury. Never deploy a stale checkout.

The main operator state remains in the existing sibling operating workspace `运营/RUPHUS_OPERATOR_2026-09-05/data/sprint.json` and `data/pipeline.json`; do not rebuild that system.

Fixed sprint: September 7 03:01:23 through September 14 03:01:23 Asia/Shanghai. Zero new cash, credits, paid canaries, wallet signatures or automatic reinvestment. No repeated unanswered outreach. CHISA/ART OF WAR remains excluded. Only fulfilled externally received net cash after verified fees/refunds/liabilities counts; platform verification/self-pay/test traffic is not customer revenue. Preserve valid technical instructions unless they conflict with this latest owner authority.

## Cross-automation synchronization — owner reaffirmation 2026-09-10

The owner explicitly repeated the 1 / 5 / 10 ladder and ordered every related memory and automation to use it. Before quoting, submitting listings or deploying, read this file and run `node scripts/check-owner-pricing.mjs`; verify live public prices with `node scripts/verify-owner-pricing-live.mjs`. A copied scheduler prompt that says “maintain $0.03 capture/preflight” is obsolete, not a new owner decision. Do not change code or regression tests to satisfy that stale prompt.

When authorized task-management access exists, replace conflicting CURRENT-PRICE clauses in every related task, preserve its schedule/risk boundaries, save, then re-read the saved prompt. Do not claim task synchronization from a repository commit, a memory search, or an intended future action. ChatGPT scheduled-task prompts, global saved memory and local Codex automation files are separate stores and each requires its own verified write/readback. Inaccessible stores remain explicitly not verified. Do not create replacement tasks or parallel growth loops.
