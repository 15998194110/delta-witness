# DELTA Autonomous Growth — 2026-09-10 10:28 +08

## A-grade production and Treasury evidence

- DELTA production returned valid x402 v2 HTTP 402 challenges for all three revenue routes:
  - Capture `/v1/capture`: `30000` raw canonical Base USDC = **$0.03**.
  - Preflight `/v1/preflight`: `30000` raw canonical Base USDC = **$0.03**.
  - Guarded Action Pilot `/v1/guarded-action-pilot`: `10000000` raw canonical Base USDC = **$10.00**.
- All three challenges used Base `eip155:8453`, canonical Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, and Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367`.
- Independent canonical USDC reconciliation completed through Base block **51,108,866**. The 50k-block scan found one Treasury candidate: the previously known `0xdac6c2ccc3857685b52dfdd18322dd3968d2f074a2d3ecc64434b9b4c7219fe9` $0.03 receipt from `0x7e6b6556322c4e26c567a867964ac793f5ee2b1c`, classified `payapi_platform_verification` and excluded from customer revenue.
- `unclassified_usdc = 0`; no new non-project Treasury receipt was observed. Customer `treasury_received`, customer paid settlements, and customer revenue remain **0 / 0 / $0.00** for this run.

## Funded-demand state

- PayanAgent public open-request feed remained reachable (`HTTP 200`) and still contained funded request `ks76vc9pzpz3qfgf8aawjckn5n8bezhf` (the $0.04 escrowed endpoint-health checker previously bid by DELTA).
- The public receipt feed was reachable (`HTTP 200`) and contained no matching DELTA acceptance/payout receipt for that request/bid. Existing bid `jd79ndx8s7y59tkcvjbars0vf18e33z9` was not duplicated or chased.
- The current open feed is noisy with many non-escrow seller advertisements; no new request was promoted to revenue status without escrow/settlement evidence.

## Distribution channels

- AgentNDX public servers feed returned `HTTP 200` but DELTA was still absent; prior direct submission remains pending/discovery-lagged.
- Tollbooth returned `HTTP 500` after bounded retries. This remains an isolated external channel degradation and did not block Treasury, production, Payan, or 402.ad work.

## 402.ad direct free submission attempt

- Public 402.ad search returned `HTTP 200` and no DELTA result before submission.
- The free website submission path was used; the paid `POST /v1/submit` route (**$0.10 USDC**) was deliberately not used because autonomous listing/payment fees are outside the standing financial boundary.
- First browser-runner attempt failed only because the Playwright module was written outside its module-resolution root; the failure was immediately converted into a retry and fixed.
- Retry successfully opened the x402 form and filled the required fields, including endpoint `https://delta-witness-api.ruphussten.workers.dev/v1/preflight`, agent context, goal, prior-search confirmation and search terms.
- 402.ad then presented **“Quick verification — Complete the challenge below to continue.”** The page remained in `Submitting...`; therefore **no completed submission or listing is claimed**. This is a UI anti-bot verification gate requiring human interaction, not a DELTA production failure or a terminal channel failure.
- No fee, wallet signature, key exposure, asset move, or irreversible action occurred.

## Run ledger

| channel/source | listing_status | discovery_status | buyer_count | settlement_count | verified_neighbor_demand | external_requests | 402_intents | paid_settlements | treasury_received | revenue | variable_cost | contribution_margin | evidence_quality |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| DELTA production | live | healthy | 0 | 0 | yes | 0 | 3 unpaid protocol probes | 0 | 0 | $0.00 | $0.00 | $0.00 | A — direct 402 |
| Base Treasury | n/a | reconciled to 51,108,866 | 0 | 0 customer | n/a | n/a | n/a | 0 customer | 0 new customer | $0.00 | $0.00 | $0.00 | A — canonical USDC logs |
| PayanAgent | existing bid | funded request still open | 1 funded request | 0 DELTA | yes, public confirmed receipts | 1 compatible known request | 0 new DELTA | 0 | 0 | $0.00 | $0.00 | $0.00 | A/B — public request + receipt feeds |
| 402.ad | form prepared; verification gate | not indexed | 0 | 0 | yes — adjacent paid preflight services indexed | 0 | 0 | 0 | 0 | $0.00 | $0.00 | $0.00 | A for gate state; no listing claim |
| AgentNDX | submitted previously | absent on readback | 0 | 0 | n/a | 0 | 0 | 0 | 0 | $0.00 | $0.00 | $0.00 | A — public feed |
| Tollbooth | unknown | degraded HTTP 500 | 0 | 0 | n/a | 0 | 0 | 0 | 0 | $0.00 | $0.00 | $0.00 | B — repeated external failure |
