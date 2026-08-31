# DELTA operations

## Unit-economics funnel

The Worker writes privacy-conscious aggregates to the `delta-witness-analytics` D1 database. It stores normalized channel/partner labels, event type, route, success state, prices, Browser milliseconds, artifact bytes, estimated variable cost, and estimated contribution margin. It does not write target URLs, payment signatures, IP addresses, or user agents.

Run the read-only dashboard query with a scoped Cloudflare token:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "your-account-id"
$env:CLOUDFLARE_API_TOKEN = "D1-read-token"
# Optional when querying a different environment:
$env:DELTA_D1_DATABASE_ID = "c9431b00-27c5-4609-9f3d-6af20cb162df"
npm run funnel -- 30
```

The result groups `page view -> qualified request -> 402 -> paid -> delivered -> repeat` and gross revenue, variable cost, contribution margin, Browser milliseconds, and storage bytes by channel.

Apply schema changes before deploying the Worker:

```powershell
npx wrangler d1 migrations apply delta-witness-analytics --remote
```

## Secrets

Core Worker secrets:

- `PARTNER_GATEWAY_SECRET`: authenticates the service-bound reseller gateway.
- `INDEXNOW_ADMIN_SECRET`: authenticates manual discovery pulses. The public IndexNow key is deliberately a separate non-secret value.

Partner gateway secrets:

- `PARTNER_SECRET`: authenticates the marketplace proxy.
- `CORE_SERVICE_SECRET`: same value as the core `PARTNER_GATEWAY_SECRET`.

Use `wrangler secret put`; never put these values in source, CI logs, or chat.

## Rollback and preservation

The deployment retains the existing Worker name and R2 bucket binding. Release automation must list the current Worker version before deployment. It never deletes R2 objects. Roll back Worker code with Cloudflare Versions/Deployments; proof objects and private artifacts remain untouched.
