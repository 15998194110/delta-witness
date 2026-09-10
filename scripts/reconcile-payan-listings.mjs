import fs from 'node:fs';
import crypto from 'node:crypto';

const BASE = 'https://payanagent.com';
const TREASURY = '0x1990e21bc219696ff7fbc26527dbaed335ac6367';
const NETWORK = 'eip155:8453';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
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
function retryableHttp(status, text) {
  // PayanAgent can wrap backend/Convex exceptions as a generic HTTP 400
  // "[Request ID: ...] Server Error". Treat that masked server failure like a
  // transient 5xx, while leaving ordinary validation/ownership 400s terminal.
  return status === 429 || status >= 500 ||
    (status === 400 && (/\[Request ID:/i.test(text) || /Server Error/i.test(text)));
}
async function request(url, init = {}) {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
      if (retryableHttp(response.status, text)) {
        last = new Error(`HTTP ${response.status}:${text.slice(0, 220)}`);
        if (attempt < 4) { await sleep(1500 * 2 ** (attempt - 1)); continue; }
      }
      return { response, body, text };
    } catch (error) {
      last = error;
      if (attempt < 4) { await sleep(1500 * 2 ** (attempt - 1)); continue; }
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
    (!network || network === NETWORK || network === 'base') &&
    (!payTo || payTo === TREASURY.toLowerCase());
}
function parseChallenge(header) {
  if (!header) return null;
  try { return JSON.parse(Buffer.from(header, 'base64').toString('utf8')); }
  catch { return null; }
}
function acceptedBaseUsdc(challenge) {
  return challenge?.accepts?.find((a) =>
    String(a.network || '').toLowerCase() === NETWORK &&
    String(a.asset || '').toLowerCase() === USDC);
}
async function verifyRelay(item) {
  let last = 'unknown';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const probe = await request(`${BASE}/x402/${item.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(item.verificationBody)
    });
    const challenge = parseChallenge(probe.response.headers.get('payment-required'));
    const accepted = acceptedBaseUsdc(challenge);
    const raw = String(accepted?.amount ?? '');
    const payTo = String(accepted?.payTo ?? '').toLowerCase();
    if (probe.response.status === 402 && raw === item.raw && payTo === TREASURY.toLowerCase()) {
      console.log(`PAYAN_BUY_ROUTE_CURRENT offer=${item.id} amountRaw=${raw} network=${NETWORK} payTo=${TREASURY}`);
      return true;
    }
    last = `http=${probe.response.status} raw=${raw || 'missing'} payTo=${payTo || 'missing'}`;
    // PayanAgent caches unsigned relay challenges for up to 120s. A mismatch can
    // therefore be stale cache, not a seller-integrity failure. Recheck after a
    // bounded delay without ever sending a payment header.
    if (attempt < 3) await sleep(45000);
  }
  throw new Error(`buyer_route_challenge_mismatch ${last}`);
}

// Authenticated identity read is diagnostic only; never print the API key.
try {
  const me = await request(`${BASE}/api/v1/agents/me`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!me.response.ok) throw new Error(`agent_me_http_${me.response.status}`);
  console.log(`PAYAN_AGENT_AUTH_OK agent=${me.body?.id || 'unknown'} wallet=${String(me.body?.walletAddress || '').toLowerCase()}`);
} catch (error) {
  console.error(`PAYAN_AGENT_AUTH_DEGRADED recoverable=true error=${String(error.message || error)}`);
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
    } else {
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
      if (verifiedRaw !== item.raw || verifiedNetwork !== NETWORK || verifiedPayTo !== TREASURY.toLowerCase()) {
        throw new Error(`verified_terms_mismatch offer=${item.id} raw=${verifiedRaw} network=${verifiedNetwork} payTo=${verifiedPayTo}`);
      }
      writes++;
      console.log(`PAYAN_REFRESHED offer=${item.id} amountRaw=${item.raw} network=${NETWORK} same_id=true`);
    }

    // Buyer-path evidence is independent of catalog metadata. It proves the
    // marketplace's public relay emits DELTA's current live terms without a
    // payment, even while a stale metadata write is recovering.
    await verifyRelay(item);
  } catch (error) {
    degraded++;
    console.error(`PAYAN_DEGRADED offer=${item.id} recoverable=true error=${String(error.message || error)}`);
  }
}
console.log(`PAYAN_RECONCILE writes=${writes} degraded=${degraded} duplicate_seller_created=false`);
if (degraded) process.exitCode = 1;
