# AQUIX independent evidence — 2026-09-09

Status: external corroboration of the existing historical DELTA x402 receipt; not a new payment and not a new revenue event.

AQUIX's public `Known, not measured` census independently surfaces `delta-witness-api.ruphussten.workers.dev` with Treasury `0x1990…6367`, the DELTA Preflight description, one observed payment, `$0.03`, and first-seen date 2026-09-07. AQUIX marks DELTA `Not examined`; this is not an AQUIX verdict or verified-agent badge.

AQUIX's published methodology is materially stronger than a generic token-transfer index for settlement classification. It states that an x402 payment is counted only when canonical Base USDC settlement evidence also carries an `AuthorizationUsed` event whose authorizer matches the party sending the transfer, reconstructing the EIP-3009 exact scheme. Therefore its DELTA row is independent evidence consistent with the historical 0.03 USDC receipt being an x402 settlement rather than an arbitrary USDC transfer. AQUIX also explicitly states its blind spots: Permit2, upto and batch-settlement activity may be invisible, so absence in AQUIX would not prove absence of payment.

This does not by itself prove the payer is unrelated to the project. The repository's current default branch contains no code-search hit for the historical payer address `0x7E6b6556322c4e26c567a867964aC793f5eE2b1c`. Separately, a current public 402radar page for an unrelated provider (`toolshed.lemon-agent.dev`) shows that same payer address making a 0.002 USDC x402 settlement to that unrelated provider. This is independent behavioral evidence consistent with a general external x402 buyer wallet, but it is not cryptographic identity proof and should not override the sprint owner's final canary/test exclusion review.

Historical DELTA transaction under review remains:
`0x5ae76f54c158d24f03b86aed0a20482e8de2a35983941c03fe60d131c19cd7b3`

Fresh revenue reconciliation immediately before this note found no new canonical USDC receipts to Treasury from Base block 51049135 through 51052683, `candidate_rows=0`, and no `qualified_request`, `payment_verified`, or `capture_completed` telemetry since the prior checkpoint. Therefore this evidence changes confidence/classification only; `treasury_received` added in this run remains 0 USDC.

Distribution readback in the same run was deliberately read-only. APIHub's public external catalog, x402-list's public catalog, and Agora402 discovery returned no exact DELTA match at the check time. APIHub remains strategically relevant because its MCP supports searching/calling external x402 APIs with prepaid credits and pays the external provider on the buyer's behalf; however propagation is not claimed until an exact DELTA readback exists. No provider wallet signature, fee, listing payment, canary, or new account was used.
