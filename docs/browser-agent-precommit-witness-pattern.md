# Browser agent pre-commit witness pattern

Use this pattern when an automated browser is about to make a consequential decision based on what a **public** web page says now.

DELTA Witness is not the browser runner. The existing agent navigates normally; DELTA is inserted only at the boundary where the public page state becomes material to the next action.

## Where to place the checkpoint

Typical flow:

```text
browser agent
  -> navigate / inspect public page
  -> decide that the next step is consequential
  -> DELTA Capture or Preflight on the public source URL
  -> retain DELTA proof reference beside the action trace
  -> continue only according to the browser agent's own policy
```

Suitable public-source boundaries include:

- checkout price or availability before purchase/approval;
- vendor or supplier terms before procurement decisions;
- public policy, shipping, lead-time, disclosure, or eligibility pages before submission;
- public reference pages that materially determine a form or workflow branch.

Do **not** send DELTA authenticated dashboards, cookies, signed URLs, private customer records, or other non-public sources.

## Smallest integration

For a timestamped observation:

```http
POST https://delta-witness-api.ruphussten.workers.dev/v1/capture
Content-Type: application/json
```

```json
{"url":"https://public-source.example/page"}
```

The first unpaid call returns an x402 payment challenge. The buyer's own x402-capable client decides whether to authorize that challenge and retries the **same request** with the payment proof. DELTA never signs or pays on behalf of the buyer.

A successful response includes:

- `proof_id`
- `manifest_url`
- `public_proof_url`
- `bundle_root`
- `observed_at`

Store those identifiers with the browser action trace or audit record.

## Gate an action only when an explicit rule exists

Use `POST /v1/preflight` when the browser agent needs a deterministic check such as:

```json
{
  "url":"https://public-source.example/terms",
  "expected":{"contains":["ships within 5 business days"]}
}
```

The response can include `safe`, `changed`, `reason`, `diff`, and the proof reference. `safe` means the supplied deterministic expectation matched; it does **not** mean the source itself is truthful.

## Integration rules

- Query `GET /v1/quote?product=...` and follow the live HTTP 402 challenge instead of relying on cached directory data.
- Fail closed when the buyer's own payment policy does not authorize the returned challenge.
- Preserve request identity across retries; do not reuse one settled payment for a different request.
- Capture only genuinely material checkpoints, not every browser step.
- Keep raw browser credentials and private session state outside DELTA.

## Current machine-readable interfaces

- OpenAPI: https://delta-witness-api.ruphussten.workers.dev/openapi.json
- x402 discovery: https://delta-witness-api.ruphussten.workers.dev/.well-known/x402
- Agent skill: https://delta-witness-api.ruphussten.workers.dev/SKILL.md
- Health: https://delta-witness-api.ruphussten.workers.dev/health
