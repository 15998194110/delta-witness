# DELTA Witness for Amazon Bedrock AgentCore payments

This is a buyer-side quickstart for agents that already use Amazon Bedrock AgentCore payments and need independent evidence of what a public web page said before a consequential downstream action.

DELTA is not a truth oracle. It records a bounded public-page observation and returns evidence/proof metadata. Use the narrowest paid product that matches the job.

## Best first purchase: Capture — 1 USDC

Use Capture when the agent needs a durable observation of a public page before it acts.

Common repeat-use checkpoints:

- procurement: preserve vendor terms, MOQ, lead time, shipping language, or a public quote page before submitting a purchase request;
- commerce: preserve price and availability before checkout or price-sensitive automation;
- monitoring: preserve the source page behind a material alert before another agent reacts;
- compliance/audit: preserve a public policy or disclosure page before recording a decision.

Endpoint:

```text
POST https://delta-witness-api.ruphussten.workers.dev/v1/capture
Content-Type: application/json
```

Initial request body:

```json
{"url":"https://example.com"}
```

The initial unpaid request returns HTTP `402` with an x402 v2 payment requirement. The current production charge is **1.00 USDC** on Base mainnet. Complete the x402 payment using the buyer's configured payment tooling, then retry the same request with the payment proof/signature required by that tooling.

Production invariants:

- network: Base `eip155:8453`
- asset: canonical Base USDC `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`
- Capture amount: `1000000` raw USDC units = **1.00 USDC**
- DELTA Treasury: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`

Do not copy a historical or cached price from a third-party directory. The live 402 challenge and DELTA OpenAPI are the source of truth.

## When to use Public Preflight — 5 USDC

Use Public Preflight only when the agent needs a deterministic rule evaluation before it proceeds, rather than a source snapshot alone.

```text
POST https://delta-witness-api.ruphussten.workers.dev/v1/preflight
Content-Type: application/json
```

Example:

```json
{
  "url":"https://example.com",
  "expected":{"contains":["Example Domain"]}
}
```

The initial request returns HTTP `402`; the current production charge is **5.00 USDC** (`5000000` raw canonical Base USDC). After settlement, the response returns deterministic preflight fields plus a proof reference. DELTA proves observation/change against the supplied rule or prior evidence; it does not certify that the source is truthful.

## Guarded-Action Pilot — 10 USDC

`POST /v1/guarded-action-pilot` is the higher-value **10.00 USDC** evidence layer. Do not use it for routine snapshots when Capture is sufficient.

## AgentCore buyer setup

Amazon Bedrock AgentCore payments supports autonomous payment for paid APIs, MCP servers, and web content using x402, with payment connections, wallet management, payment limits, processing, and observability. Configure the buyer's own payment policy before calling DELTA.

For a first DELTA Capture, the buyer's per-transaction limit must explicitly allow at least **1.00 USDC**. A lower buyer-side cap should fail closed; DELTA does not ask an agent to silently raise its budget. Public Preflight requires the buyer to explicitly allow **5.00 USDC**, and the Guarded-Action Pilot requires **10.00 USDC**.

Official AgentCore payments documentation:

- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-how-it-works.html
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-connect-bazaar.html

AgentCore Gateway can also connect to paid MCP/API resources through Coinbase x402 Bazaar. If DELTA is discovered through a marketplace, still verify the live DELTA 402 amount before payment because third-party catalogs can lag current pricing.

## Purchase rule for recurring workflows

Treat each genuine new checkpoint as a separate customer need. Do not replay or deliberately split one paid request to manufacture transaction count. DELTA's fulfillment is idempotent, and already-settled/idempotent deliveries must not be charged again.

For recurring agents, a practical policy is:

1. Capture only when the public state is economically or operationally material.
2. Store the returned proof reference with the downstream action record.
3. Re-Capture only for a genuinely new checkpoint or changed decision context.
4. Escalate to Public Preflight only when an explicit rule must gate the action.

## Verify before integrating

- Health: https://delta-witness-api.ruphussten.workers.dev/health
- OpenAPI: https://delta-witness-api.ruphussten.workers.dev/openapi.json
- x402 metadata: https://delta-witness-api.ruphussten.workers.dev/.well-known/x402
- Agent skill: https://delta-witness-api.ruphussten.workers.dev/SKILL.md
- Postman collection: `distribution/postman/DELTA-Witness.postman_collection.json`
