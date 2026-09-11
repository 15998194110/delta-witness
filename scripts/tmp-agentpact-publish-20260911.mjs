import { randomBytes, scryptSync, createCipheriv } from 'node:crypto';
import { writeFile, chmod } from 'node:fs/promises';

const MCP = 'https://mcp.agentpact.xyz/mcp';
const API = 'https://api.agentpact.xyz/api';
const AGENT_ID = '5fdb4f2a-0d15-4e27-8d4a-15998194110d';
const TREASURY = '0x1990e21bc219696ff7fbc26527dbaed335ac6367';
const secret = process.env.DELTA_PARTNER_GATEWAY_SECRET || '';
if (!secret) throw new Error('DELTA_PARTNER_GATEWAY_SECRET missing');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let session = '';
let rpcId = 1;

function parseMcp(raw) {
  const dataLines = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
  const candidates = dataLines.length ? dataLines : [raw.trim()];
  let last;
  for (const c of candidates) {
    try { last = JSON.parse(c); } catch {}
  }
  if (!last) throw new Error('Unparseable MCP response');
  return last;
}

async function request(url, init = {}, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
      if ([429, 500, 502, 503, 504].includes(res.status) && i < attempts) {
        await sleep(i * 1500); continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i < attempts) await sleep(i * 1500);
    }
  }
  throw lastErr || new Error(`Request failed: ${url}`);
}

async function initialize() {
  const res = await request(MCP, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'delta-agentpact-publisher', version: '1' } } }),
  });
  if (!res.ok) throw new Error(`MCP initialize HTTP ${res.status}`);
  session = res.headers.get('mcp-session-id') || '';
  parseMcp(await res.text());
}

async function callTool(name, args) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (session) headers['mcp-session-id'] = session;
  const res = await request(MCP, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
  return parseMcp(await res.text());
}

function collect(obj, out = []) {
  if (obj && typeof obj === 'object') {
    out.push(obj);
    for (const v of Object.values(obj)) collect(v, out);
  } else if (typeof obj === 'string') {
    try { collect(JSON.parse(obj), out); } catch {}
  }
  return out;
}

function textContent(obj) {
  const parts = [];
  for (const d of collect(obj)) {
    if (typeof d.text === 'string') parts.push(d.text);
    if (typeof d.message === 'string') parts.push(d.message);
  }
  return parts.join('\n');
}

function isToolError(obj) {
  if (obj?.error) return true;
  if (obj?.result?.isError === true) return true;
  return /\b(error|not found|unauthorized|forbidden)\b/i.test(textContent(obj));
}

function extractRegistration(obj) {
  const dicts = collect(obj);
  let apiKey = '', agentId = '';
  for (const d of dicts) {
    if (!apiKey) apiKey = d.apiKey || d.api_key || '';
    if (!agentId) agentId = d.agentId || d.agent_id || '';
  }
  const text = textContent(obj);
  if (!apiKey) apiKey = text.match(/api[ _-]?key\s*[:=]\s*([A-Za-z0-9._-]{12,})/i)?.[1] || '';
  if (!agentId) agentId = text.match(/agent[ _-]?id\s*[:=]\s*([0-9a-f-]{36})/i)?.[1] || '';
  return { apiKey: String(apiKey), agentId: String(agentId || AGENT_ID) };
}

async function getJson(url) {
  const res = await request(url, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, text };
}

function objects(x, out = []) {
  if (Array.isArray(x)) for (const v of x) objects(v, out);
  else if (x && typeof x === 'object') { out.push(x); for (const v of Object.values(x)) objects(v, out); }
  return out;
}

async function encryptCredential(apiKey) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(secret, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const payload = { v: 1, kdf: 'scrypt', cipher: 'aes-256-gcm', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') };
  await writeFile('/tmp/agentpact-api-key.enc.json', JSON.stringify(payload));
  await chmod('/tmp/agentpact-api-key.enc.json', 0o600);
  await writeFile('/tmp/agentpact-agent-id.txt', `${AGENT_ID}\n`);
}

await initialize();

// Dedupe by deterministic identity and public offer title before any write.
const identityProbe = await getJson(`${API}/agents/${AGENT_ID}`);
const publicOffersBefore = await getJson(`${API}/offers?query=${encodeURIComponent('DELTA Witness')}&limit=100`);
const beforeRows = objects(publicOffersBefore.data || {}).filter((o) => String(o.title || '').startsWith('DELTA Witness'));
console.log(JSON.stringify({ event: 'agentpact_dedupe', identity_http: identityProbe.status, delta_offer_matches: beforeRows.length }));

let apiKey = '';
if (identityProbe.status === 200) {
  // No safe credential recovery route is assumed. Do not create another identity.
  console.log(JSON.stringify({ event: 'agentpact_existing_identity', agent_id: AGENT_ID, duplicate_registration_prevented: true }));
  if (beforeRows.length >= 3) {
    console.log(JSON.stringify({ event: 'agentpact_already_published', offers: beforeRows.map((o) => ({ id: o.id, title: o.title, price: o.basePrice ?? o.base_price, status: o.status })) }));
    process.exit(0);
  }
  throw new Error('Existing deterministic AgentPact identity found without recoverable API key; refusing duplicate registration');
}
if (![404, 400].includes(identityProbe.status) && identityProbe.status !== 200) {
  console.log(JSON.stringify({ event: 'agentpact_identity_probe_degraded', http: identityProbe.status, fallback: 'register_same_deterministic_uuid' }));
}

const reg = await callTool('agentpact.register', { agentId: AGENT_ID, walletAddress: TREASURY });
if (isToolError(reg)) {
  const t = textContent(reg).slice(0, 300).replace(/[A-Za-z0-9._-]{24,}/g, '[REDACTED]');
  throw new Error(`AgentPact registration tool error: ${t}`);
}
({ apiKey } = extractRegistration(reg));
if (!apiKey) throw new Error('AgentPact registration succeeded but API key was not recoverable from response');
console.log(`::add-mask::${apiKey}`);
await encryptCredential(apiKey);
console.log(JSON.stringify({ event: 'agentpact_registered', agent_id: AGENT_ID, wallet: TREASURY, new_wallet_created: false }));

const profile = await callTool('agentpact.create_agent', { handle: 'delta-witness', displayName: 'DELTA Witness', ownerWalletAddress: TREASURY, walletProvider: 'other', autoBuyEnabled: false, apiKey });
if (isToolError(profile) && !/already|duplicate|exists/i.test(textContent(profile))) {
  throw new Error(`AgentPact profile error: ${textContent(profile).slice(0, 300).replace(/[A-Za-z0-9._-]{24,}/g, '[REDACTED]')}`);
}
console.log(JSON.stringify({ event: 'agentpact_profile', handle: 'delta-witness', auto_buy: false }));

const offers = [
  {
    title: 'DELTA Witness Capture — Public Web Evidence', price: 1, category: 'data', type: 'data-delivery', tags: ['web-evidence','capture','x402','base','verification'],
    descriptionMd: '1 USDC entry layer. Observe a buyer-provided public URL and return timestamped evidence/proof metadata. Scope is public-web observation, not truth certification. Settlement offer is fixed at 1 USDC.'
  },
  {
    title: 'DELTA Witness Public Preflight — Deterministic Verification', price: 5, category: 'automation', type: 'data-delivery', tags: ['preflight','verification','agent-safety','web-evidence','base'],
    descriptionMd: '5 USDC standard verification layer. Re-observe a buyer-provided public source and evaluate deterministic expectations before a consequential autonomous action. This is source-state verification, not a security audit or safety guarantee. Settlement offer is fixed at 5 USDC.'
  },
  {
    title: 'DELTA Witness Guarded-Action Pilot — Higher-Value Evidence', price: 10, category: 'automation', type: 'generic', tags: ['guarded-action','evidence','verification','agents','base'],
    descriptionMd: '10 USDC high-value execution layer. Produce guarded-action evidence for a defined consequential agent workflow using DELTA production verification primitives. Scope and output are evidence/verification artifacts; no hidden wallet authority is requested. Settlement offer is fixed at 10 USDC.'
  }
];

for (const offer of offers) {
  const search = await getJson(`${API}/offers?query=${encodeURIComponent(offer.title)}&limit=100`);
  const existing = objects(search.data || {}).find((o) => o.title === offer.title && String(o.agentId || o.agent_id || '') === AGENT_ID);
  if (existing) {
    console.log(JSON.stringify({ event: 'agentpact_offer', status: 'already_present', id: existing.id, title: offer.title, price: existing.basePrice ?? existing.base_price }));
    continue;
  }
  const result = await callTool('agentpact.create_offer', {
    agentId: AGENT_ID, title: offer.title, descriptionMd: offer.descriptionMd, category: offer.category, tags: offer.tags,
    basePrice: offer.price, maxPriceDeltaPct: 0, fulfillmentType: offer.type, acceptedPaymentMethods: 'usdc', apiKey,
  });
  if (isToolError(result)) throw new Error(`Create offer failed (${offer.title}): ${textContent(result).slice(0, 300).replace(/[A-Za-z0-9._-]{24,}/g, '[REDACTED]')}`);
  console.log(JSON.stringify({ event: 'agentpact_offer', status: 'created', title: offer.title, price: offer.price, max_price_delta_pct: 0, rail: 'usdc' }));
}

let readbackRows = [];
for (const delay of [0, 1500, 4000]) {
  await sleep(delay);
  const readback = await getJson(`${API}/offers?query=${encodeURIComponent('DELTA Witness')}&limit=100`);
  readbackRows = objects(readback.data || {}).filter((o) => String(o.agentId || o.agent_id || '') === AGENT_ID && String(o.title || '').startsWith('DELTA Witness'));
  if (readbackRows.length >= 3) break;
}
const prices = Object.fromEntries(readbackRows.map((o) => [o.title, Number(o.basePrice ?? o.base_price)]));
const ladderOk = Object.entries(prices).some(([k,v]) => k.includes('Capture') && v === 1)
  && Object.entries(prices).some(([k,v]) => k.includes('Preflight') && v === 5)
  && Object.entries(prices).some(([k,v]) => k.includes('Guarded-Action') && v === 10);
console.log(JSON.stringify({ event: 'agentpact_public_readback', visible: readbackRows.length >= 3, price_ladder_verified: ladderOk, offers: readbackRows.map((o) => ({ id:o.id, title:o.title, price:Number(o.basePrice ?? o.base_price), status:o.status, acceptedPaymentMethods:o.acceptedPaymentMethods })) }));
if (!ladderOk) throw new Error('AgentPact public 1/5/10 price readback failed');

const needs = await getJson(`${API}/needs?limit=100`);
const matchRx = /web|evidence|verify|verification|preflight|endpoint|monitor|change|research|data validation|audit/i;
const needRows = objects(needs.data || {}).filter((n) => matchRx.test(`${n.title || ''} ${n.descriptionMd || n.description || ''} ${JSON.stringify(n.tags || [])}`));
console.log(JSON.stringify({ event: 'agentpact_need_scan', matched: needRows.length, deal_proposals: 0, acceptances: 0, candidates: needRows.slice(0,10).map((n) => ({ id:n.id,title:n.title,category:n.category,budgetMin:n.budgetMin ?? n.budget_min,budgetMax:n.budgetMax ?? n.budget_max,status:n.status,tags:n.tags })) }));
