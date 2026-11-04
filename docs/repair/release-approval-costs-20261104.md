# Release approval: cost evidence and minimum billing access

Observed 2026-11-04. Reviewed local candidate `46f7200f211f44f8e47f5a1fb36b6d4abbd78e55`; this report does not qualify a later edited tree. Status: **LOCAL REVIEW COMPLETE / EXTERNAL COST SOURCE BLOCKED / PRODUCTION NOT DEPLOYED**.

## Decision

Billing access and actual order-cost attribution are not closed. Existing Cloudflare login works for the resource readback, but three billing reads were denied. Two authentic invoice notices are now corroborated; neither provides service-level charges or DELTA allocation. Actual variable cost and actual contribution margin remain **UNKNOWN**, not zero. No price, Treasury, subscription, permission, credential, production resource or accounting entry was changed. No previously denied API was repeatedly retried.

## Evidence collected and its limits

| Evidence | Observation | What it establishes |
|---|---|---|
| [Original billing-history read](../../../DELTA-cloud-readonly-20261104-1/billing-history.json) | 2026-11-04 06:07:39Z; HTTP 403, error 10000 | This credential did not read account billing history. It does not establish expired login or the unique reason for denial. |
| [Usage read](../../../DELTA-cloud-readonly-20261104-1/billable-usage.json) and [period info](../../../DELTA-cloud-readonly-20261104-1/billing-period-info.json) | 2026-11-04 06:14:24Z; both 403/10000 | No rated usage or billing-cycle response acquired. Empty local results are not zero provider charges. |
| Gmail notice IN-81598148 | Issued 2026-09-30 15:29:20Z; official notify.cloudflare.com; DKIM/DMARC pass; USD 0.00 amount due | Invoice notification exists. No attachment or service-cost allocation. |
| Gmail notice IN-86438205 | Issued 2026-10-30 14:05:56Z; same authenticated sender; USD 0.00 amount due | Corroborates prior [notice anchor](../../../DELTA-financial-evidence-20261104/REAL_INVOICE_NOTICE_ANCHOR_1.json). It is not an invoice subtotal or proof that all costs were zero. |
| [Previous import receipt](../../../DELTA-financial-evidence-20261104/real-notice-receipt-2.json) | Source retained; provider verification and financial recognition both false | Receipt preserves evidence custody, not a verified cost recognition. |
| External browser inspection | Computer Use stopped before any UI input because it could not reliably determine the Windows browser URL | Billing page could not be safely inspected through this tool. This is a tool restriction, not evidence of Cloudflare logout or unavailable invoices. |

The precise Gmail search covered 2026-08-01 through 2026-11-04 and returned four messages, including two invoice notices and two product announcements; no further results and no invoice attachments. Only metadata and safe summary fields were retained. No raw message body, invoice access URL, billing address, payment method, secret or customer content was copied.

[Redacted observation](../../../DELTA-release-approval-20261104/billing-readonly-evidence.json) and [SHA256 manifest](../../../DELTA-release-approval-20261104/billing-source-hashes.json) bind six source files. A digest proves which local artifact was reviewed; it does not independently attest provider completeness.

## Minimum authorization, verified against current official documentation

1. Account Billing History is exactly `GET /accounts/{account_id}/billing/history`. Its documentation explicitly accepts **Billing Read** or Billing Write. Use **Billing Read** only. This returns account billing events, not necessarily service line items or order allocation. [Official endpoint](https://developers.cloudflare.com/api/resources/billing/subresources/history/methods/list/).
2. **Billing Read is an Account permission**, scope `com.cloudflare.api.account`. The UI selection is Account → Billing → Read; restrict resources to the existing DELTA Cloudflare account. It is not User Billing, Workers Scripts Edit, D1 Edit, R2 Edit, or Account Settings Read. [Official permission catalog](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).
3. The documented usage v1 and usage-info endpoints remain Alpha. Their endpoint pages do not expose an explicit Accepted Permissions list in the documentation inspected. Do not promise that Billing Read alone guarantees account eligibility for these endpoints. A successful minimal-permission read or provider-supported dashboard data must prove access. [Usage API](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get_account_usage_v1/), [period info](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get_account_usage_info_v1/).
4. A dashboard **Billing role is not a read-only API permission**: it can pay balances and modify billing information. Do not grant this role as a substitute for a minimal token merely to fix 403. Existing authorized dashboard access may be used read-only. [Role capabilities](https://developers.cloudflare.com/billing/understand/billing-permissions/).

No new token was created or requested from the user in this subtask. There is no reason to repeat Wrangler login solely for the billing denial. Do not use a Global API Key or broaden deployment management rights.

## Auditable alternative requiring no privilege expansion

Use the owner's existing Cloudflare dashboard session, account → **Manage Account → Billing → Invoices and documents**, then the invoice download action. Record the original invoice identifier, currency, billed periods, service line quantities/amounts, taxes, credits and total. Keep the full private source outside the repository; retain an access-controlled original and a SHA256-linked redacted excerpt. [Official invoice download procedure](https://developers.cloudflare.com/billing/manage/invoices/).

Read **Billable Usage** for the corresponding completed billing period and current period, recording exact period/subscription/filter coverage and observed time. The dashboard requires Billing read, supports Pay-as-you-go accounts, and provides usage overage costs; fixed subscriptions are excluded. Thus it supplements, rather than replaces, invoices. No CSV export is claimed until actually observed. [Official usage dashboard](https://developers.cloudflare.com/billing/manage/billable-usage/).

This read was attempted through the computer-use skill but terminated by the browser URL safety check. A usable existing browser connection or owner-exported original invoice is the remaining input. Do not circumvent the browser check by extracting session cookies.

## What must still be joined before margin can be asserted

| Component | Evidence still missing | Current actual-cost state |
|---|---|---|
| Workers, Browser Run, D1, R2 | Rated provider lines plus product/resource usage and complete period coverage | UNKNOWN |
| Queues / Durable Objects, if used | Verified use/non-use and the associated bill/usage | UNKNOWN |
| Facilitator | Fee statement/contract and original settlement identity; zero must be supported | UNKNOWN |
| Independent monitor and notifications | Selected provider, actual plan/charges, covered period and allocation | UNKNOWN |
| Shared account allocation | Rule allocating costs to DELTA, excluding other workloads, using measured usage | UNKNOWN |
| USD/USDC conversion, credits/refunds | Retained currency; explicit auditable conversion and completeness | UNKNOWN |

The [existing collector](../../src/financial-evidence.ts) only preserves billing history; its result intentionally leaves invoice-line and actual-order verification false. [Financial source contract](financial-evidence-contract.md) and [Treasury/cost audit](../../DELTA_TREASURY_AND_COST_AUDIT.md) remain authoritative for joins. The current source-verifier gap is not solved by hand-authoring an “actual cost” JSON. Preserve provider detail and qualify source/allocation adapters against real records before enabling financial recognition.

Invoice totals and usage overages have different scopes. Account amounts cannot simply be assigned to one order; paid but unfulfilled obligations remain liabilities. Unknown costs hold expansion and positive-margin claims, while already-paid recovery obligations remain active. Formal prices remain 1 / 5 / 10 USDC.

## Single minimal owner action, only if existing read access remains inaccessible

Provide **one completed-period Cloudflare invoice PDF and its matching Billable Usage view**, saved to a private local evidence directory (not chat, not the repository), or make the already-authenticated external dashboard available through a supported browser connection. No new login, payment or subscription change is requested.

For sustained autonomous collection after that, a separately approved **single-account Billing Read** credential may be entered directly into the designated provider secret store by its owner. That is an optional collection route, not a demand for broader permissions or a guarantee that Alpha usage endpoints work. Codex then performs bounded readback, redaction, allocation and source qualification. If provider eligibility still denies usage, retain official invoice/dashboard exports as the evidence route and document freshness; do not claim continuous collection.

## Acceptance and release consequence

- Completed locally: permission/endpoint verification, historical evidence reconciliation, two real authenticated notice readbacks, source hashes, and scope-specific recovery path.
- Not completed: billing API access, itemized invoice acquisition, per-service/order actual cost, financial source-verifier qualification, continuous bill collection, actual positive contribution margin.
- No source code changed; no synthetic test was substituted for external financial evidence. JSON/links/hashes are checked locally.
- **Cost gate remains BLOCKED**. This report does not approve production deployment, migration, new provider charges, or commercial expansion.

