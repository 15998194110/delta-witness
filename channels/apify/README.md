# DELTA on Apify

This Actor is deliberately thin: Apify handles discovery and marketplace billing; the Actor forwards Capture or Guard to the authenticated DELTA Partner Gateway and charges one `proof-created` pay-per-event only after DELTA has made the result available. It verifies `chargedCount` before returning the result.

One-time platform setup:

1. Complete Apify developer KYC.
2. Create the Actor and set PPE pricing for `proof-created`. Account for Apify's current 20% platform share, DELTA's net price, and Actor compute; configure `minimalMaxTotalChargeUsd` to cover one result.
3. Store `DELTA_PARTNER_GATEWAY_URL` and `DELTA_PARTNER_SECRET` as Actor secrets/environment variables.
4. Use limited permissions and no Standby mode so it remains eligible for agentic payments.

After this, source updates can be pushed automatically with `apify push` from CI.
