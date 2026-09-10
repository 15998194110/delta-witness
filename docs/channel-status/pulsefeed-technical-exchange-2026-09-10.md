# PulseFeed technical exchange + revenue reconciliation — 2026-09-10

Status: **explicit external technical interest / free crawl inclusion**, not a paid integration, not a customer settlement, not revenue.

## PulseFeed reply

The existing DELTA outreach thread received a substantive reply from Nikolai / PulseFeed on September 10. The reply states that PulseFeed independently probed DELTA before responding and observed proper x402 v2 HTTP 402 behavior on Base mainnet, with `/.well-known/x402` parsing successfully. PulseFeed also said DELTA's production endpoints were added to its crawl for free liveness/challenge/receiver checks.

The reply identified a concrete documentation/outreach defect: an earlier email named the capabilities as Capture and Preflight without the canonical versioned paths, while the live routes are `POST /v1/capture` and `POST /v1/preflight`; the unversioned paths 404. PulseFeed described its payment-surface safety work and DELTA's action-side evidence as complementary, and offered a narrow technical data-shape exchange. It explicitly said it is commercially frozen and is not spending budget or building paid integrations now; PulseFeed also characterized current buyer demand on its own surface as low. Therefore this is **integration/interop interest**, not commercial intent and not a revenue forecast.

DELTA replied once on the existing thread (Gmail message id `1a08a26a50697405`; reply-to incoming message id `1a0899019f601dc9`). The reply:

- corrected the canonical paths to `POST /v1/capture`, `POST /v1/preflight`, and `POST /v1/guarded-action-pilot`;
- corrected the stale prices from the earlier cold email to the owner-authorized production ladder now live: Capture **1 USDC**, public Preflight **5 USDC**, Pilot **10 USDC**;
- respected the commercial freeze and did not request budget or a paid integration;
- proposed the smallest zero-budget interoperability object: a DELTA evidence record may cross-reference PulseFeed's independently observed payment surface (`resource/endpoint`, `payTo`, network, asset, amount, observation time, and a stable PulseFeed verdict/history reference) while keeping responsibilities separate — PulseFeed does not authorize the agent action and DELTA does not thereby certify the seller;
- pointed to the existing public OpenAPI and existing public proof rather than requesting a new paid test.

No new cold first-contact email was sent in this turn, no unanswered thread was chased, and no payment/wallet action was requested.

## Fresh Treasury + paid-funnel reconciliation

A one-shot **read-only** GitHub Actions reconciliation ran successfully at 2026-09-10 07:12 UTC and was deleted immediately afterward so it cannot become another growth loop. Run id: `34448780919`; job id: `102779413839`. Workflow add commit: `67461170657ef11500fd69e71043b43e955baad5`; cleanup commit: `31270dd16a9a0cad8e3f94f8a9081ed079e0ceb2`.

Canonical Base USDC inbound scan parameters:

- asset: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`;
- Treasury: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`;
- scanned blocks: **51,116,057 through 51,117,497** (continuing immediately after the pricing-rollout reconciliation through block 51,116,056);
- result: `incoming_count=0`, `incoming=[]`.

D1 paid-funnel read began at the successful 1→5→10 production rollout checkpoint (`created_at >= 2026-09-10 06:24:23`). It returned **24 `payment_required` rows** — Capture 7 at the current 1 USDC asking price, public Preflight 8 at 5 USDC, Pilot 9 at 10 USDC — plus **3 `proof_opened` rows**. It returned **zero `qualified_request`, zero `payment_verified`, and zero `capture_completed` rows** in the interval. All challenge rows were recorded as `channel=direct`, `partner=none`; deployment/operator/directory probes cannot be separated from prospective external callers from those rows alone, so they are not counted as customers or qualified 402 purchase intents. Proof opens also have no settlement attached and are not revenue.

Accounting for this interval:

- `value_authored`: paid capability remains live at the owner-authorized 1 / 5 / 10 USDC public ladder;
- `payment_authorized`: **0 attributable external authorizations confirmed**;
- `settlement_confirmed`: **0 new customer settlements confirmed**;
- `treasury_received`: **0 new canonical USDC**;
- new customer revenue: **0 USDC**;
- variable cost attributable to new paid customer fulfillment: **0 confirmed / no new paid fulfillment**;
- contribution margin from new customer fulfillment: **0 recognized**.

Existing platform-verification/self-test receipts remain excluded from First Stranger Revenue. No directory probe, proof view, listing counter, or asking-price telemetry is promoted to customer demand.

## Current distribution observations

PulseFeed is a useful new external trust/discovery relationship because its operator independently validated DELTA's x402 surface and added DELTA to its crawler without requiring spend. Public PulseFeed material currently positions it as an independent x402 endpoint audit/trust layer with free verification/trust surfaces; this relationship should be advanced only through the offered technical interoperability path unless PulseFeed later reopens commercial work.

Fresh ecosystem research also found `req402`, a Base-mainnet x402 marketplace that advertises agent programmatic discovery, direct non-custodial USDC settlement, free setup/monthly access, and a 5% facilitator fee on successful transactions. Its public seller flow currently presents a dashboard-style "connect API / set price / publish" path; no safe no-account/programmatic DELTA registration route was established in this run, so no duplicate identity, account creation, wallet signature, or listing claim was made.

Agent402's public marketplace continues to show material live buyer activity across the ecosystem (thousands of sellers and settlements), reinforcing the priority of already-listed machine-routing surfaces over accumulating low-quality static directories. No new DELTA settlement was inferred from those platform-wide counters.
