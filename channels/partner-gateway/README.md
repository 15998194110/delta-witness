# DELTA Partner Gateway

A second billing rail for marketplaces that collect payment themselves (RapidAPI, Apify, future API marketplaces). It does **not** expose x402. Marketplace traffic must present a server-side secret, then the gateway uses the same Cloudflare Browser Run and the same private R2 bucket as the core DELTA worker.

## Security

Set `PARTNER_SECRET` with `wrangler secret put PARTNER_SECRET`. Never put it in `wrangler.jsonc` or a public marketplace listing.

Supported authentication headers:

- `x-delta-partner-secret`
- `x-rapidapi-proxy-secret`

The gateway rejects traffic if the value does not exactly match `PARTNER_SECRET`.

## Deploy

```bash
npm install
npx wrangler secret put PARTNER_SECRET
npm run deploy
```
