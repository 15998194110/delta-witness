# DELTA Acquisition Engine v0.6

North star: first **independent customer** payment, then repeatable CAC ≈ 0 channels.

Formula:

`Revenue = Discovery Surface × Qualified Intent × Payment Conversion × Delivery Success × Repeat Usage × ARPU`

The system expands Discovery Surface without adding sales labor.

## Revenue evidence invariant

A Base USDC transfer into Treasury is `treasury_received`, but it is not automatically customer revenue. Revenue is recognized only after the payer and DELTA proof/telemetry reconcile to a non-project, non-canary, non-self-pay, non-platform-verification buyer.

Known platform/test verifier wallets must remain excluded in `scripts/reconcile-treasury.mjs`. The 2026-09-07 receipt previously labeled `First Stranger Revenue` is superseded by `docs/growth-evidence-2026-09-10T0125+08-payapi-reclassification.md`: the same payer later produced an explicitly identified PayAPI paid verification call, so both same-wallet receipts are classified PayAPI platform verification rather than independent customer revenue. Until a different independently evidenced buyer settles, recognized customer revenue remains `$0.00`.

## Runtime acquisition in v0.6

- `/SKILL.md` — agent-consumable purchase instructions.
- `/distribution.json` — machine-readable distribution manifest.
- `/postman.json` — importable Postman collection.
- `/indexnow-key.txt` + scheduled IndexNow submission — automatic Bing/participating-engine URL notification.
- Daily Worker cron submits commercial/static pages only; customer proof pages remain `noindex` by default.
- Existing x402 Bazaar discovery metadata remains the primary machine-purchase path.

## Bootstrap rule

Agentic Market/Bazaar discovery may use external platform verification only when the platform funds its own verification call. One explicitly labeled project canary may be used only if a bootstrap remains necessary after every free publication surface is live; it must never be counted as customer revenue. Platform-funded verification likewise remains a technical settlement/treasury receipt but is never customer revenue.
