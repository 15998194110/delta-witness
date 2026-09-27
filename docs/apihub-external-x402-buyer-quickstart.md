# DELTA Capture for existing APIHub buyers

**Status, 2026-09-27:** buyer-side integration instructions based on APIHub's public API contract. DELTA's direct public 402 pricing was independently checked at `2026-09-27T13:12:48.594Z`. No paid APIHub-to-DELTA end-to-end call has been performed. This page is not proof that DELTA is indexed in APIHub's marketplace, that APIHub has a DELTA budget, or that the integration has produced a customer sale.

## One current need, one Capture

Use this route only when an existing APIHub customer has a genuine need to preserve the publicly accessible page behind a consequential decision: supplier terms before approval, a product page before checkout, or source content before a report or removal request. DELTA observes public content and records timestamped proof/hash metadata. It does not certify truth, ownership, infringement, legal admissibility, or access to a blocked/private page.

The smallest existing DELTA purchase is **Public Capture: 1 USDC**. Choose **Public Preflight: 5 USDC** only for an explicit deterministic condition check; **Guarded-Action Pilot: 10 USDC** is not the default for a single-page observation. Authenticated Partner Capture, Partner Preflight and each new Watch check remain **1 USDC** under their existing authorized paths; they are not exposed by the public example below.

## External calling is not provider onboarding

APIHub documents `POST https://proxy.apihub.io/external` for an existing buyer to call an external x402 URL that is not onboarded to APIHub. Its proxy pays the upstream provider on-chain and debits the buyer's credits. That is distinct from publishing a native APIHub service under its commission/batch-payout model.

This integration does not register a DELTA seller account, change the Treasury, deploy a relay wrapper, bind a payout wallet, create credits, or require the DELTA operator to pay for a test. Buyer credentials belong only in the buyer's own authorized environment.

## Purchase request shape

After the actual buyer has approved the task and total charge, the documented external request uses this shape:

```text
POST https://proxy.apihub.io/external
Authorization: Bearer <BUYER_OWN_APIHUB_KEY>
Content-Type: application/json
```

```json
{
  "url": "https://delta-witness-api.ruphussten.workers.dev/v1/capture",
  "method": "POST",
  "headers": {"Content-Type": "application/json"},
  "body": {"url": "https://example.com"}
}
```

`example.com` documents the payload shape only. Replace it with the buyer-authorized public source for a real task; do not buy the example as a canary, reimburse someone to run it, or claim it as customer demand. The outer URL is always the existing DELTA Capture endpoint; the nested `body.url` is the page to observe. Do not place private API keys, login cookies, payment signatures, or confidential case material inside that nested payload.

APIHub's documented MCP equivalent is `apihub_call_external` with the same `url`, `method`, `headers` and `body` arguments. It is a **payment-executing tool**, not a discovery or free-preview tool. Use the current live `tools/list` schema in the buyer's client before calling; do not guess whether a particular client expects an object or serialized body.

## Fees and approval: do not silently spend

**The 1 USDC DELTA price is not a claim that APIHub's total debit is 1 USDC.** APIHub's external-call documentation says the debit includes the provider price **plus markup**. Its external listing prose and documentation are not fully consistent about this. Obtain the current applicable total charge and the actual buyer's approval before executing.

The public external-call schema reviewed on 2026-09-27 lists `url`, `method`, `body`, and `headers`; it does **not** document an enforceable total-charge limit field. A search price filter, local variable, or this request example is not a spending cap. Do not add an invented `max_price` field or assume the proxy enforces it. If the buyer requires a hard total cap and the platform cannot establish one, do not execute this route. Use DELTA's existing direct client with its explicit product-bound approval policy instead.

Do not request a credit top-up, wallet signature, or payment from the DELTA owner to prove this integration. No automatic executor is provided here precisely because platform fees, buyer approval, and interoperability still need verification in a real authorized purchase.

## Provider invariants and completion

For the direct DELTA Capture challenge, verify:

- network: Base `eip155:8453`;
- canonical USDC: `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`;
- raw Capture amount: `1000000`;
- Treasury: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`;
- x402 v2 challenge/header consistency.

APIHub documents a response envelope containing outer `ok`, upstream `status`, upstream `body`, and `credits_spent_microdollars`. HTTP 200 at the proxy alone is not successful DELTA delivery. Inspect the upstream status and DELTA result, preserve the returned proof reference and the platform's request/receipt identifiers, and reconcile the unique on-chain Treasury receipt with the real buyer's authorized task and successful fulfillment.

A receipt from a shared proxy wallet does not establish which independent customer bought the service. Missing buyer attribution or fulfillment evidence stays unresolved, not recognized revenue. A platform ledger hash is not automatically an on-chain transaction hash. On a timeout or uncertain result, check the existing receipt/order state before any retry; do not repeat a charge or manufacture repeat purchases.

## Official references

- [APIHub external calls](https://apihub.io/docs/agents/calling-apis)
- [APIHub API reference](https://apihub.io/docs/api-reference)
- [APIHub MCP tool definitions](https://apihub.io/docs/agents/mcp)
- [DELTA OpenAPI](https://delta-witness-api.ruphussten.workers.dev/openapi.json)
- [DELTA x402 discovery](https://delta-witness-api.ruphussten.workers.dev/.well-known/x402)
- [DELTA direct JS client](../packages/js-client/README.md)

Existing completed or prepaid DELTA obligations retain their original payment identity and must not be recharged. This buyer integration does not change current owner pricing or the closed historical sprint.
