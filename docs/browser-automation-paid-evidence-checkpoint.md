# Browser automation → DELTA paid evidence checkpoint

This is the shortest buyer-side pattern for browser-automation teams that already execute scrapes, monitors, form flows, or multi-step browser jobs and need an independent public-page record before a consequential downstream action.

DELTA does not replace the browser runner. The existing automation finds the relevant public source URL; DELTA is called only when that state is worth preserving or testing.

## Start with one 1 USDC Capture

Use Capture for a genuinely material public source state such as:

- price or availability before checkout, repricing, purchase approval, or escalation;
- supplier/vendor terms before procurement approval;
- a public policy, shipping, lead-time, disclosure, or compliance page before an audit-sensitive action;
- a source article or public record that will drive an automated decision.

```text
POST https://delta-witness-api.ruphussten.workers.dev/v1/capture
Content-Type: application/json
```

```json
{"url":"https://public-source.example/page"}
```

The unpaid request returns HTTP `402`. The current Capture charge is **1.00 USDC** on Base mainnet (`1000000` raw canonical Base USDC). The buyer's own x402-capable client settles the challenge and retries the same request with its payment proof.

Production invariants:

- network: Base `eip155:8453`
- asset: canonical Base USDC `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`
- Treasury: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`

Always read the live DELTA 402 challenge and first-party OpenAPI instead of cached directory pricing.

## Repeat-use policy

Do not Capture every browser run. A useful commercial integration is selective:

```text
browser workflow
  -> ordinary/no material change: no DELTA purchase
  -> consequential public-state checkpoint:
       -> DELTA Capture (1 USDC)
       -> store proof reference beside the workflow result
       -> continue downstream action
```

A repeated purchase should correspond to a genuinely new checkpoint: a changed price, changed availability, changed vendor term, new approval event, or another distinct decision context. Do not replay an idempotent request or split one commercial need into artificial transactions.

## Use Preflight only when a rule must gate the action

When the downstream action depends on an explicit text rule, use Public Preflight:

```text
POST https://delta-witness-api.ruphussten.workers.dev/v1/preflight
Content-Type: application/json
```

```json
{
  "url":"https://public-source.example/terms",
  "expected":{"contains":["ships within 5 business days"]}
}
```

Public Preflight is **5.00 USDC** (`5000000` raw canonical Base USDC). Guarded-Action Pilot is the higher-value **10.00 USDC** layer. Routine monitoring should remain on Capture unless the extra gating semantics are actually needed.

## Integration boundaries

- Pass only public HTTP(S) source URLs; keep browser-platform credentials, cookies, signed/private result URLs, and private dashboards out of DELTA.
- Buyer payment limits should fail closed. Enabling at least 1.00 USDC for Capture is an explicit buyer decision; DELTA never silently raises a buyer's spend limit.
- DELTA records bounded evidence of what a public source returned. It does not certify that the source itself is truthful.
- A settled request cannot fulfill a different request and must not be double-charged.

## Verify before integrating

- Health: https://delta-witness-api.ruphussten.workers.dev/health
- OpenAPI: https://delta-witness-api.ruphussten.workers.dev/openapi.json
- x402 metadata: https://delta-witness-api.ruphussten.workers.dev/.well-known/x402
- Agent skill: https://delta-witness-api.ruphussten.workers.dev/SKILL.md
