# Public Preflight price experiment — 2026-09-08

Owner approved execution of the proposed public Preflight 1 USDC price experiment and continued free market expansion. This changes new public Preflight calls only; it does not establish proven willingness to pay at this price.

| Route | Base USDC price |
|---|---:|
| Public Capture | 0.03 |
| Public Preflight | 1 |
| Guarded Action Pilot | 10 |
| Existing authenticated partner Preflight floor | 0.03 |
| Watch check base price | 0.03 |

All prices remain subject to the existing cost-floor safeguards. No new public product, IP grant, refund promise, delivery guarantee or funded canary is authorized. Existing prepaid gateways retain their rates. Fresh unpaid requests must obtain the current 402 challenge; do not reuse an unaccepted stale quote. Already settled matching payments retain idempotent delivery and their original price. Retried delivery is not another payment event.

Preflight is a deterministic page observation and comparison, not a security audit or a guarantee that an autonomous action is safe. Provider OpenAPI, agent manifest, skill and x402 discovery derive their public prices from the runtime quote.

Validation: generated runtime types, TypeScript check, 54 core tests and production bundle dry-run passed. Regressions cover canonical 402 header/body amounts, correct treasury, no unpaid browser execution or settlement, old-price completed replay, settled retry pricing, partner replay and separate Watch pricing. No real paid transaction was generated for this release; paid execution is tested with mocks and the existing payment logic, not a new live end-to-end settlement.

Rollback baseline: Cloudflare Worker version `eda4dcb0-7c1b-440f-8f97-23176ab94183` (deployment `9db83d7d-9bed-4680-8618-9af50fa11013`). Keep the owner-controlled treasury, bindings, secrets and existing cron unchanged.

Assess actual qualified paid orders and receipt/fulfilled-net evidence during the fixed sprint ending 2026-09-14 03:01:23 Asia/Shanghai. Listing refreshes, our own probes and modelled margins are not revenue. One diagnostic review after genuine buyer feedback or the next scheduled batch; no repeated repricing or manufactured demand.
