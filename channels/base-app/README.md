# DELTA Witness Base app

Standard web app for Base mainnet. It reuses the production DELTA Core API and never handles wallet private keys.

## Safety boundaries

- The live quote must match Base mainnet, USDC, DELTA's receive-only treasury, and upfront settlement.
- The local x402 client has a hard `$0.10` per-payment ceiling.
- The wallet remains in the user's injected EIP-1193 provider; the app asks only for a typed-data authorization.
- Browser capture is performed only by DELTA Core after x402 settlement.

## Local verification

```sh
npm ci
npm run verify
```

The production Pages project is `delta-witness-app`. Register its deployed URL in Base.dev after the one-time account/developer-agreement bootstrap.

## Mini App manifest

The static Farcaster/Base-compatible manifest is served at `/.well-known/farcaster.json` and is checked by `npm run validate-manifest`. Its `accountAssociation` is intentionally blank until the owner signs the exact production domain. After the Pages deploy is live, use the official [Farcaster Mini App Manifest Tool](https://farcaster.xyz/~/developers/mini-apps/manifest), enter `delta-witness-app.pages.dev`, sign with the Farcaster custody wallet, paste the returned `accountAssociation` object into the manifest, and rerun the release train. Never put a seed phrase or private key in the repository or chat.
