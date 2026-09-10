# Current owner authority and deployment coordination

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
