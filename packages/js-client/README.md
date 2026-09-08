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

Owner-approved reference prices as of 2026-09-08: Capture **0.03 USDC** and public Preflight **1 USDC**. The existing HTTP Guarded Action Pilot is **10 USDC**, but this JavaScript class does not expose a Pilot method. Existing authenticated partner and Watch terms are separate; do not infer those prices from the public quote API.

- Network: Base mainnet, `eip155:8453`.
- Canonical USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- DELTA Treasury: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`.
- A buyer-approved 1 USDC public Preflight cap corresponds to `1000000` raw USDC units. It is a buyer-side policy, not a cap enforced by this SDK.

Always obtain the live quote/challenge. Never send USDC directly to the Treasury as a substitute for the x402 request: an unrelated transfer does not identify the request or establish delivery. Do not create a fresh payment blindly after a timeout; retain the payment client's receipt/request context and resolve whether settlement or delivery already occurred before another authorization.

## Put the observation before your agent's action

Observe an authorized, publicly accessible page; inspect the returned comparison and proof; then let your application's own policy and user approvals decide whether to proceed. DELTA does not perform the consequential action in this example. Preflight is a deterministic page observation/comparison, **not a security audit or a guarantee that an action is safe**. Do not treat HTTP 200 or a matching text fragment as an authorization to purchase, transfer funds or submit a form. Do not assume DELTA shares your browser's logged-in session, and do not submit private/authenticated URLs or session credentials.

The SDK also exposes `proof(id)` for returned proof identifiers. A proof or HTTP success alone is not independent chain-receipt verification; retain the payment client's settlement evidence separately. SDK calls carry `x-delta-channel: npm`, a client-reported attribution hint, not evidence of a unique customer or originating marketplace.

## Scope of this update

This is a repository documentation improvement using existing SDK methods. It does not change runtime code, deploy production, republish the npm package, generate a paid canary, or establish customer adoption. The examples' existing-client method/response behavior was checked with four offline mock tests; no live wallet authorization, settlement or paid delivery was exercised.
