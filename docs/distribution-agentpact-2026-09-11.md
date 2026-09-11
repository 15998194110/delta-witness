# DELTA Witness × AgentPact distribution — 2026-09-11

## Result

DELTA Witness is now registered on AgentPact with a single deterministic agent identity and three publicly readable active offers under the current owner-authorized **1 / 5 / 10 USDC** commercial ladder.

- Agent UUID: `5fdb4f2a-0d15-4e27-8d4a-15998194110d`
- Profile handle: `delta-witness`
- Settlement wallet: existing DELTA Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367`
- New wallet created: **no**
- Auto-buy: **disabled**
- Offer negotiation deviation: **0%**
- Settlement rail advertised by the offers: **USDC**
- Registration/listing cash outlay: **$0**
- Wallet signature / asset movement: **none**

## Public offer readback

AgentPact's public offers API independently returned all three offers as `active` immediately after publication:

| Offer | AgentPact offer ID | Price |
|---|---|---:|
| DELTA Witness Capture — Public Web Evidence | `e0591c9f-48d3-43fb-b297-c540b986b29f` | **1 USDC** |
| DELTA Witness Public Preflight — Deterministic Verification | `8e29257c-3b53-445a-a827-5aef416bd3c5` | **5 USDC** |
| DELTA Witness Guarded-Action Pilot — Higher-Value Evidence | `e70aad83-2af5-4495-8225-1abc6030bb97` | **10 USDC** |

The publication run first verified live DELTA production prices as raw canonical Base USDC `1000000 / 5000000 / 10000000`, with the existing Treasury and `eip155:8453`. Authenticated Partner Capture, Partner Preflight and new Watch-check floors also read back as 1 USDC.

## Demand scan

A read-only scan of the latest 100 public AgentPact needs returned 9 keyword-matched candidates. No deal was proposed or accepted by DELTA because the current AgentPact seller flow is buyer-initiated: the seller makes offers discoverable and the buyer proposes/funds a deal.

Two open needs were especially adjacent to DELTA's existing entry-layer capability:

- `f7d0b323-a1a2-4fe5-885e-65a7721b9e47` — **[Fleet buyer] Public API endpoint sanity check** — budget 1 USDC.
- `02cd45a5-c376-4452-859b-0ef2c2aad3be` — **[Fleet buyer] Quick public-source evidence screen on USDC (Base)** — budget 1 USDC.

These are evidence of adjacent open demand only. They are **not** classified as funded buyer orders, independent settlements, or customer revenue. The `fleet-buyer` tag is a contradiction/risk signal and prevents upgrading them beyond low-confidence demand evidence until an independent buyer and funded deal are verified.

Other matching needs included web-scraping and code/security work with budgets up to 25 USDC, but they were not treated as DELTA orders because their scope does not cleanly match the current product contract.

## Credential handling

AgentPact issued an API key during registration. It was never written to repository content or printed in plaintext logs. The run masked it immediately and stored only an AES-256-GCM encrypted credential artifact, protected using an existing DELTA secret-derived key. No private wallet key exists in DELTA for this integration.

## Revenue / Treasury

The same run independently reconciled the Base Treasury after publication through block **51,170,348** over the latest 50,000-block window:

- canonical USDC incoming candidates: `0`
- `treasury_received`: **0 USDC**
- unclassified USDC: **0**
- new customer revenue: **0 USDC**
- evidence quality for the Treasury result: **A — direct canonical Base USDC log**

The AgentPact listing milestone is therefore distribution, not revenue. Future revenue requires a buyer-initiated funded deal plus DELTA fulfillment and Treasury/settlement reconciliation.
