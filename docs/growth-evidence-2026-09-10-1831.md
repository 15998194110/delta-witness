# DELTA growth evidence — 2026-09-10 18:31 Asia/Shanghai

This is an evidence snapshot, not a replacement for the main Commercial Operator state.

## Evidence ledger

| Channel / source | listing_status | discovery_status | buyer_count | settlement_count | verified_neighbor_demand | external_requests | 402_intents | paid_settlements | treasury_received | revenue | variable_cost | contribution_margin | evidence_quality |
|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---|---|---|
| DELTA core production | live | Capture / Preflight / Pilot 402 verified | 0 observed this run | 0 | n/a | 0 | 0 | 0 | $0 customer | $0 | no paid fulfillment executed | n/a | A — direct live 402 + health |
| Agents.NET | submitted, review pending; submissionId `160` | not public until approval | 0 | 0 | directory has active agent listings; no DELTA buyer evidence yet | 0 | 0 | 0 | $0 | $0 | $0 submission fee | n/a | A for submission receipt; C for future discovery until approved |
| PulseFeed | included in crawl; generic prober method bug fixed by operator | stored-record rewrite pending at counterpart; live paths independently re-probed healthy by counterpart | 0 commercial | 0 | counterpart reports roughly one external paid x402 call/week across its catalogue | 0 | counterpart independently observed current 402 challenges | 0 | $0 | $0 | $0 integration fee | n/a | A for explicit operator correspondence; B for reported market aggregate |
| x402 Arena | six existing DELTA registrations | live public arena entries | 0 shown | 0 shown | public leaderboard shows paid neighboring verification/web-intelligence endpoints, but Arena telemetry is not DELTA Treasury evidence | 0 shown | 0 shown | 0 shown | $0 | $0 | $0 listing fee | n/a | B — public marketplace telemetry |
| MCP Bridge | direct GitHub issue attempt blocked by integration permission; official email fallback sent | review/request pending | 0 | 0 | 461+ MCP servers indexed | 0 | 0 | 0 | $0 | $0 | $0 | n/a | A for direct 403 + sent-mail receipt; C until indexed |
| AuraGate | all 3 DELTA endpoints pass its public x402 probe; registration blocked by `owner_authorization_required` | not listed; Base-vs-Arc warning unresolved | 0 DELTA | 0 DELTA | marketplace publishes real receipt/call statistics for existing services | 0 | 3 independent 402 probes | 0 | $0 | $0 | $0 probe/listing fee | n/a | A for direct probe/403; B for marketplace demand telemetry |
| Base Treasury | n/a | canonical USDC reconciliation complete through block `51,123,625` | 0 independent customer payers | 0 customer settlements | n/a | n/a | n/a | 0 customer | `$0.03` total observed, all classified non-customer platform verification; `$0.00` customer | `$0.00` customer | n/a | n/a | A — direct canonical Base USDC logs |

## Core integrity

Direct unpaid production probes returned the current owner-authorized ladder and existing Treasury:

- Capture: HTTP 402, raw USDC `1000000` = **$1**
- Public Preflight: HTTP 402, raw USDC `5000000` = **$5**
- Guarded-Action Pilot: HTTP 402, raw USDC `10000000` = **$10**
- network: `eip155:8453`
- payTo: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`
- health: version `0.7.0`, healthy

No stale `$0.03` automation pricing was applied.

## Agents.NET direct submission

Agents.NET's public API accepted the free, unauthenticated DELTA submission with HTTP 200 and returned:

`{"success":true,"message":"Agent submitted successfully! We'll review it and get back to you within 2-3 business days. You'll receive an email notification once your agent is approved or if we need more information.","submissionId":160}`

Their documentation says submitted agents appear in the public registry only after review, so this is recorded as `submitted_review_pending`, not as a completed listing.

## PulseFeed explicit technical integration intent

PulseFeed independently verified DELTA's current production amounts as `1000000 / 5000000 / 10000000` Base USDC and confirmed its prior GET-only crawler created a false negative for DELTA's POST-only x402 resources. Their operator changed the generic prober to read `/.well-known/x402` and retry the exact manifest-declared POST method, then reported all three DELTA paths healthy. This is a real external integration/crawler improvement, not a DELTA self-test.

PulseFeed also proposed a two-layer interoperability model: free live payment-surface references plus independently signed/OpenTimestamps-anchored historical daily manifests. DELTA published `docs/temporal-attestation-design-2026-09-10.md` defining a non-circular, non-blocking OTS sidecar architecture bound to the immutable `bundle_root`, and replied with that design. No legal commitment, payment, wallet signature or production dependency was introduced.

## AuraGate qualification

AuraGate's unauthenticated probe independently accepted all three DELTA endpoints as valid x402 resources. It matched the exact listed prices and existing Treasury for Capture `$1`, Public Preflight `$5`, and Guarded-Action Pilot `$10`. Each probe reported one warning: DELTA advertises Base `eip155:8453`, while AuraGate says its settlement network is Arc `eip155:5042002`.

Direct free registration was attempted only after the probes passed. `POST /api/services` returned HTTP 403 `{"error":"owner_authorization_required"}` for all three. Because the platform does not document a programmatic owner-authorization mechanism and the remaining likely path involves seller account/wallet authorization, no wallet signature or account commitment was attempted. This channel is deferred rather than marked failed, especially because the Base-vs-Arc settlement mismatch must be resolved before it can be treated as a revenue-compatible listing.

## Treasury reconciliation

Independent reconciliation covered the latest 50,000 Base blocks through `51,123,625` using canonical Base USDC `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`.

One Treasury receipt candidate remains the historical `0.03 USDC` transfer `0xdac6c2ccc3857685b52dfdd18322dd3968d2f074a2d3ecc64434b9b4c7219fe9`, classified `payapi_platform_verification` and therefore excluded from customer revenue. Unclassified amount is `$0.00`; new independent-customer `treasury_received`, paid settlements, and revenue are all `$0.00`.

## Outreach limit

Three total outreach/reply emails have now been sent on the 2026-09-10 natural day, reaching the owner's daily cap. No further outreach email may be sent today. Silence will not be chased.
