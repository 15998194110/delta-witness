# DELTA Witness pricing policy — 2026-09-10

## Current owner-authorized ladder

This document is the current pricing authority for DELTA Witness. It supersedes the September 8 public Preflight experiment and every older automation prompt, copied standing mandate, cached listing price, or operator note that conflicts with it.

| Billing surface | Price for new billable requests |
|---|---:|
| Public Capture | **$1.00 USDC** |
| Authenticated Partner Capture | **$1.00 USDC** |
| Authenticated Partner Preflight | **$1.00 USDC** |
| New Watch check | **$1.00 USDC per check** |
| Public Preflight | **$5.00 USDC** |
| Guarded-Action Pilot | **$10.00 USDC** |

The commercial ladder is therefore **$1 → $5 → $10**.

## Authority

The owner explicitly designated this instruction as the highest pricing authority and instructed DELTA to charge according to it going forward. Only a newer explicit owner pricing instruction may replace it. Historical `$0.03` and `$1 Public Preflight` instructions are obsolete for new billing.

Automation prompts are operational instructions, not pricing authority. If a later automation prompt still contains `$0.03 capture/preflight`, it must be treated as stale and must not overwrite this policy.

## Settlement and replay semantics

- New public Capture challenges must request `1000000` raw canonical Base USDC.
- New public Preflight challenges must request `5000000` raw canonical Base USDC.
- Guarded-Action Pilot remains `10000000` raw canonical Base USDC.
- New Partner Capture, Partner Preflight and Watch purchases use a `$1.00` entry floor.
- Already completed/idempotent deliveries retain their historically settled payment identity and must not be charged again.
- Already prepaid obligations are historical commitments; do not rewrite settlement history merely because the current price changed.
- Platform verification, self-pay, canaries and test transfers remain excluded from customer revenue.

## Production invariants

All live x402 public charges continue to use:

- network: Base `eip155:8453`
- canonical USDC: `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`
- Treasury: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`

A pricing deployment is not complete until direct production probes verify the three public amounts as **1000000 / 5000000 / 10000000** and the unchanged Treasury/network. Partner Gateway configuration must also read back as `$1` for Capture, Preflight and Watch.

## Distribution synchronization

Provider OpenAPI, agent manifest and first-party discovery should derive public Capture/Preflight prices from runtime quotes. External directories that cache old prices should be refreshed only through free/no-account/programmatic update paths where safe. Do not self-pay or create artificial settlement solely to refresh a directory. Do not create duplicate seller identities or duplicate offers when an existing listing can be updated or allowed to recrawl.

## Revenue discipline

A higher list price is not revenue. Continue to keep `value_authored`, `payment_authorized`, `settlement_confirmed` and `treasury_received` distinct. Only verified non-project customer `treasury_received`, reconciled with DELTA proof/telemetry and actual fees/refunds/liabilities, may be counted as customer revenue or realized contribution margin.
