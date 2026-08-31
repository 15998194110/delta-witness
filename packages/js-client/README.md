# delta-witness-ruphussten

A zero-account client for DELTA Witness. It reads quotes/demo/proof metadata and performs paid Capture or Guard when supplied an x402-capable `fetch` implementation.

```js
import { DeltaWitness } from "delta-witness-ruphussten";
const delta = new DeltaWitness();
console.log(await delta.quote());
console.log(await delta.paymentChallenge("https://example.com"));
console.log(await delta.preflightChallenge({
  url: "https://example.com",
  expected: { contains: ["Example Domain"] }
}));
```
