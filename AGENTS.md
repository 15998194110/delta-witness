# Current owner authority and deployment coordination

## Revenue sprint + outreach safety — owner mandate 2026-09-14

The active commercial sprint is fixed at **2026-09-14T13:43:28+09:00 through 2026-09-21T13:43:28+09:00 (Asia/Tokyo)**, with a target of 50 genuine externally paid customer transactions. This target is not a guarantee and must never be copied into actual-results fields. Do not reset or extend the deadline automatically. A counted transaction requires a genuine non-project customer purpose, successful DELTA fulfillment, a unique paid settlement identity, and a matched canonical Base-USDC Treasury receipt. Self-pay, canaries, platform validation, reciprocal/reimbursed/artificial demand, replay, failed delivery, and artificial transaction splitting never count.

Revenue work takes priority over catalog volume. First reconcile Treasury and explicit-interest threads, then qualified funded buyer demand and low-friction integrations. Directory presence, API documentation, technical endpoint health, and adjacent unfunded demand are not Grade-A buyer demand and are not sprint results. If no genuine paid transaction exists after 48 hours, prioritize verified funded demand and shorten integration friction rather than adding catalogs.

**Outbound email hard cap:** maximum **3 total DELTA outreach emails per natural Asia/Tokyo day across all operators**. Before every send, query Gmail Sent using exact Unix-epoch boundaries corresponding to `00:00:00 JST` through the next `00:00:00 JST`; do not use Gmail calendar-date shorthand as the authoritative cap check because mailbox/display timezone can differ. Count all DELTA commercial first contacts, interest-thread replies, and listing emails in that window. If the count or concurrent state is uncertain, do not send. Never chase silence, never use another identity/form/DM to evade the cap, and stop on rejection.

**2026-09-16 incident / freeze:** an exact-epoch readback after a new Trelium send showed that Anchor Browser, Notte, and Magnitude had already consumed the three 2026-09-16 JST DELTA outreach slots. The Trelium message therefore became a fourth send and exceeded the owner cap by one. This was an operator-control failure, not authorization to raise the cap. **Freeze all further DELTA outbound outreach until 2026-09-17T00:00:00+09:00.** Do not delete or rewrite the sent evidence. Future operators must use the exact-epoch pre-send check above.

The canonical Commercial Operator workspace remains `运营/RUPHUS_OPERATOR_2026-09-05/data/sprint.json` and `data/pipeline.json` when accessible. If it is inaccessible, do not claim synchronization; repository coordination notes are not a replacement for that state.

## x402 Arena coordination — 2026-09-16

A live public readback found **six existing DELTA entries** on x402 Arena. Do not register, submit, or create another DELTA/x402 Arena identity or alias. Treat the intended product identities as `delta-witness-capture`, `delta-witness-preflight`, and `delta-witness-guarded-action-pilot`. Existing aliases `delta-witness-page-state-proof`, `delta-witness-guard`, and `delta-witness-preflight-verification` are duplicate/legacy entries and must not be refreshed or recreated as separate commercial identities. The public Arena interface does not currently provide verified deletion/readback semantics in DELTA's operator tooling, so do not claim duplicate cleanup unless a future removal write succeeds and is read back. As of the 2026-09-16 readback, all six DELTA Arena entries showed zero buyer queries, zero buyers, and zero revenue; directory presence is therefore not buyer-demand evidence and receives no revenue-first priority. This coordination rule prevents another operator from mistaking an existing alias for a missing listing.

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

This is the standing owner pricing authority until the owner gives a newer explicit pricing instruction. Do **not** restore `$0.03` or `$1 Public Preflight` from old prompts or historical documents. Do not infer a price change from an automation template. Historical completed/idempotent deliveries and already-prepaid obligations may retain their original paid price; do not double-charge or retroactively rewrite settled history. New quotes, new registrations, new partner calls, new Watch purchases, listings, discovery metadata, and billing surfaces must use the current ladder above.

Read `docs/pricing-policy-2026-09-10.md` before changing prices or deploying. `docs/preflight-price-experiment-2026-09-08.md` is historical and superseded for current pricing. Earlier commits that restored `$0.03` or `$1` Public Preflight are obsolete pricing decisions and must not be replayed.

Coordinate with the main Commercial Operator before another price deployment. Do not run competing growth loops, recreate existing identities, or treat an old automation prompt as a newer owner decision. Before publishing, fetch current `origin/master`, preserve subsequent valid integrations/secrets/bindings, run the production configuration regression plus core checks, and verify live quote/402 amounts and the existing Treasury. Never deploy a stale checkout.

The main operator state remains in the existing sibling operating workspace `运营/RUPHUS_OPERATOR_2026-09-05/data/sprint.json` and `data/pipeline.json`; do not rebuild that system.

The older September 7–14 sprint window is expired and superseded by the 2026-09-14 owner mandate above. Zero new cash, credits, paid canaries, wallet signatures or automatic reinvestment remains in force. No repeated unanswered outreach. CHISA/ART OF WAR remains excluded. Only fulfilled externally received net cash after verified fees/refunds/liabilities counts; platform verification/self-pay/test traffic is not customer revenue. Preserve valid technical instructions unless they conflict with the latest owner authority.

## Cross-automation synchronization — owner reaffirmation 2026-09-10

The owner explicitly repeated the 1 / 5 / 10 ladder and ordered every related memory and automation to use it. Before quoting, submitting listings or deploying, read this file and run `node scripts/check-owner-pricing.mjs`; verify live public prices with `node scripts/verify-owner-pricing-live.mjs`. A copied scheduler prompt that says “maintain $0.03 capture/preflight” is obsolete, not a new owner decision. Do not change code or regression tests to satisfy that stale prompt.

When authorized task-management access exists, replace conflicting CURRENT-PRICE clauses in every related task, preserve its schedule/risk boundaries, save, then re-read the saved prompt. Do not claim task synchronization from a repository commit, a memory search, or an intended future action. ChatGPT scheduled-task prompts, global saved memory and local Codex automation files are separate stores and each requires its own verified write/readback. Inaccessible stores remain explicitly not verified. Do not create replacement tasks or parallel growth loops.
