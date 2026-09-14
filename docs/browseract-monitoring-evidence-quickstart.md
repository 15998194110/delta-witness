# DELTA Witness after BrowserAct monitoring

This is a buyer-side integration recipe for teams already using BrowserAct Data API, ecommerce templates, or news-monitoring workflows and needing an independent evidence checkpoint before a consequential downstream action.

It does **not** require BrowserAct to trust DELTA or DELTA to receive a BrowserAct API key. BrowserAct performs the collection. DELTA receives only the public source URL selected for an economically or operationally material checkpoint.

## Best first purchase: Capture — 1 USDC

Use DELTA Capture after BrowserAct has identified a source state worth preserving, for example:

- a product price or availability result before a checkout, purchase request, repricing decision, or alert;
- a supplier/vendor public page before a procurement approval;
- the source article behind a material news alert before another agent acts on it;
- a public policy, terms, shipping, lead-time, or disclosure page before an audit-sensitive decision.

BrowserAct's Amazon product workflows expose source product URLs, and its Google News workflows expose article links. Pass the relevant **public source URL**, not BrowserAct credentials or private task data, to DELTA.

Endpoint:

```text
POST https://delta-witness-api.ruphussten.workers.dev/v1/capture
Content-Type: application/json
```

Initial body:

```json
{"url":"https://public-source.example/item-or-article"}
```

The unpaid request returns HTTP `402` with an x402 v2 payment requirement. The current production Capture charge is **1.00 USDC** on Base mainnet. Complete the payment with the buyer's own x402-capable tooling, then retry the same request with the payment proof required by that tooling.

Production invariants:

- network: Base `eip155:8453`
- asset: canonical Base USDC `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`
- Capture amount: `1000000` raw USDC units = **1.00 USDC**
- DELTA Treasury: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`

Always trust the live DELTA 402 challenge and first-party OpenAPI over cached third-party catalog prices.

## Minimal monitoring handoff

A repeat-use workflow should stay selective:

1. BrowserAct runs the normal product/news/monitoring job.
2. The buyer's logic decides whether the result is materially different or consequential.
3. If not material, do nothing and spend nothing on DELTA.
4. If material, take the public source URL from the BrowserAct output and call DELTA Capture.
5. Store the returned DELTA proof reference beside the BrowserAct result and downstream action record.
6. Re-Capture only for a genuinely new checkpoint or changed decision context.

This keeps DELTA as an evidence layer, not a duplicate scraper.

## Example decision policy

```text
BrowserAct result
  -> no material change: stop
  -> material price/availability/source change:
       -> DELTA Capture (1 USDC)
       -> persist proof reference
       -> downstream agent decides/acts
```

Examples of a material trigger include a price crossing a buyer-defined threshold, an item becoming unavailable, supplier terms changing, or a monitored article becoming the basis for an automated decision.

## Escalate only when a rule must gate the action

If the agent must evaluate an explicit text rule before proceeding, use Public Preflight instead of a simple snapshot:

```text
POST https://delta-witness-api.ruphussten.workers.dev/v1/preflight
Content-Type: application/json
```

Example:

```json
{
  "url":"https://public-source.example/terms",
  "expected":{"contains":["ships within 5 business days"]}
}
```

The current Public Preflight price is **5.00 USDC** (`5000000` raw canonical Base USDC). Use it only when the deterministic rule evaluation is worth the higher charge. Guarded-Action Pilot remains the higher-value **10.00 USDC** layer and should not replace routine Capture.

## Safety boundaries

- DELTA accepts public HTTP(S) targets only; do not pass authenticated BrowserAct result URLs, credentials, private dashboards, or signed/private source links.
- Keep `BROWSERACT_API_KEY` in the BrowserAct environment/secret manager. It is not a DELTA input.
- Buyer payment limits should fail closed. For Capture, explicitly allow at least 1.00 USDC only if the buyer has chosen that paid checkpoint. Raising a buyer-side limit is a buyer decision, not something DELTA performs silently.
- DELTA records bounded evidence of what a public source returned. It does not certify that the source is truthful.
- One settled/idempotent request must never be replayed or split to manufacture transaction count.

## BrowserAct references

- Data API: https://www.browseract.com/data-api
- Amazon Product API skill: https://skills.browseract.com/skills/browser-act-skills-amazon-product-api-skill
- Google News Full Article Monitor: https://www.browseract.com/template/google-news-full-article-monitor/run-task

## DELTA verification

- Health: https://delta-witness-api.ruphussten.workers.dev/health
- OpenAPI: https://delta-witness-api.ruphussten.workers.dev/openapi.json
- x402 metadata: https://delta-witness-api.ruphussten.workers.dev/.well-known/x402
- Agent skill: https://delta-witness-api.ruphussten.workers.dev/SKILL.md
