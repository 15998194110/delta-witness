import { appendFileSync, writeFileSync } from 'node:fs';
import { OWNER_PRICING, TREASURY, NETWORK, USDC } from './check-owner-pricing.mjs';

const base = 'https://delta-witness-api.ruphussten.workers.dev';
const diagnostic = process.argv.includes('--diagnostic');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const headers = { 'content-type': 'application/json', 'x-delta-channel': 'internal-ci', 'user-agent': 'DELTA-Owner-Pricing-Audit/1.0' };
const fetchBounded = (url, init = {}) => fetch(url, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(15000) });

async function publicProduct(product) {
  let result;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const [qr, pr] = await Promise.all([
        fetchBounded(`${base}/v1/quote?product=${product}`),
        fetchBounded(`${base}/v1/${product}`, { method: 'POST', body: '{}' }),
      ]);
      if (qr.status >= 500 || pr.status >= 500 || qr.status === 429 || pr.status === 429) throw new Error(`temporary_http_${qr.status}_${pr.status}`);
      const quote = await qr.json();
      const body = await pr.json();
      const encoded = pr.headers.get('payment-required');
      if (!encoded) throw new Error('missing_payment_required_header');
      const challenge = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      const accepted = challenge.accepts?.find((a) => a.network === NETWORK && String(a.asset).toLowerCase() === USDC);
      const expected = OWNER_PRICING[product];
      const quoted = Number(String(quote.price).replace(/^\$/, ''));
      const charged = accepted ? Number(accepted.amount) / 1000000 : null;
      const identity = qr.status === 200 && pr.status === 402 && challenge.x402Version === 2
        && accepted?.payTo?.toLowerCase() === TREASURY && quote.pay_to?.toLowerCase() === TREASURY
        && quote.network === NETWORK && accepted.scheme === 'exact';
      const mirrored = JSON.stringify(body.accepts) === JSON.stringify(challenge.accepts);
      const consistent = identity && mirrored && Number.isFinite(quoted) && quoted === charged;
      result = { product, attempt, http: pr.status, quote_usdc: quoted, challenge_usdc: charged, raw_usdc: accepted?.amount ?? null,
        pay_to: accepted?.payTo ?? null, network: accepted?.network ?? null, asset: accepted?.asset ?? null,
        expected_usdc: expected, header_body_match: mirrored,
        status: consistent ? (charged === expected ? 'verified' : 'price_mismatch') : 'integrity_mismatch' };
      if (result.status === 'verified') return result;
    } catch (error) {
      result = { product, attempt, status: 'unavailable', error: error instanceof Error ? error.message : String(error) };
    }
    if (attempt < 4) await sleep(1000 * 2 ** (attempt - 1));
  }
  return result;
}

async function partnerFloor(product) {
  if (!process.env.DELTA_PARTNER_GATEWAY_SECRET) return { product: `partner_${product}`, status: 'not_checked', reason: 'scoped_secret_not_provided' };
  let result;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const request = product === 'watch' ? { url: 'https://example.com', checks: 1, interval_seconds: 900 } : { url: 'https://example.com' };
      const r = await fetchBounded(`${base}/internal/partner/${product}`, { method: 'POST',
        headers: { 'x-delta-core-secret': process.env.DELTA_PARTNER_GATEWAY_SECRET, 'x-delta-partner': 'internal-ci',
          'x-delta-channel': 'internal-ci', 'x-delta-gross-usd': '0', 'idempotency-key': `owner-price-${process.env.GITHUB_RUN_ID || Date.now()}-${product}` },
        body: JSON.stringify(request) });
      const body = await r.json();
      const minimum = product === 'watch' ? body.required_total_usd : body.minimum_price_usd;
      result = { product: `partner_${product}`, http: r.status, minimum_usdc: minimum ?? null, attempt,
        status: r.status === 402 && minimum === 1 ? 'verified' : 'floor_mismatch' };
      if (result.status === 'verified') return result;
    } catch (error) {
      result = { product: `partner_${product}`, attempt, status: 'unavailable', error: error instanceof Error ? error.message : String(error) };
    }
    if (attempt < 3) await sleep(1000 * attempt);
  }
  return result;
}

// Independent checks always finish even if another route is degraded.
const products = await Promise.all(['capture', 'preflight', 'guarded-action-pilot'].map(publicProduct));
const partners = await Promise.all(['capture', 'preflight', 'watch'].map(partnerFloor));
const ok = products.every((r) => r.status === 'verified') && partners.every((r) => r.status === 'verified' || r.status === 'not_checked');
const report = { checked_at: new Date().toISOString(), policy: 'owner-2026-09-10-1-5-10', ok, products, partners,
  paid_transactions_generated: 0, customer_revenue_generated: 0, diagnostic_only: true,
  unverified_scope: ['ChatGPT scheduled-task prompts', 'global saved memory', 'local Codex automation files'] };
console.log(JSON.stringify(report, null, 2));
if (process.env.PRICING_AUDIT_OUTPUT) writeFileSync(process.env.PRICING_AUDIT_OUTPUT, JSON.stringify(report, null, 2) + '\n');
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
  `public_price_mismatch=${products.some((r) => r.status === 'price_mismatch')}\npublic_verified=${products.every((r) => r.status === 'verified')}\n`);
if (!ok && !diagnostic) process.exitCode = 1;
