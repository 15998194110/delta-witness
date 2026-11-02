# Automation reliability candidate — 2026-11-03

This is a local candidate on top of the v1.1 repair branch. It has not been deployed to Cloudflare or merged into GitHub master. A successful local test, an existing green workflow, a submitted listing and an issued 402 are different evidence classes.

## Authority and responsibilities

| Authority | Responsibility | Evidence limit |
|---|---|---|
| Existing Core order/payment/proof records | Paid identity, settlement, delivery and recovery | A scheduler projection cannot change or replace these records. |
| Canonical Base USDC receipts | Treasury incoming transfers in an explicitly covered interval | Exclude project, canary and platform verification transfers; join to purpose, fulfillment, refunds and cost before recognizing customer margin. |
| Existing Watch ETag leases, quota, cursors and notification outbox | Prepaid checks and at-least-once notification recovery | No new lease takeover or generic business retry is introduced. |
| Existing GitHub Discovery Pulse | Read-only checks, Treasury interval reports, demand scans and eligible authorized maintenance | GitHub green alone does not prove complete reports, continuous historical coverage or notifications. |
| Existing Cloudflare Cron handlers | MeshKore, Watch and the existing indexing slot | These are not a complete acquisition, paid-order recovery or Treasury engine. |
| Hosted ChatGPT scheduled task | Bounded review of cloud evidence and meaningful reporting | Must be inspected in its own task UI; it is not the financial state store or continuous payment service. |
| Local Codex heartbeat | Optional local review assistance | It remains paused. Its update does not alter the hosted ChatGPT main task. |

The current pricing authority remains [the owner policy](../pricing-policy-2026-09-10.md). Preserve $1 Capture/partner/Watch check, $5 public Preflight, $10 Pilot and all previously settled obligations. No Treasury or payment credential changes are part of this candidate.

## Local changes

- `discovery-pulse.yml` retains the single canonical workflow and existing Treasury failure gates. Diagnostic lanes run independently after earlier failures; missing or invalid financial evidence is unverified, never zero. The always-run status report distinguishes individual results, canonical upload acknowledgement and unknown notification delivery.
- `pulse-status.mjs` projects allowlisted run metadata and validates report semantics. It is not a second ledger or a durable business checkpoint. Daily eligibility follows the triggering cron string, including delayed runs; it does not recover events GitHub never delivered. Independent task start/last-success monitoring remains a release prerequisite.
- The daily maintenance configuration must migrate existing authorized channel operations before deployment. Missing configuration must not silently disable previously lawful automation and be described as restored. Configuration approval is durable, not an approval prompt per order. Manual/push diagnostic runs do not automatically register or contact anyone.
- Treasury observations disclose per-interval RPC sources and failover. Optional finalized-header observation is diagnostic only; it does not change checkpoint schema, amounts, dedupe, cursor, twelve-confirmation policy or establish economic finality.
- Cloudflare lane deadlines, sanitized outcomes and private optional observations are described in [the Cron candidate](cloudflare-scheduled-observation-local.md). Persistence is off unless separately enabled; no cleanup or proof-retention change is installed.
- [The bounded ChatGPT reporting prompt](chatgpt-report-task.md) is prepared for the existing main task. Saving this file is not evidence that the hosted prompt, enabled state or next run changed.

## Required release checks

1. Authenticate Cloudflare with the owner's provider OAuth flow. Read back deployed version, both real Cron triggers, invocation outcomes and existing bindings without exporting credentials.
2. Inspect the existing hosted ChatGPT main task, its actual enabled state, error, recent run and next run. Apply the prepared reporting prompt to that same task only after its identity/state can be verified; test actual result persistence and notification delivery.
3. Review the aggregate v1.1 changes against current remote master; do not ship the whole unpublished repair branch as an incidental prompt update. Preserve any current production drift and original data/policy.
4. Migrate maintenance authorization and approve any persistent observation budget/retention policy. Verify live $1/$5/$10 challenges and existing prepaid recovery without new signing or owner-funded purchases.
5. Run provider-level fault/isolation/recovery acceptance on the exact release, including interrupted settled orders, original historical records and notification acknowledgements. Local mocks cannot certify those provider effects.

No production deployment, live data migration, money movement, proof deletion, new scheduler, outreach or automated task activation was performed by these local changes.
