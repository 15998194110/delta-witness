# delta-witness-ruphussten

A zero-DELTA-account JavaScript client for public page-state Capture and Preflight observations. Free quote/demo/proof reads do not require a wallet. Paid observations require an x402-capable fetch supplied by the buyer; this package does not create a wallet, hold keys, or authorize spending for you.

## Install and inspect without paying

```sh
npm install delta-witness-ruphussten
```

```js
import { DeltaWitness } from "delta-witness-ruphussten";

const delta = new DeltaWitness(); // ordinary fetch: no payment adapter
const input = {
  url: "https://example.com",
  expected: { contains: ["Example Domain"] }
};

console.log(await delta.quote("preflight"));
console.log(await delta.demo());
console.log(await delta.preflightChallenge(input));
```

`preflightChallenge` returns the HTTP 402 status, response headers and parsed body. Receiving a quote or challenge is not a completed observation or payment. `paymentChallenge(url)` requests a Capture challenge instead. These methods do not automatically retry with a payment signature.

## Make one buyer-authorized paid observation

Use this adapter inside an application that already has an x402 v2 payment client and an explicitly approved spending policy:

```js
import { DeltaWitness } from "delta-witness-ruphussten";

export async function observeBeforeAction({ url, expected, approvedPaidFetch }) {
  if (typeof approvedPaidFetch !== "function") {
    throw new TypeError("Provide a buyer-authorized x402-capable fetch");
  }
  const delta = new DeltaWitness();
  return delta.preflightWithPaidFetch({ url, expected }, approvedPaidFetch);
}
```

The exported function does not run until your application calls it. When called, the supplied payment client handles the fresh 402 challenge, buyer authorization/signing and paid retry; the DELTA client returns the parsed successful response or throws on a non-success HTTP response. Plain `fetch` is not a payment adapter and will leave a protected call at 402.

Paid calls have a 120-second deadline including response-body delivery (`requestTimeoutMs` may be configured from 1 through 120000 milliseconds). This permits the server's separate settlement and browser deadlines to complete. Timeout returns `payment_outcome_unconfirmed`, aborts the supplied signal and never submits again. An adapter that ignores cancellation may still finish the original attempt; retain its original request/payment context and reconcile it before another call. Complete negative Preflight comparisons remain valid deliveries.

For an existing x402 integration, pass its approved fetch directly to `preflightWithPaidFetch(input, paidFetch)` or `captureWithPaidFetch(url, paidFetch)`. The current official fetch-client package family is `@x402/fetch` with `@x402/evm`; follow the [official v2 migration guide](https://docs.cdp.coinbase.com/x402/migration-guide) for wallet-client setup rather than mixing legacy v1 imports. No private key should be sent to DELTA or included in an issue, email, URL or public example.

**Spending controls belong in the supplied payment client.** This small DELTA SDK does not itself enforce an amount cap, recipient/network allowlist, total budget or retry policy. Before permitting a signature, your payment client must validate the current challenge against the buyer's approval. An earlier inspected challenge is not permission to accept a later changed price.

## Opt-in durable orders and recovery

The local source adds `prepareOrder`, `executeOrder`, and `recoverOrder` for Capture and Preflight. This flow requires Core order recovery to be explicitly enabled by its operator. It is not a claim that recovery is enabled on the public service or available in an already-published npm release. The legacy `captureWithPaidFetch` and `preflightWithPaidFetch` methods remain unchanged and do not provide persistence across calls or process restarts.

Provide an **atomic, durable** store owned by your application:

```js
const delta = new DeltaWitness({
  baseUrl: "https://delta-witness-api.ruphussten.workers.dev",
  orderStore: {
    // Return a private JSON record, or null only when no record exists.
    async load(orderId) { return database.readOrder(orderId); },
    // Atomically write nextRecord only if the stored revision equals
    // expectedRevision. null means the order must not exist yet.
    // Return true only after durable commit, false on a revision conflict.
    async compareAndSet(orderId, expectedRevision, nextRecord) {
      return database.compareAndSetOrder(orderId, expectedRevision, nextRecord);
    },
  },
});

// Check disclosed terms against your already-authorized purchase policy.
const quote = await delta.quote("preflight");
// Run once for an intentionally new purchase, before any signing.
const order = await delta.prepareOrder("preflight", {
  url: "https://example.com/",
  expected: { contains: ["Example Domain"] },
}, { retentionPolicyHash: quote.retention?.policy_hash });
// Persist order.order_id in your application's durable job record.
const completed = await delta.executeOrder(order.order_id, approvedPaidFetch);
console.log(completed.order_id, completed.delivery.proof_id);

// After interruption, reconstruct the client using the same durable store.
// This uses ordinary fetch and cannot initiate a payment.
const recovered = await delta.recoverOrder(order.order_id);
```

`database` above is your application's persistence layer; it is not included in this package. Implement CAS as one database transaction or equivalent atomic operation across every process using the order. An in-memory Map, independent read-then-write, ordinary localStorage write, expiring lock, or a store that returns before commit does not meet this contract. Keep records private; do not put them in tool outputs, URLs, telemetry, logs, browser history, public backups, or source control. The record contains a random 32-byte recovery capability, not a wallet key or payment signature. It grants authenticated order access and recovery; it is not permission to spend. Keep the original record, including unknown or failed attempts; never delete it, reset its phase/revision, or restore an older copy to retry a purchase.

`prepareOrder(product, input, {orderId})` accepts an optional UUIDv4 generated by your application. Reusing an ID with a different product, request or Core origin is rejected. Otherwise it returns the persisted public `{order_id, product, state}` without the capability. Omitting the ID intentionally creates a new order each time; do not repeat preparation with a fresh ID to retry an uncertain purchase. Store the returned ID in the original durable job. Canonical JSON key ordering and URL serialization allow the same request to be recognized without conflating two intentionally separate purchases.

`executeOrder(orderId, approvedPaidFetch)` atomically records `signing_started` **before** invoking the payment adapter. Only the client winning that CAS may invoke it. Existing `signing_started`, `uncertain`, or `complete` orders use authoritative Core recovery instead, including after restart. A completed result is `{order_id, product, state: "complete", delivery}`; a negative Preflight comparison remains a valid completed delivery. Existing buyer-approved budgets still authorize the first call automatically; this API adds no human approval step.

`recoverOrder(orderId)` uses ordinary fetch for `GET /v1/orders/:id`, followed by at most one body-free `POST /v1/orders/:id/recover` when Core explicitly reports recovery available. Neither request carries a payment signature. Recovery always checks Core again, even for a previously completed local record. Choosing recovery for a prepared order conservatively closes its first-payment path before contacting Core. HTTP 404, expiry, unavailable evidence, malformed responses and storage failures never establish that a prior payment did not happen and never unlock a fresh signature. Errors expose only a controlled `code`, `status`, `order_id` and `retryable: false`; safe recovery reads may be attempted later, but fresh payment is not an automatic retry.

The new flow permits only a fixed HTTPS Core origin and requests `redirect: "error"` to prevent forwarding the capability to another host. It validates the returned order ID, product, settlement/fulfillment states and proof URL/hash structure. Source-URL/request binding and stored-artifact integrity remain Core's authenticated responsibility; this response shape does not independently repeat or verify the complete source content in the SDK.

The supplied `approvedPaidFetch` must preserve the order headers, honor abort/redirect settings, validate its payment policy, and avoid internally signing again. Because it is an arbitrary caller function, this SDK can guarantee one invocation after its own durable CAS, **not** one internal signature inside an uncooperative adapter. A broken or rolled-back store likewise cannot provide restart safety. No signing key, payment signature or raw proof artifact is stored by the order API.

## Current public payment terms

Current owner-authorized prices: Capture **1 USDC**, Public Preflight **5 USDC**, and Guarded-Action Pilot **10 USDC**. This JavaScript class does not expose a Pilot method. Authenticated Partner Capture, Partner Preflight and each new Watch check are **1 USDC** under the separate authenticated partner flow.

- Network: Base mainnet, `eip155:8453`.
- Canonical USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- DELTA Treasury: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`.
- A buyer-approved Capture allowance of **1 USDC** corresponds to `1000000` raw USDC units.
- A buyer-approved Public Preflight allowance of **5 USDC** corresponds to `5000000` raw USDC units.
- These are explicit buyer-side approvals, not spending limits enforced by this SDK. A Capture-only allowance does not authorize Public Preflight; do not silently increase a buyer's existing budget.

Always obtain the live quote/challenge and check that the chosen product, displayed amount, approved spending allowance and payment requirement agree before signing. Never send USDC directly to the Treasury as a substitute for the x402 request: an unrelated transfer does not identify the request or establish delivery. Do not create a fresh payment blindly after a timeout; retain the payment client's receipt/request context and resolve whether settlement or delivery already occurred before another authorization.

## Put the observation before your agent's action

Observe an authorized, publicly accessible page; inspect the returned comparison and proof; then let your application's own policy and user approvals decide whether to proceed. DELTA does not perform the consequential action in this example. Preflight is a deterministic page observation/comparison, **not a security audit or a guarantee that an action is safe**. Do not treat HTTP 200 or a matching text fragment as an authorization to purchase, transfer funds or submit a form. Do not assume DELTA shares your browser's logged-in session, and do not submit private/authenticated URLs or session credentials.

The SDK also exposes `proof(id)` for returned proof identifiers. A proof or HTTP success alone is not independent chain-receipt verification; retain the payment client's settlement evidence separately. SDK calls carry `x-delta-channel: npm`, a client-reported attribution hint, not evidence of a unique customer or originating marketplace.

## Publication and validation scope

Repository documentation and published npm artifacts are separate surfaces. A repository correction is not a claim that an already-published npm version changed. Published package contents and the actual buyer-facing purchase path require separate readback. Offline mock tests do not establish a live wallet authorization, settlement or paid delivery.
