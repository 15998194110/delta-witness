# DELTA Treasury and cost audit

Reviewed 2026-11-04, candidate descended from `b20f1b1`. This document supersedes no historical receipt and creates no second balance ledger. Final candidate commit/build/test identity is recorded in [GO/NO-GO](DELTA_FINAL_GO_NO_GO.md).

## Authority and observed status

Canonical scope is Base `eip155:8453`, USDC `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`, receive-only Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367`. No signing key, owner payment, token movement, refund or production data mutation was used in this audit.

The [Treasury scanner](scripts/treasury-reconciliation.mjs) supplies receipt candidates; [Core accounting](src/accounting.ts) joins original settlement/payment identity, delivery and Treasury receipt; [financial evidence](src/financial-evidence.ts) qualifies selected external audit sources. Quote, 402, listing, authorization, provider acceptance, settlement, receipt, fulfilled use, recognized revenue and margin remain separate fields. Independent customer purpose and refund completeness cannot be inferred from a wallet address or API success alone.

No fresh all-history production receipt reconciliation or complete provider invoice lines were acquired in this increment. Prior [P0 report](PRODUCTION_BLOCKER_CLOSURE_REPORT.md) and private `../DELTA-financial-evidence-20261104/real-notice-receipt-2.json` preserve the real Cloudflare invoice **notice**, not per-order actual cost. A later authenticated dashboard observation now establishes displayed account-level R2 costs for a completed period, as detailed below. It does not establish all-product or DELTA-allocated actual costs. Actual aggregate customer revenue/cost/margin remain UNKNOWN until matched evidence exists; this is not an all-time zero-income claim.

### Post-login update

[2026-11-04 readback](docs/repair/cloudflare-readonly-20261104.md) verifies D1/R2 inventory and two complete legacy fulfillments. Existing PayAPI classification excludes both historical 0.03-USDC platform probes from customer revenue. No fresh all-history chain reconciliation was performed. Billing/history, billable-usage and billable-usage/info returned 403/10000 with the working OAuth; those last observed API errors were not retried or resolved by changing permissions. Successful dashboard access below is an alternative read source, not proof of Billing Read API permission. D1's 0002 migration was absent in the readback and was not applied.

### Authenticated billing UI update - 2026-11-04

The existing external Edge Cloudflare session successfully returned subscriptions, invoice-list and Billable Usage tables. This supersedes the earlier browser-unavailable conclusion for this observation; no new login or permission expansion occurred. [Structured UI evidence](../DELTA-release-approval-20261104/DELIVERY-CLOSURE-20261104/billing-ui-observation-20261104T134054Z.json) and [scope/gaps](../DELTA-release-approval-20261104/DELIVERY-CLOSURE-20261104/billing-ui-observation-20261104T134054Z.md) identify the actual root-session `mcp__cua_repl.js` tool observations. They are recorded UI observations, **not** original provider exports or downloaded invoice PDFs; exact source observation time was not supplied, so only the date and separate record-generation timestamp are retained.

- Subscriptions: Workers **Free / Active**, R2 **Paid**. Neither label proves complete charges or resource allocation.
- Invoice list: **IN-86438205**, 2026-10-30, **USD 0.00 / Paid**; **IN-81598148**, 2026-09-30, **USD 0.00 / Paid**. Downloads did not yield a verified file; invoice line items remain unavailable.
- Completed **October 2026** billing view (**Sep 30-Oct 29**): R2 storage **0 GB-months**, Class A **8.82k**, Class B **7.25k**. Each displays billable quantity **0** and cost **USD 0.00**, with cycle cost **USD 0.00** and usage included in tiers. This establishes displayed **actual account-level R2 cost** for that completed period, not merely a notice amount due.
- Open **November 2026** view (**Oct 30-Nov 29**, observed usage **Oct 30-Nov 4**): storage **0 GB-months**, Class A **960**, Class B **1.21k**, displayed billable quantities/costs **0**. Current/projected USD 0.00 is **not a final November invoice**.

Both Select All controls were exercised, but the visible scope remained **one family / three products (R2)**. All-product coverage is therefore unverified. Storage and abbreviated usage are kept at displayed precision: 0 GB-months does not prove zero stored bytes, and 8.82k/7.25k/1.21k are not asserted as exact operation counts. The account view has no DELTA resource/order allocation or complete facilitator/refund coverage. DELTA-only actual cost, total actual cost and contribution margin remain **UNKNOWN**; financial recognition and the automatic source verifier were not activated by this UI observation.

## Treasury controls and residual scope

| Risk | Existing implementation and actual test evidence |
|---|---|
| Interrupted incremental scan | [CLI](scripts/reconcile-treasury.mjs) requires explicit original start for initial continuous state; immutable CAS [checkpoint store](scripts/treasury-checkpoint-store.mjs), [local store](scripts/treasury-checkpoint.mjs), [Core custody](src/treasury-custody.ts). Unknown write ACK is not cursor success. |
| RPC outage/rate limit/body timeout | Bounded requests, provider cooldown/fallback and diagnostics; [continuity tests](tests/treasury-continuity.test.mjs), [observability tests](tests/treasury-observability.test.mjs). Credentials in RPC URL paths/query are not reported. |
| Conflicting chain views/reorg | Re-read retained anchor, chunk boundary and receipt block hashes. Unchanged block with changed/missing receipt fails closed; overlap corrections retained. Reorg beyond anchor stops rather than erasing old evidence. |
| Duplicate receipt | Identity includes network, asset, transaction hash and log index; conflicting same identity rejected; one receipt cannot be silently matched to two orders. |
| Partial coverage | Exact origin/from/through/gap and provider sources recorded. Window mode and continuous mode distinguished; history before origin unverified; all_time_reconciled is false. |
| Finality | Confirmation-depth policy is explicit. Optional finalized header is provider-reported diagnostic, **not consensus/economic finality**. Production must qualify its accepted confirmation policy and original floor; a single provider claim is not finality proof. |
| Platform/self-test | Known platform payers excluded; unknown payer remains unclassified. Independent purpose still needs evidence even if amount equals formal price. |
| Capacity | 50,000 retained transfers / 10,000 corrections and revision limits fail visibly. Archive/compaction preserving digest chain is a future operational procedure before capacity, not automatic truncation. |

Core [accounting tests](tests/accounting.test.ts), [Pilot tests](tests/pilot-accounting.test.ts) and [prepaid view](src/accounting.ts) keep Pilot's children from becoming separate revenue and Watch consumed credit from becoming a second purchase. Partner platform billing assertions are not Treasury cash. Watch entitlement and platform payout evidence need their own original registration/transaction linkage.

## Actual cost and expansion gate

| Cost/source | Adapter or authority | Current assurance |
|---|---|---|
| Workers / Browser / D1 | Fixed-account Cloudflare Billing read adapter; original usage/manifest; provider bill lines needed | OAuth billing API last observed 403. Working UI currently shows only R2; other-product actual costs remain UNKNOWN. Model remains estimated. |
| R2 account-level completed period | Authenticated October 2026 dashboard view, Sep 30-Oct 29; linked UI evidence above | Actual displayed cost USD 0.00 and included-tier usage observed. Account scope and UI precision only; no verified invoice PDF or exact usage export. November view remains open, not final. |
| DELTA R2 reads/storage retention | Original purchased retention policy and model in [pricing](src/pricing.ts); resource/period/order allocation still needed | DELTA-attributed actual cost UNKNOWN. Account-level free-tier coverage cannot be assigned to an order without allocation; hold/overdue deletion and download usage can extend costs. |
| Queues / Durable Objects | Actual resource inventory/bill required before cost attribution | Not inferred from architecture labels or empty config. UNKNOWN until account inventory confirms use/non-use. |
| Facilitator | Original settled transaction + provider fee statement/contract | Fixed estimate never becomes actual fee. UNKNOWN. |
| Monitor / email / support / acquisition | Provider bill and an explicit expense-pool allocation | Free plan or absent bill does not self-certify zero. UNKNOWN. |
| Refunds/credits/liabilities | Original unique refund evidence, payout statement and complete coverage | No auto-refund executor invoked. Missing refund coverage keeps recognized amount unknown. |

The financial view now exposes `expansion_gate`, bound to the existing `accounting_view_hash`. It reports a proved negative selected-order margin as `block_negative_margin`; unknown economics, synthetic inputs, zero margin or incomplete inventory keep `hold`. Even positive selected-order economics do not authorize system-wide scaling, spending, pricing changes or cancellation of prepaid obligations. This gate is read-only and never blocks recovery of an already-paid order.

External source approval binds exact audit digest **and** its uniquely resolved support graph. A local JSON assertion cannot verify its own buyer purpose, fee/refund coverage or invoice. The production source verifier remains absent until real source contracts exist. USD amounts are preserved in source currency; conversion to raw USDC requires auditable FX and allocation. [Financial contract](docs/repair/financial-evidence-contract.md) defines minimum source permissions and bounded joins.

## Validation and release conditions

`../DELTA-cloud-operations-20261103/FINAL-finance-security-2.json` records **223 passing isolated cases across nine security/payment/Watch-notification/Treasury/accounting/scanner suites**, source stable, log SHA256 `1f833f7c05b4e182f3afedfa7a5acbddd45ea2ba790f9da42c81d71f22ee2c60`. The earlier `FINAL-finance-security-1.json` recorded 219 pass but had concurrent source edits; it is preserved as intermediate evidence, not candidate qualification. Final frozen-tree test/build evidence belongs to the integrated GO/NO-GO manifest. The negative-margin regression verifies that the view neither writes the bucket, starts Browser, reprices nor authorizes payment. [Security audit](DELTA_SECURITY_AUDIT.md) records the upgraded dependency locks, later adapter checks and remaining provider/browser resource guarantees; npm audit success is not financial verification.

Production prerequisites: read-only account access; original Treasury checkpoint/floor and accepted chain confirmation policy; actual bill/service lines and expense/refund coverage; source-verifier qualification; same-order production inventory and evidence readback. No owner per-order approval is introduced. Cost UNKNOWN is an honest operational state and blocks claims of verified positive contribution margin or expansion, not preservation of customer liabilities.
