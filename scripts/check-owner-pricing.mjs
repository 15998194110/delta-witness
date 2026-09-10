import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Owner explicitly reaffirmed these amounts on 2026-09-10.
// Old automation prompts are NOT permission to change them.
export const OWNER_PRICING = Object.freeze({ capture: 1, preflight: 5, 'guarded-action-pilot': 10, partner_capture: 1, partner_preflight: 1, watch_check: 1 });
export const TREASURY = '0x1990e21bc219696ff7fbc26527dbaed335ac6367';
export const NETWORK = 'eip155:8453';
export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const root = fileURLToPath(new URL('../', import.meta.url));
const text = (path) => readFileSync(resolve(root, path), 'utf8');

export function checkOwnerPricing() {
  const errors = [];
  const assert = (condition, reason) => { if (!condition) errors.push(reason); };
  const core = JSON.parse(text('wrangler.jsonc')).vars;
  const partner = JSON.parse(text('channels/partner-gateway/wrangler.jsonc')).vars;
  for (const [key, expected] of Object.entries({ CAPTURE_BASE_PRICE_USD: '1', PREFLIGHT_BASE_PRICE_USD: '5', WATCH_BASE_PRICE_USD: '1', PARTNER_PREFLIGHT_BASE_PRICE_USD: '1' })) {
    assert(core[key] === expected, `wrangler.jsonc ${key}: expected ${expected}, found ${core[key]}`);
  }
  for (const key of ['PARTNER_NET_CAPTURE_USD', 'PARTNER_NET_PREFLIGHT_USD', 'PARTNER_NET_WATCH_CHECK_USD']) {
    assert(partner[key] === '1', `partner gateway ${key}: expected 1, found ${partner[key]}`);
  }
  assert(core.PAY_TO.toLowerCase() === TREASURY, 'Treasury changed');
  assert(core.NETWORK === NETWORK, 'Base network changed');
  const agents = text('AGENTS.md');
  assert(agents.includes('**$1.00 USDC — entry layer:** Public Capture.'), 'AGENTS.md missing Capture owner authority');
  assert(agents.includes('**$5.00 USDC — standard verification layer:** Public Preflight.'), 'AGENTS.md missing Public Preflight owner authority');
  assert(agents.includes('**$10.00 USDC — high-value execution layer:** Guarded-Action Pilot.'), 'AGENTS.md missing Pilot owner authority');
  assert(/const fallback = product === ["']preflight["'] \? 5 : 1;/.test(text('src/pricing.ts')), 'Runtime fallback no longer matches owner 1/5/10 authority');
  assert(text('tests/current-pricing-policy.test.ts').includes('PREFLIGHT_BASE_PRICE_USD).toBe("5")'), 'Owner regression changed away from Public Preflight 5');
  assert(text('tests/current-pricing-policy.test.ts').includes('CAPTURE_BASE_PRICE_USD).toBe("1")'), 'Owner regression changed away from Capture 1');
  const matrix = text('tests/payment-gate.test.ts');
  assert(matrix.includes('[["capture", "1000000"], ["preflight", "5000000"], ["guarded-action-pilot", "10000000"]]'), 'Public x402 price regression matrix drifted');
  const workflows = readdirSync(resolve(root, '.github/workflows')).filter((name) => /\.ya?ml$/.test(name));
  for (const name of workflows) {
    const contents = text(`.github/workflows/${name}`);
    for (const [i, line] of contents.split('\n').entries()) {
      if (/^\s*#/.test(line)) continue;
      if (/^\s*probe\s+(?:capture\s+)?['"]\/v1\/capture['"]\s+30000\s*$/.test(line)
        || /^\s*probe\s+(?:preflight\s+)?['"]\/v1\/preflight['"]\s+(?:30000|1000000)\s*$/.test(line)
        || (/test.*(?:CAPTURE_BASE_PRICE_USD|PREFLIGHT_BASE_PRICE_USD)/.test(line) && /=\s*['"]0\.03['"]/.test(line))) {
        errors.push(`${name}:${i + 1} executes an obsolete public price assertion`);
      }
    }
  }
  const report = { ok: errors.length === 0, policy: 'owner-2026-09-10-1-5-10', expected: OWNER_PRICING, workflows_checked: workflows, errors, historical_receipts_and_replay_fixtures: 'preserved; not current-price instructions' };
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkOwnerPricing();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
