# PayanAgent funded demand — 2026-09-08

## Candidate

- Channel: PayanAgent
- Request: `ks76vc9pzpz3qfgf8aawjckn5n8bezhf`
- Title: `Build a catalog endpoint-health checker (find dead ecosystem sellers)`
- Status observed: `open`
- Budget: `$0.04`
- Platform escrow flag: `true`
- Platform-reported escrow deposited: `$0.04`
- Escrow receipt: `kn76vdyp5sb7kk2bqs130mhrx98bf90e`
- Task fit: technically compatible, no paid calls required, positive marginal economics if awarded.

## Funding evidence

Public Payan receipt lookup returned:

- `settlementType=escrow_deposit`
- `status=confirmed`
- `amountCents=4`
- `network=eip155:8453`
- `currency=USDC`
- transaction `0x345bc8f17283645ea290ff96cdde92477e9a95fea6a3397692ae1d4c2c2143ba`

Independent Base RPC verification found the transaction confirmed successfully on Base at block `49278856`, targeting canonical Base USDC. The receipt contains a canonical-USDC Transfer event for `40000` raw units = `0.04 USDC`.

### Contradiction requiring caution

The Transfer event decoded from that transaction shows the same address as both `from` and `to` (`0xa72ddaa10982935c58783ef850bea3625790b2a3`). That does not independently demonstrate custody/locking of the funds despite the marketplace receipt saying `escrow_deposit` and `confirmed`. Therefore this opportunity is **evidence grade B, not A**, and is not treated as independently proven escrow under DELTA's strict settlement standard.

## Action decision

No bid was submitted.

Reasons:

1. Strict evidence gating: marketplace escrow metadata and the chain event do not fully reconcile.
2. DELTA's existing PayanAgent offers are live, but the one-time seller API key used to create them was not persisted into the repository's available Actions secrets.
3. A test confirmed the repository workflow token cannot create/update Actions secrets (`403 Resource not accessible by integration`). Registering a duplicate seller solely to obtain an ephemeral key would create an orphaned control credential and is not justified for a four-cent request.

## DELTA channel state observed in the same run

PayanAgent public discovery returned all three DELTA offers active with `rankScore=1000`:

- Capture — `$0.03`, Base USDC, Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367`
- Guard Preflight — `$0.03`, Base USDC, same Treasury
- Guarded Action Pilot — `$10`, Base USDC, same Treasury

## Core / revenue reconciliation

- Production Capture: valid HTTP 402 at `$0.03`.
- Production Preflight: valid HTTP 402 at `$0.03`.
- Production Guarded Action Pilot: valid HTTP 402 at `$10`.
- Canonical Base USDC Treasury scan after the last reconciled block found no new transfers to DELTA Treasury.
- D1 paid-fulfillment telemetry in the checked interval contained no new qualified/payment/fulfillment events.
- Strict DELTA customer revenue remains: `1` independent buyer, `1` paid settlement, `$0.03` revenue, `$0.002163522555` variable cost, `$0.027836477445` contribution margin.
