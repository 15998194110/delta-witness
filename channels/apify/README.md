# DELTA on Apify

This thin Actor calls the existing DELTA Partner Gateway for Capture or Preflight. A new purchase remains automatic within the caller's approved platform budget. It does not require a new human approval for each order. Preflight is the default; a valid `safe: false` result is a completed observation, not a failed delivery.

## Stable order and charge recovery

Supply a stable `business_order_id` (8–128 ASCII letters, digits, `.`, `_`, `:`, or `-`, starting with a letter or digit). Reuse it for every retry of the same business order, including another Actor run. A new ID means a separate purchase. The Actor takes the user identity only from the platform's `APIFY_USER_ID`, never from input. Core derives the identity from the trusted partner, platform user, and business ID; changing the product or request under that identity is a conflict. A different platform user cannot retrieve this order.

The Actor checks authenticated `/business/capabilities` before any new fulfillment. Core must explicitly enable `PARTNER_BILLING_COORDINATION_ENABLED=true` and advertise `delta-partner-billing/v1`. Older, disabled, malformed, or unavailable servers fail closed before a new capture or platform charge. The flag has no production default in this source. Enabling or deploying it is outside this local repair's authorization.

Core stores billing coordination on the **original fulfillment record**, using its existing ETag compare-and-swap. It creates no second financial ledger. Only a complete delivery with its original response digest and verified artifact bundle can receive a charge reservation. The winning reservation persists `charge_unknown` **before** returning a one-use permission for the Actor's single `Actor.charge({ eventName: 'proof-created', count: 1 })` invocation. Repeating the reservation, losing its response, starting another run, or using another attempt ID never grants that permission again. There is no timeout-based reset or guessed provider idempotency parameter.

The Actor saves the verified result as `OUTPUT` before reserving a charge. After `chargedCount === 1`, it confirms the original attempt and appends the result to the dataset. Recovery retrieves the original proof and restores `OUTPUT`; it never appends the dataset again or repeats an uncertain charge. An unknown charge is retained for reconciliation against the **original** platform transaction. A lost dataset or exit acknowledgement also cannot authorize another charge. Existing legacy run markers remain intact: only a matching, already-complete historical marker may return its existing result; unresolved legacy markers fail closed.

`platform_charged` is explicitly a **partner adapter assertion**. It is not verified provider settlement, Treasury receipt, net payout, revenue, or positive margin; those values remain unknown. The local protocol prevents a second application-level charge invocation for the same original order. It does not establish the platform's own internal retry, final settlement, refund, or payout guarantees.

## Bounds and pricing

Gateway headers and response bodies share a 120-second deadline and a 1 MiB actual-byte limit. Each asynchronous Actor SDK operation (`init`, input, storage read/write, charge, dataset append, and exit) has a 30-second deadline. A late response cannot advance this Actor's billing or delivery continuation. The SDK exposes no generic cancellation handle: an already-started provider operation may still complete after the local timeout, so the original unknown marker is retained and the operation is never automatically retried.

Before a new fulfillment, before reservation, and immediately before charging, the Actor checks the installed SDK's actual PPE price and available charge count. `proof-created` must meet `DELTA_MIN_GROSS_EVENT_USD` (default `$1.00`, never below `$1.00`), with budget for one event. The default `apify-default-dataset-item` event must be unpriced, preventing an implicit second bill from dataset output. Recovery of an existing proof does not require a new purchase budget.

These checks do not change platform prices or establish positive margin. Actual platform fees, Actor compute, refunds and net proceeds require separate evidence. When an external operation remains unknown, retain the original business ID/run and reconcile it; do not assign a new ID as an automatic retry.

## Publication prerequisites

This source is locally implemented and tested, **not published or enabled by this repair**. Before an independently authorized release:

1. Verify Apify developer requirements and the actual fee/payout contract for this account.
2. Configure the `proof-created` PPE event and approved run budget; keep default dataset-item billing disabled.
3. Store `DELTA_PARTNER_GATEWAY_URL` and `DELTA_PARTNER_SECRET` only in provider secret management; provide the trusted `APIFY_USER_ID` platform identity.
4. Deploy and verify the matching Core/Gateway contract, then explicitly enable its feature flag. Keep the new Actor inactive against older Core versions.
5. Qualify real provider timeout/retry, platform charge readback, fees and payout independently. Synthetic tests are not evidence of real charges or revenue.

Isolated coverage is in `tests/apify-delivery.test.mjs` and `tests/partner-billing.test.ts`. The latter exercises the actual Gateway → Core → original fulfillment CAS with in-memory storage and mocked platform calls, including concurrent runs, lost acknowledgements, negative Guard results and late operations.
