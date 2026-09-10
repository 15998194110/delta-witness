import fs from 'node:fs';
import crypto from 'node:crypto';

const BASE = 'https://payanagent.com';
const TREASURY = '0x1990e21bc219696ff7fbc26527dbaed335ac6367';
const enc = JSON.parse(fs.readFileSync('credentials/payanagent-operator.enc.json', 'utf8'));
const passphrase = process.env.DELTA_PARTNER_SECRET;
if (!passphrase) throw new Error('PAYAN_DEGRADED missing DELTA_PARTNER_SECRET');

const salt = Buffer.from(enc.encryption.salt_b64, 'base64');
const iv = Buffer.from(enc.encryption.iv_b64, 'base64');
const tag = Buffer.from(enc.encryption.tag_b64, 'base64');
const ciphertext = Buffer.from(enc.encryption.ciphertext_b64, 'base64');
const key = crypto.scryptSync(passphrase, salt, 32);
const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
decipher.setAuthTag(tag);
const apiKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
console.log(`::add-mask::${apiKey}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(url, init = {}) {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
      if (response.status === 429 || response.status >= 500) {
        last = new Error(`HTTP ${response.status}`);
        if (attempt < 4) { await sleep(attempt * 2000); continue; }
      }
      return { response, body };
    } catch (error) {
      last = error;
      if (attempt < 4) { await sleep(attempt * 2000); continue; }
    }
  }
  throw last || new Error('request_failed');
}

const offers = [
  {
    id: 'kh79t54410qb82yjcqsjmgv0d58dn7p3',
    title: 'DELTA Witness Capture',
    description: 'Timestamped public-web page-state evidence for autonomous agents.',
    category: 'developer-tools',
    tags: ['verification', 'evidence', 'web', 'x402'],
    url: 'https://delta-witness-api.ruphussten.workers.dev/v1/capture',
    raw: '1000000',
    verificationBody: { url: 'https://example.com' },
    inputSchema: '{"url":"https://example.com"}'
  },
  {
    id: 'kh72vd1kdv37109xxzzgmn2xfn8dnc6z',
    title: 'DELTA Witness Preflight',
    description: 'Fresh-source preflight verification before consequential autonomous actions.',
    category: 'agent-safety',
    tags: ['verification', 'preflight', 'safety', 'x402'],
    url: 'https://delta-witness-api.ruphussten.workers.dev/v1/preflight',
    raw: '5000000',
    verificationBody: { url: 'https://example.com/terms', expected: { contains: ['Refund window: 30 days'] } },
    inputSchema: '{"url":"https://example.com/terms","expected":{"contains":["Refund window: 30 days"]}}'
  },
  {
    id: 'kh7dskbdz0mj2ctc0dvm6q1yb98dz8dm',
    title: 'DELTA Witness Guarded Action Pilot',
    description: 'Production-verified guarded-action evidence pilot for consequential agent workflows.',
    category: 'agent-safety',
    tags: ['guarded-action', 'verification', 'safety', 'x402'],
    url: 'https://delta-witness-api.ruphussten.workers.dev/v1/guarded-action-pilot',
    raw: '10000000',
    verificationBody: { urls: ['https://example.com'], preflight: { url_index: 0, expected: { contains: ['Example Domain'] } } },
    inputSchema: '{"urls":["https://example.com"],"preflight":{"url_index":0,"expected":{"contains":["Example Domain"]}}}'
  }
];

function publicOffer(body) { return body?.offer || body?.data?.offer || body?.data || body; }
function isCurrent(offer, expected) {
  if (!offer) return false;
  const amountRaw = String(offer.amountRaw ?? '');
  const network = String(offer.network ?? offer.chain ?? '').toLowerCase();
  const payTo = String(offer.payTo ?? offer.paymentAddress ?? '').toLowerCase();
  return amountRaw === expected.raw &&
    (!network || network === 'eip155:8453' || network === 'base') &&
    (!payTo || payTo === TREASURY.toLowerCase());
}

let writes = 0;
let degraded = 0;
for (const item of offers) {
  try {
    const before = await request(`${BASE}/api/v1/offers/${item.id}?fresh=${Date.now()}`);
    if (!before.response.ok) throw new Error(`readback_before_http_${before.response.status}`);
    const current = publicOffer(before.body);
    if (isCurrent(current, item)) {
      console.log(`PAYAN_CURRENT offer=${item.id} amountRaw=${item.raw}`);
      continue;
    }

    const payload = {
      title: item.title,
      description: item.description,
      category: item.category,
      tags: item.tags,
      offerType: 'api',
      externalUrl: item.url,
      httpMethod: 'POST',
      verificationBody: item.verificationBody,
      inputSchema: item.inputSchema
    };
    const refreshed = await request(`${BASE}/api/v1/offers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!refreshed.response.ok) throw new Error(`refresh_http_${refreshed.response.status}:${JSON.stringify(refreshed.body).slice(0,300)}`);
    const returnedId = refreshed.body?.offerId;
    if (returnedId !== item.id) {
      throw new Error(`dedupe_invariant_violation expected=${item.id} returned=${returnedId || 'missing'}`);
    }
    const verifiedRaw = String(refreshed.body?.verified?.amountRaw ?? '');
    const verifiedNetwork = String(refreshed.body?.verified?.network ?? '').toLowerCase();
    const verifiedPayTo = String(refreshed.body?.verified?.payTo ?? '').toLowerCase();
    if (verifiedRaw !== item.raw || verifiedNetwork !== 'eip155:8453' || verifiedPayTo !== TREASURY.toLowerCase()) {
      throw new Error(`verified_terms_mismatch offer=${item.id} raw=${verifiedRaw} network=${verifiedNetwork} payTo=${verifiedPayTo}`);
    }
    writes++;
    console.log(`PAYAN_REFRESHED offer=${item.id} amountRaw=${item.raw} network=eip155:8453 same_id=true`);
  } catch (error) {
    degraded++;
    console.error(`PAYAN_DEGRADED offer=${item.id} recoverable=true error=${String(error.message || error)}`);
  }
}
console.log(`PAYAN_RECONCILE writes=${writes} degraded=${degraded} duplicate_seller_created=false`);
if (degraded) process.exitCode = 1;
