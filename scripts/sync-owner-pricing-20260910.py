"""One-time owner-authorized reconciliation. No outreach, payments or deployment."""
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
changed = []
def read(path):
    return (root / path).read_text()
def write(path, content):
    p = root / path
    if not p.exists() or p.read_text() != content:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content.rstrip()+chr(10))
        changed.append(path)

authority = read('AGENTS.md')
assert '**$1.00 USDC — entry layer:** Public Capture.' in authority
assert '**$5.00 USDC — standard verification layer:** Public Preflight.' in authority
assert '**$10.00 USDC — high-value execution layer:** Guarded-Action Pilot.' in authority

p = 'wrangler.jsonc'
s = read(p)
for key, value in {'CAPTURE_BASE_PRICE_USD':'1', 'PREFLIGHT_BASE_PRICE_USD':'5', 'WATCH_BASE_PRICE_USD':'1', 'PARTNER_PREFLIGHT_BASE_PRICE_USD':'1'}.items():
    s, n = re.subn(r'("'+key+r'"\s*:\s*")[^"]+("\s*[,}])', lambda m: m[1]+value+m[2], s)
    assert n == 1, key
write(p, s)
assert json.loads(s)['vars']['PAY_TO'].lower() == '0x1990e21bc219696ff7fbc26527dbaed335ac6367'
assert json.loads(s)['vars']['NETWORK'] == 'eip155:8453'

p = 'src/pricing.ts'
s = read(p)
s, n = re.subn(r'  const fallback = product === [^\n]+;', '  const fallback = product === "preflight" ? 5 : 1;', s)
assert n == 1
write(p, s)

p = 'tests/current-pricing-policy.test.ts'
s = read(p)
s = s.replace('locks the core runtime to $0.03 Capture, $0.03 Preflight, and existing Watch/partner terms', 'locks the core runtime to the owner-authorized 1 / 5 / 10 ladder')
s = s.replace('CAPTURE_BASE_PRICE_USD).toBe("0.03")', 'CAPTURE_BASE_PRICE_USD).toBe("1")')
s = s.replace('PREFLIGHT_BASE_PRICE_USD).toBe("0.03")', 'PREFLIGHT_BASE_PRICE_USD).toBe("5")')
write(p, s)

p = 'tests/pricing.test.ts'
s = read(p)
s = re.sub(r'\bCAPTURE_BASE_PRICE_USD: "0\.03"', 'CAPTURE_BASE_PRICE_USD: "1"', s)
s = re.sub(r'\bPREFLIGHT_BASE_PRICE_USD: "0\.03"', 'PREFLIGHT_BASE_PRICE_USD: "5"', s)
s = s.replace('enforces the $0.03 Capture and Preflight prices', 'enforces the owner-approved $1 Capture and $5 Public Preflight prices')
s = s.replace('quoteProduct(config, "preflight").grossPriceUsd).toBe(0.03)', 'quoteProduct(config, "preflight").grossPriceUsd).toBe(5)')
s = s.replace('.grossPriceUsd).toBe(0.03)', '.grossPriceUsd).toBe(1)')
s = s.replace('quote.minimumPriceUsd).toBeGreaterThan(0.03)', 'quote.minimumPriceUsd).toBeGreaterThan(1)')
write(p, s)

p = 'tests/payment-gate.test.ts'
s = read(p)
s = re.sub(r'\bCAPTURE_BASE_PRICE_USD: "0\.03"', 'CAPTURE_BASE_PRICE_USD: "1"', s)
s = re.sub(r'\bPREFLIGHT_BASE_PRICE_USD: "0\.03"', 'PREFLIGHT_BASE_PRICE_USD: "5"', s)
s = s.replace('PREFLIGHT_BASE_PRICE_USD: "1", PARTNER_PREFLIGHT_BASE_PRICE_USD: "0.03"', 'PREFLIGHT_BASE_PRICE_USD: "5", PARTNER_PREFLIGHT_BASE_PRICE_USD: "0.03"')
s = s.replace('[["capture", "30000"], ["preflight", "30000"], ["guarded-action-pilot", "10000000"]]', '[["capture", "1000000"], ["preflight", "5000000"], ["guarded-action-pilot", "10000000"]]')
# Preserve oldPayment.amount=30000 and historical authenticated replay fixtures.
write(p, s)

for path in root.glob('.github/workflows/*.yml'):
    name = path.relative_to(root).as_posix()
    s = path.read_text()
    s = re.sub(r"(probe\s+(?:capture\s+)?'/v1/capture')\s+30000\b", r'\g<1> 1000000', s)
    s = re.sub(r"(probe\s+(?:preflight\s+)?'/v1/preflight')\s+(?:30000|1000000)\b", r'\g<1> 5000000', s)
    if path.name in ['delta-growth-listings-20260910-1900.yml', 'delta-growth-refresh-20260910-2030.yml']:
        # They were one-shot push jobs, not recurring schedules. Updating a price
        # must not fire another unsolicited listing/registration batch.
        old = "on:\n  push:\n    paths:\n      - '"+name+"'"
        s = s.replace(old, 'on:\n  workflow_dispatch:')
        s = s.replace('    steps:\n', '    steps:\n', 1)
        if 'Check current owner pricing policy' not in s:
            marker = '      - name: Verify '
            i = s.find(marker)
            assert i >= 0, name
            s = s[:i]+'      - name: Check current owner pricing policy\n        run: node scripts/check-owner-pricing.mjs\n\n'+s[i:]
    if path.name == 'discovery-pulse.yml':
        if 'Check current owner pricing policy' not in s:
            s = s.replace('      - name: Verify machine discovery surfaces', '      - name: Check current owner pricing policy\n        run: node scripts/check-owner-pricing.mjs\n      - name: Verify current owner live prices without payment\n        run: node scripts/verify-owner-pricing-live.mjs\n      - name: Verify machine discovery surfaces', 1)
        s = s.replace('      - name: Reconcile Base Treasury\n        id:', '      - name: Reconcile Base Treasury\n        if: always()\n        id:', 1)
    if path.name == 'release-train.yml':
        if 'Check current owner pricing policy' not in s:
            s = s.replace('      - run: node scripts/check-release-version.mjs', '      - name: Check current owner pricing policy\n        run: node scripts/check-owner-pricing.mjs\n      - run: node scripts/check-release-version.mjs', 1)
        start = s.index('  core-cloudflare:')
        end = s.index('\n  partner-gateway:', start)
        job = s[start:end]
        if 'node scripts/check-owner-pricing.mjs' not in job:
            job = job.replace('      - run: npm ci', '      - run: node scripts/check-owner-pricing.mjs\n      - run: npm ci', 1)
            s = s[:start]+job+s[end:]
    write(name, s)

for p, prefix in [('package.json', 'node scripts/check-owner-pricing.mjs && '), ('channels/partner-gateway/package.json', 'node ../../scripts/check-owner-pricing.mjs && ')]:
    data = json.loads(read(p))
    if not data['scripts']['verify'].startswith(prefix):
        data['scripts']['verify'] = prefix + data['scripts']['verify']
    write(p, json.dumps(data, indent=2)+'\n')

notice = '> CURRENT OWNER PRICING (2026-09-10): Capture / authenticated Partner Capture / authenticated Partner Preflight / each NEW Watch check = **1 USDC**; Public Preflight = **5 USDC**; Guarded-Action Pilot = **10 USDC**. Read `AGENTS.md` and `docs/pricing-policy-2026-09-10.md` before every run. Conflicting old prices, automatic repricing and paid-canary instructions below are superseded. Historical receipts and prepaid obligations are not rewritten.\n\n'
for p in ['CODEX_MASTER_HANDOFF.md','WORK_OR_CODEX_HANDOFF.md','ACQUISITION_ENGINE.md','AUTODISTRIBUTION_PLAN.md','DISTRIBUTION_MATRIX.md','CHANNEL_BOOTSTRAP.md','README.md']:
    if not (root/p).exists():
        continue
    s = read(p)
    if p == 'CODEX_MASTER_HANDOFF.md':
        start = s.index('## P7 — Pricing / profitability')
        end = s.index('## Success metrics', start)
        s = s[:start]+'''## P7 — Pricing / profitability
The owner alone controls prices. New Capture, authenticated Partner Capture/Preflight and each new Watch check cost 1 USDC; Public Preflight costs 5 USDC; Guarded-Action Pilot costs 10 USDC. This supersedes all earlier experiments and copied automation prompts. Do not automatically raise/lower prices. Record cost/margin risk separately and pause unsafe new fulfillment when required; seek a new explicit owner decision before repricing. Preserve already-paid delivery identities and prepaid obligations without a second charge. Never rewrite old receipts as current-price sales.

'''+s[end:]
        s = s.replace('Do ONE explicitly labeled canary mainnet purchase only if required to activate Bazaar/indexing. Never classify owner/canary transactions as organic revenue.', 'Do not fund a canary, test purchase or self-settlement for indexing. A separate exact owner authorization is required; any such receipt remains non-customer activity.')
        s = s.replace('   - If first settle is needed, use the labeled canary.', '   - If a first settlement is required, record the blocker; do not self-pay or manufacture demand.')
    if notice not in s:
        title, sep, body = s.partition('\n')
        s = title+'\n\n'+notice+body.lstrip('\n')
    write(p, s)

section = '''

## Cross-automation synchronization — owner reaffirmation 2026-09-10

The owner explicitly repeated the 1 / 5 / 10 ladder and ordered every related memory and automation to use it. Before quoting, submitting listings or deploying, read this file and run `node scripts/check-owner-pricing.mjs`; verify live public prices with `node scripts/verify-owner-pricing-live.mjs`. A copied scheduler prompt that says “maintain $0.03 capture/preflight” is obsolete, not a new owner decision. Do not change code or regression tests to satisfy that stale prompt.

When authorized task-management access exists, replace conflicting CURRENT-PRICE clauses in every related task, preserve its schedule/risk boundaries, save, then re-read the saved prompt. Do not claim task synchronization from a repository commit, a memory search, or an intended future action. ChatGPT scheduled-task prompts, global saved memory and local Codex automation files are separate stores and each requires its own verified write/readback. Inaccessible stores remain explicitly not verified. Do not create replacement tasks or parallel growth loops.
'''
if '## Cross-automation synchronization — owner reaffirmation 2026-09-10' not in authority:
    write('AGENTS.md', authority.rstrip()+section+'\n')

write('docs/automation-pricing-override-2026-09-10.md', '''# Owner pricing override for existing DELTA automations

Replace only conflicting CURRENT pricing instructions; preserve schedules, evidence gates, spending restrictions and notification thresholds. Do not start a growth run while doing this synchronization.

Current new-request prices: Capture = 1 USDC; authenticated Partner Capture = 1 USDC; authenticated Partner Preflight = 1 USDC; each new Watch check = 1 USDC; Public Preflight = 5 USDC; Guarded-Action Pilot = 10 USDC. Public canonical Base USDC 402 amounts are 1000000 / 5000000 / 10000000. Treasury remains 0x1990e21bc219696ff7fbc26527dbaed335ac6367, network eip155:8453.

This explicit owner reaffirmation supersedes every copied 0.03 public Capture/Preflight mandate and 1-USDC Public Preflight experiment. No automatic repricing, regression-test rewrite to restore an old price, duplicate registration, or competing deployment. Read AGENTS.md and docs/pricing-policy-2026-09-10.md before execution. After saving a task prompt, re-read it and record task ID, preserved schedule, current price clauses and verification timestamp. Do not call a task updated without this readback.

Historical 0.03 receipts, fulfilled/idempotent deliveries and already-prepaid obligations keep their original facts. Self-pay, paid canaries and platform tests remain non-customer revenue. A higher list price is not realized revenue or profit.

This file is an authoritative synchronization payload, not proof that any ChatGPT task, global memory or local Codex file has been edited.
''')
Path('/tmp/delta-pricing-changed.json').write_text(json.dumps(changed, indent=2)+'\n')
print(json.dumps({'source_files_changed':changed, 'chatgpt_tasks_updated':False, 'global_saved_memory_updated':False, 'local_codex_automations_updated':False, 'external_listings_submitted':0}, indent=2))
