# DELTA on Apify

This Actor forwards Capture or Preflight to the authenticated DELTA Partner Gateway and charges one `proof-created` pay-per-event only after a complete proof response is available. Preflight is the default, matching the input schema; unsupported product names fail before any request. The gateway URL must use HTTPS and cannot redirect the secret-bearing request.

Gateway headers and metadata must arrive within one 120-second deadline and fit within 1 MiB. A timeout or oversized response ends this run as unconfirmed without charging or resubmitting; a response arriving after that deadline cannot advance billing.

Before invoking DELTA it checks PPE, the run budget, and the configured event price against `DELTA_MIN_GROSS_EVENT_USD` (default `$1.00`, never below the current $1 partner price). This guard does not update platform pricing and does not establish positive margin: actual marketplace fees, compute costs and net proceeds require separate verification.

Before charging, proof metadata is saved as `OUTPUT` in the existing run key-value store and the charge phase is marked unknown. A same-run restart never repeats an uncertain charge or dataset append; a complete run reuses its recorded result. If charge or delivery remains unknown, inspect the original run's billing and `OUTPUT` before recovery. Do not start a new run as an automatic retry. The marker is a sequential restart guard, not an atomic multi-instance lock; SDK/platform internal retries and concurrent writers require separate integration verification. No exactly-once billing guarantee is asserted.

One-time platform setup:

1. Complete Apify developer KYC.
2. Create the Actor and configure PPE pricing for `proof-created` under the owner's authorization. Verify the platform's actual fee contract, DELTA's net price, and Actor compute; configure the run budget to cover one result. Do not assume an old fee percentage proves current net proceeds.
3. Store `DELTA_PARTNER_GATEWAY_URL` and `DELTA_PARTNER_SECRET` as Actor secrets/environment variables.
4. Use limited permissions and no Standby mode so it remains eligible for agentic payments.

After this, source updates can be pushed automatically with `apify push` from CI.
