# DELTA Acquisition Engine v0.4

North star: first stranger payment, then repeatable CAC ≈ 0 channels.

Formula:

`Revenue = Discovery Surface × Qualified Intent × Payment Conversion × Delivery Success × Repeat Usage × ARPU`

The system expands Discovery Surface without adding sales labor.

## Runtime acquisition added in v0.4

- `/SKILL.md` — agent-consumable purchase instructions.
- `/distribution.json` — machine-readable distribution manifest.
- `/postman.json` — importable Postman collection.
- `/indexnow-key.txt` + scheduled IndexNow submission — automatic Bing/participating-engine URL notification.
- Daily Worker cron submits commercial/static pages only; customer proof pages remain `noindex` by default.
- Existing x402 Bazaar discovery metadata remains the primary machine-purchase path.

## Bootstrap rule

Agentic Market/Bazaar discovery may require a successful verify+settle before cataloging. A project-owned $0.01 canary transaction is allowed as infrastructure bootstrap but must never be counted as stranger revenue.
