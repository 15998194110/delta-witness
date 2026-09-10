# DELTA pricing deployment evidence — 2026-09-10

## Result

The latest explicit owner pricing authority is now deployed and production-verified. Current commercial ladder for **new billable requests**:

| Surface | Price |
|---|---:|
| Public Capture | **$1.00 USDC** |
| Authenticated Partner Capture | **$1.00 USDC** |
| Authenticated Partner Preflight | **$1.00 USDC** |
| New Watch check | **$1.00 USDC per check** |
| Public Preflight | **$5.00 USDC** |
| Guarded-Action Pilot | **$10.00 USDC** |

Only a newer explicit owner pricing instruction may replace this ladder. Old `$0.03` and `$1 Public Preflight` mandates are historical and are not current billing authority.

## Production deployment

A guarded GitHub Actions production deployment fetched the freshest `origin/master`, asserted the owner policy, ran full core and partner verification, preserved the existing Cloudflare secrets/bindings, deployed both Workers, and then performed direct live production probes.

Final successful deployment attempt completed at `2026-09-10T06:24:23Z`.

- core Worker version: `7f5fff7e-80e8-4669-9ca5-06f3f7944d63`
- Partner Gateway version: `59e43710-fcdc-440b-b606-e1ad8242f5e7`
- core test result: **11 test files / 57 tests passed**
- Partner Gateway test result: **2 test files / 7 tests passed**
- typecheck and dry-run builds passed for both Workers

## Live public x402 verification

Direct unpaid POST challenges after rollout returned:

| Product | HTTP | Raw canonical Base USDC | USD | Network | Pay-to |
|---|---:|---:|---:|---|---|
| Capture | 402 | `1000000` | **$1.00** | `eip155:8453` | existing Treasury |
| Public Preflight | 402 | `5000000` | **$5.00** | `eip155:8453` | existing Treasury |
| Guarded-Action Pilot | 402 | `10000000` | **$10.00** | `eip155:8453` | existing Treasury |

Existing Treasury: `0x1990e21bc219696ff7fbc26527dbaed335ac6367`.
Canonical Base USDC: `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`.

The first immediate post-deploy probe briefly observed Capture on the new version and Preflight on an older edge version. A separate bounded semantic probe then returned the full `1000000 / 5000000 / 10000000` ladder on its first attempt. The final full deployment verification also passed all three amounts. This was rollout propagation, not a persistent pricing defect.

## Partner / Watch verification

Without performing fulfillment or a paid canary, authenticated internal pricing probes with `x-delta-gross-usd: 0` verified the current minimums:

- Partner Capture minimum: **$1.00**
- Partner Preflight minimum: **$1.00**
- one new Watch check required total: **$1.00**
- Partner Gateway health: healthy, service binding active

Existing prepaid/idempotent historical obligations are grandfathered at their already-paid identity so a price change does not create a second charge. New Watch purchases use the current $1/check price.

## Fixed-price protection

The pricing module no longer autonomously invents a fourth customer-facing price from modeled cost floors or historical R2 pricing overrides. The owner-authorized ladder is fixed until a newer explicit owner decision. If actual fulfillment economics become negative, DELTA records a pricing-margin risk alert instead of silently repricing the customer.

## Treasury reconciliation after deployment

Independent Base reconciliation completed through block **51,116,056** over the latest 50,000-block window.

- canonical USDC Treasury receipt candidates: 1
- total received in window: `$0.03`
- classification: `payapi_platform_verification`
- known non-customer amount: `$0.03`
- unclassified amount: `$0.00`
- new independent-customer `treasury_received`: **$0.00**
- new customer revenue: **$0.00**
- evidence quality: **A — direct canonical Base USDC log**

The historical transaction remains `0xdac6c2ccc3857685b52dfdd18322dd3968d2f074a2d3ecc64434b9b4c7219fe9`; it is a platform verification transfer and is excluded from customer revenue.

## Operational cleanup

The one-shot workflows used only for this pricing migration, regression repair, and rollout propagation probe were removed after successful verification. Current pricing authority remains in `AGENTS.md`, `docs/pricing-policy-2026-09-10.md`, runtime configuration, and regression tests.