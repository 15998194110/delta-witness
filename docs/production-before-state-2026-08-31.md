# Production before-state — 2026-08-31

Captured from `https://delta-witness-api.ruphussten.workers.dev` at approximately
2026-08-31 02:55 UTC, before any deployment from the v0.5 handoff.

## Core responses

- `GET /health` — 200: `{"ok":true,"ts":"2026-08-31T02:55:24.150Z"}`.
  The deployed response did not include a version.
- `GET /v1/quote` — 200: `{"product":"fresh_web_proof","price":"$0.03","network":"eip155:84532","asset":"USDC","pay_to":"0x1990e21bc219696ff7fbc26527dbaed335ac6367"}`.
  Production was therefore Base Sepolia, not Base mainnet.
- `GET /v1/proofs/56347db8-1aa5-447f-a0e4-3bb052d7aa89` — 200. The
  immutable response body hash was
  `sha256:2bbb6defd59a55919105d1a8ebddcd14c8a98468230ae22b5e886097783605d1`.
  The manifest reported schema `delta-proof-bundle/v0.2`, requested URL
  `https://example.com/`, capture completion at `2026-08-31T01:28:53.762Z`,
  bundle root `sha256:19e2c757e3955bc9b0ee0d1f60d2ec82f41aeee163902733ed9dac2e01e57a4b`,
  and private R2 keys below the proof UUID.
- `GET /` — 200 JSON reporting application version `0.2.0` and network
  `eip155:84532`.

## Public discovery surface status

| Endpoint | Status before deployment |
| --- | ---: |
| `/robots.txt` | 200 (Cloudflare-managed content-signals file) |
| `/v1/demo` | 404 |
| `/docs` | 404 |
| `/.well-known/x402` | 404 |
| `/.well-known/x402.json` | 404 |
| `/x402.json` | 404 |
| `/accepted` | 404 |
| `/.well-known/api-catalog` | 404 |
| `/openapi.json` | 404 |
| `/.well-known/openapi.json` | 404 |
| `/llms.txt` | 404 |
| `/.well-known/llms.txt` | 404 |
| `/llms-full.txt` | 404 |
| `/.well-known/llms-full.txt` | 404 |
| `/AGENTS.md` | 404 |
| `/SKILL.md` | 404 |
| `/skill.md` | 404 |
| `/distribution.json` | 404 |
| `/postman.json` | 404 |
| `/sitemap.xml` | 404 |
| `/indexnow-key.txt` | 404 |

Every 404 body above was the same 13-byte `404 Not Found` response with SHA-256
`7d04f7431bbfa41a04bcc7e6b98b9de0d919756c4c671c5785c99fff45f16402`.

## Preservation constraints

- Worker name: `delta-witness-api`.
- R2 bucket: `delta-witness-proofs`.
- Known proof UUID and all existing R2 objects must be preserved.
- No deployment, object deletion, or object-publicity change was performed while
  capturing this baseline.
