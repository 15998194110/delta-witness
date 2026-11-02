# DELTA Witness Base app

Standard web app for Base mainnet. It reuses the production DELTA Core API and never handles wallet private keys.

## Safety boundaries

- The live quote must match Base mainnet, USDC, DELTA's receive-only treasury, and upfront settlement.
- The local x402 client checks the selected product's owner-authorized price: Capture 1 USDC or Public Preflight 5 USDC. A Capture allowance does not authorize Preflight.
- The wallet remains in the user's injected EIP-1193 provider; the app asks only for a typed-data authorization.
- Browser capture is performed only by DELTA Core after x402 settlement.

## Local verification

```sh
npm ci
npm run verify
```

The production Pages project is `delta-witness-app`. Register its deployed URL in Base.dev after the one-time account/developer-agreement bootstrap.

## Mini App manifest

The static Farcaster/Base-compatible manifest is served at `/.well-known/farcaster.json` and is checked by `npm run validate-manifest`. The existing signed `accountAssociation` is preserved. Local source verification does not establish that the public Pages deployment has these same bytes. Production readback and publication require separate authorization in the current repair scope.

## Original-order recovery (local candidate)

When the Core quote explicitly enables `delta-order-recovery/v1`, the app uses the shared JS SDK. It persists a UUID and random private recovery capability before invoking the buyer-approved payment transport. Web Locks coordinate tabs, and one atomic localStorage record retains the active order through refresh, timeout and uncertain payment outcomes. Recovery uses ordinary Core status/recover requests and never signs a new payment. Completed negative Preflight results remain completed deliveries.

If Core has not enabled scoped recovery, the existing legacy payment path remains available with its conservative uncertainty marker. A legacy marker alone grants no private export rights and cannot be converted into a new payment retry. The operator must explicitly select credential lifetime and retention policy before enabling the new scoped flow; this repository change does not activate either setting.

Private browser records are limited to 50 orders and 1 MiB. A full, corrupted, inaccessible store or unavailable Web Locks blocks new payment safely. No record is automatically deleted, no unknown order is cleared, and private credentials are not synchronized to another browser/device. A capacity/archive policy and real browser acceptance remain release prerequisites for sustained use. Same-origin scripts can access localStorage; this mechanism is a buyer recovery capability, not hardware-backed wallet authentication.

For completed scoped orders, download controls retrieve original HTML, Markdown, PNG and manifest as opaque attachments. HTML is not rendered in the application origin. The original bundle root is retained for independent offline verification. Local jsdom tests cover the integration; they are not live wallet, mobile Mini App or Pages deployment evidence.
