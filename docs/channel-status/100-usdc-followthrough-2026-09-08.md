# 100 USDC follow-through — 2026-09-08

This is an evidence checkpoint and documentation-only follow-through, not a replacement for the main Commercial Operator's sprint/pipeline files and not a new growth loop. Goal: 100 USDC of reconciled, non-test customer receipts, with verified positive contribution margin tracked separately. The owner's stricter fulfilled-net sprint metric remains authoritative for that sprint.

## Reviewed existing execution evidence

The existing read-only reconciliation workflow completed on 2026-09-08 at 10:32 UTC (18:32 Asia/Shanghai). This follow-through read its actual job logs; it did not launch another audit or deployment.

- Run: https://github.com/15998194110/delta-witness/actions/runs/34215977034
- Job: https://github.com/15998194110/delta-witness/actions/runs/34215977034/job/102027687237
- Executed source: `b79e33214b01eb146e3e0373a808a810a0fa2c6e`.
- Canonical Base USDC filter: contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, Transfer destination Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367`.
- Actual log result: `{"treasury_scan":{"from_block":51036340,"head_block":51037097,"incoming_count":0,"incoming":[]}}`.
- This extends the previous recorded scan through block 51036339 in `toll402-2026-09-08.md`; it is not a claim about blocks after 51037097.
- D1 query: all telemetry events with `created_at >= '2026-09-08 10:12:00'`, ordered by id. The successful read-only response returned ids 4539–4554: one `page_view` and fifteen `payment_required` rows (Capture 6, public Preflight 4, Pilot 5), all channel `direct`, partner `none`. No `qualified_request`, `payment_verified` or `capture_completed` rows appeared in this interval. `rows_written=0`, `changed_db=false`.
- These challenge rows may include operator or directory probes. They are not fifteen customers or qualified buying intents. Their `gross_usd` fields are asking prices, not receipts. No new settlement, Treasury receipt or customer revenue is recognized from this checkpoint. Buyer-side authorizations are not independently observable from these logs.

## Accounting correction

Read root `AGENTS.md` and `docs/preflight-price-experiment-2026-09-08.md` before using older ledger rows. The historical `growth-ledger.md` claim that the old 0.03 mandate superseded the approved public 1 USDC price is obsolete; do not restore that rollback.

The historical 0.03 USDC receipt remains a classification/reconciliation item for the main sprint, not an already-audited net-profit figure. Its recorded transaction is `0x5ae76f54c158d24f03b86aed0a20482e8de2a35983941c03fe60d131c19cd7b3`. This follow-through did not revalidate that historical transaction/payer independently. The older telemetry cost `0.002163522555` and contribution `0.027836477445` are estimates, not verified actual fees/net cash. Do not promote them to realized profit or declare repeatable customer demand. Do not erase the historical receipt either: retain it pending payer/test exclusion, fulfillment and actual-cost reconciliation under the owner authority.

`value_authored`, `payment_authorized`, `settlement_confirmed` and `treasury_received` stay separate. Directory-funded verification calls must be labelled as verification/test receipts rather than organic repeatable customer demand. Unknown costs and attribution remain unknown, not zero.

## Existing opportunities: no duplicate outreach or registration

TOLL402 was already submitted by the main Operator and accepted for review via HTTP 200 `{"ok":true}`; evidence is `docs/channel-status/toll402-2026-09-08.md`, committed in `15aadd1eb9b373be659edeccb6d0aec9525baf6a`. Do not call this a live/verified listing or payment, and do not resubmit. The next scheduled review is no earlier than September 9 evening Asia/Shanghai unless a genuine review/payment event arrives.

The existing Agent402 email thread was read through the owner's 10:12:23 UTC acknowledgment of the price correction. The incoming responses explicitly disclose AI-agent authorship; do not count those messages as verified new human integration interest. No additional reply was necessary. The scoped inbox review found no new qualifying integration acceptance, and this follow-through sent no email. The shared Operator's existing September 8 cold-outreach allowance was not reset by changing timezone.

## Actual change made in this follow-through

Updated only `packages/js-client/README.md` to connect the already-existing free `quote/preflightChallenge` methods to `preflightWithPaidFetch` and `captureWithPaidFetch`, with an explicit buyer-supplied x402 adapter, fresh-challenge approval, wallet-side spending controls, error/retry cautions, public-page limitations, and proof-versus-settlement separation. Commit: `3e12455b3dfecc6c9a3b36c4dca8fd90ad3c58e4`.

The original client source was copied exactly into an offline test harness and matched Git blob `bafdc5ff7462212ad31e4ead76b0264cb1c339c7`. Four Node mock tests passed: preflight quote routing, unsigned 402 challenge behavior, paid-fetch request/body delegation, and rejection of missing adapters/non-success fulfillment responses. These tests did not sign, pay, execute a production browser, or prove live end-to-end settlement.

This is a GitHub documentation change, not a newly published npm release. No increase in downloads, external API requests, paying customers or revenue is attributed to it. The previous 266-download observation was not reverified in this follow-through. Runtime code, prices, Treasury, secrets, workflow schedules and production deployment were not changed. No new identity, registration, paid canary, wallet signature, advertising purchase or reinvestment was performed.

The conversion priority is existing installed/routed users reaching an authorized paid observation and useful delivered proof, then a second independent customer or repeat paid use. More listings without that evidence do not advance the 100 USDC goal.
