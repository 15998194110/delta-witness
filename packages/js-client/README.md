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

For an existing x402 integration, pass its approved fetch directly to `preflightWithPaidFetch(input, paidFetch)` or `captureWithPaidFetch(url, paidFetch)`. The current official fetch-client package family is `@x402/fetch` with `@x402/evm`; follow the [official v2 migration guide](https://docs.cdp.coinbase.com/x402/migration-guide) for wallet-client setup rather than mixing legacy v1 imports. No private key should be sent to DELTA or included in an issue, email, URL or public example.

**Spending controls belong in the supplied payment client.** This small DELTA SDK does not itself enforce an amount cap, recipient/network allowlist, total budget or retry policy. Before permitting a signature, your payment client must validate the current challenge against the buyer's approval. An earlier inspected challenge is not permission to accept a later changed price.

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
