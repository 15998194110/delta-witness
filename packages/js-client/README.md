# delta-witness-ruphussten

A zero-account client for DELTA Witness. It can read quotes/demo/proof manifests and can perform a paid capture when supplied an x402-capable `fetch` implementation.

```js
import { DeltaWitness } from "delta-witness-ruphussten";
const delta = new DeltaWitness();
console.log(await delta.quote());
console.log(await delta.paymentChallenge("https://example.com"));
```
