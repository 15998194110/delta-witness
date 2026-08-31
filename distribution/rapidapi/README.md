# RapidAPI channel

Use the partner gateway as the RapidAPI backend. In the RapidAPI Provider Dashboard, set the backend base URL to the deployed partner gateway and configure the RapidAPI proxy secret to match the Worker secret `PARTNER_SECRET`.

DELTA validates `X-RapidAPI-Proxy-Secret` on every request, so direct callers cannot bypass RapidAPI billing.

Suggested first pricing experiment: small free quota for trial, then usage-based paid calls. Do not price below measured Cloudflare Browser Run + storage cost plus marketplace fee and target margin.
