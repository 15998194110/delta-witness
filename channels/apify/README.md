# DELTA on Apify

This Actor is deliberately thin: Apify handles discovery and marketplace billing; the Actor forwards an authenticated request to the DELTA Partner Gateway and charges one `proof-created` pay-per-event event only after a successful proof is created.

One-time platform setup:

1. Complete Apify developer KYC.
2. Create the Actor and set PPE pricing for `proof-created`.
3. Store `DELTA_PARTNER_GATEWAY_URL` and `DELTA_PARTNER_SECRET` as Actor secrets/environment variables.
4. Use limited permissions and no Standby mode so it remains eligible for agentic payments.

After this, source updates can be pushed automatically with `apify push` from CI.
