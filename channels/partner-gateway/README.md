# DELTA Partner Gateway

Thin reseller rail for marketplaces that bill the buyer themselves. It performs partner authentication, rate limiting, idempotency normalization, and price attribution, then calls the one DELTA core Worker through a Cloudflare service binding. It has no Browser Run or R2 binding and cannot fork capture logic.

## Required secrets

- `PARTNER_SECRET`: marketplace-facing proxy secret (`x-delta-partner-secret` or RapidAPI's proxy-secret header).
- `CORE_SERVICE_SECRET`: gateway-to-core secret. Store the same value as the core Worker's `PARTNER_GATEWAY_SECRET`.

Set each with `wrangler secret put`; never place either value in source or `wrangler.jsonc`.

Every write needs `Idempotency-Key`, `x-rapidapi-request-id`, or `external_request_id`. Supported routes are `POST /capture`, `POST /preflight`, `POST /watch`, and `GET /watch/:id`. Watch is prepaid and quota-bounded. The configured `PARTNER_NET_*_USD` values represent DELTA's net revenue after platform fees; the core rejects values below its current contribution-margin floor.
