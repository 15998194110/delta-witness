# DELTA autonomous distribution status — 2026-09-02

Treasury: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`

Revenue stages are intentionally non-interchangeable:

1. `value_authored`: a valid payment challenge or authorization was created.
2. `payment_authorized`: a payer supplied a valid authorization.
3. `settlement_confirmed`: the payment rail returned a confirmed settlement and transaction hash.
4. `treasury_received`: the settled asset transfer to the Treasury was independently confirmed.

Only a non-owner, non-canary external call reaching stage 4 is Stranger Revenue. Discovery crawls and unpaid 402 probes are not revenue.

| channel | registration status | discovery status | external request | 402 intent | settlement | treasury_received | revenue | variable cost | contribution margin | evidence | tx hash |
|---|---|---|---|---|---|---|---:|---:|---:|---|---|
| Agent402 | Accepted: 5 tools, 2 paid, Base mainnet, routable | Fresh crawl at 2026-09-02 14:44 UTC has the new Capture/Guard names. The three target queries still fall outside the top 25, so operation IDs were changed to buyer-intent slugs and redeployed; the next crawler refresh is pending. | Agent402 crawler requested both routes | Both routes returned x402 v2 402, 30,000 atomic Base USDC, Treasury payTo | none | no | $0 | $0 fulfillment cost | $0 | [seller detail](https://agent402.tools/api/index?seller=delta-witness-api.ruphussten.workers.dev) | none |
| x402 Arena | Complete: `delta-witness-capture` and `delta-witness-guard`, verified/active/Bazaar-compatible | Both are publicly returned by operator catalog | Arena verifier requested both routes | Verified 0.03 USDC on `eip155:8453`, Treasury payTo | none | no | $0 | $0 fulfillment cost | $0 | [operator catalog](https://core.x402arena.gg/operator/agents) | none |
| PayanAgent | Complete: provider `j57c8s34n1gm5hp5jqzjf6fzm58dmqv8`; Capture `kh79t54410qb82yjcqsjmgv0d58dn7p3`; Guard `kh72vd1kdv37109xxzzgmn2xfn8dnc6z` | `browser verification` and `page state proof` recall Capture; `preflight autonomous action` recalls Guard | Both public buy URLs were probed | Both returned 402 for 30,000 atomic Base USDC to Treasury | none | no | $0 | $0 fulfillment cost | $0 | [provider](https://payanagent.com/api/v1/agents/j57c8s34n1gm5hp5jqzjf6fzm58dmqv8), [Capture offer](https://payanagent.com/api/v1/offers/kh79t54410qb82yjcqsjmgv0d58dn7p3), [Guard offer](https://payanagent.com/api/v1/offers/kh72vd1kdv37109xxzzgmn2xfn8dnc6z) | none |
| Market402 | Both routes accepted and queued with 0.03 USD declaration, sample input, and paid-probe opt-in | Not yet in catalog/search | Market402 self-test reached both routes | Runtime 402 is valid; Market402's current probe ignores the v2 `Payment-Required` header and expects terms in the JSON body | none | no | $0 | $0 fulfillment cost | $0 | [search](https://market402.com/search.json?q=delta-witness-api.ruphussten.workers.dev) | none |
| ASSAY | No public submission API or form; no unauthorized internal action taken | DELTA not ingested yet; ASSAY refreshes Coinbase Bazaar every 6 hours | Free tier lookup only | no | none | no | $0 | $0 | $0 | [official source](https://github.com/JasonCZMeng/assay) | none |
| PayAPI Market | Not submitted: listing requires a human identity/email/Base-wallet review flow | No DELTA listing | none | none | none | no | $0 | $0 | $0 | [listing flow](https://payapi.market/list) | none |
| x402bazaar.org | Not registered: registration itself requests a 1 USDC payment | Public search currently has no DELTA result | Registration endpoint returned 402 | 1 USDC platform-registration intent only; deliberately unpaid | none | no | $0 | $0 | $0 | [search](https://x402-api.onrender.com/search?q=delta-witness) | none |
| x402scan / AgentCash | Preview parses six resources; formal origin registration is SIWX-gated | Preview only; formal registry status cannot be asserted without signature | Registry endpoint requested wallet authentication | SIWX auth challenge, not a DELTA purchase | none | no | $0 | $0 | $0 | [AgentCash discovery](https://agentcash.dev/discovery), [x402scan registration](https://www.x402scan.com/resources/register) | none |

## Production payment gate evidence

On 2026-09-02, unauthenticated `POST /v1/capture` and `POST /v1/preflight` both returned HTTP 402 before Browser Run. Their decoded x402 v2 requirements specified:

- scheme: `exact`
- network: `eip155:8453`
- asset: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Base USDC)
- amount: `30000`
- payTo: Treasury
- payment flow: `upfront`

No owner-funded canary, wallet signature, paid registry fee, settlement, R2 write, or Browser Run was initiated during this distribution pass.

The complete PayAI Bazaar scan at 2026-09-02 15:03 UTC checked all 27,981 resources and found no DELTA match. Market402 also remained queued and absent from search. These are discovery-state facts, not failed DELTA requests or revenue events.
