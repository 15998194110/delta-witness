const API = 'https://api.agentpact.xyz/api';
const AGENT_ID = '5fdb4f2a-0d15-4e27-8d4a-15998194110d';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(path) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${API}${path}`, {
        headers: { 'accept': 'application/json', 'user-agent': 'DELTA-AgentPact-Monitor/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 1000) }; }
      if ([429, 500, 502, 503, 504].includes(res.status)) throw new Error(`http_${res.status}`);
      return { ok: res.ok, status: res.status, body, attempt };
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (attempt < 3) await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  return { ok: false, status: null, body: null, error: last };
}

function objectsDeep(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (!Array.isArray(value)) out.push(value);
  for (const v of Object.values(value)) {
    if (v && typeof v === 'object') objectsDeep(v, out);
  }
  return out;
}

const [agentR, offersR, needsR, dealsR] = await Promise.all([
  fetchJson(`/agents/${AGENT_ID}`),
  fetchJson('/offers?query=DELTA%20Witness&limit=100'),
  fetchJson('/needs?limit=100'),
  fetchJson(`/deals?agentId=${AGENT_ID}&limit=100`),
]);

const allOffers = objectsDeep(offersR.body).filter((x) => String(x.title || '').startsWith('DELTA Witness'));
const offers = [...new Map(allOffers.filter((x) => x.id).map((x) => [x.id, {
  id: x.id, title: x.title, status: x.status ?? null, active: x.active ?? null,
  price: x.basePrice ?? x.base_price ?? x.price ?? null, currency: x.currency ?? null,
}])).values()];

const allDeals = objectsDeep(dealsR.body).filter((x) => x.id && (x.offerId || x.buyerAgentId || x.sellerAgentId || x.escrowStatus || x.paymentStatus));
const deals = [...new Map(allDeals.map((x) => [x.id, {
  id: x.id, title: x.title ?? null, status: x.status ?? x.state ?? null,
  funded: x.funded ?? null, fundedAt: x.fundedAt ?? null, buyerAgentId: x.buyerAgentId ?? x.buyerId ?? null,
  sellerAgentId: x.sellerAgentId ?? null, offerId: x.offerId ?? null,
  amount: x.amount ?? x.budget ?? null, currency: x.currency ?? null,
  escrowStatus: x.escrowStatus ?? null, paymentStatus: x.paymentStatus ?? null,
  createdAt: x.createdAt ?? null, updatedAt: x.updatedAt ?? null,
}])).values()];

const fitRe = /evidence|verify|verification|preflight|proof|audit|public api|web|browser|x402|usdc|base/i;
const lowConfidenceRe = /fleet|bootstrap|self[- ]?test|demo|free[- ]?tier|synthetic|canary/i;
const allNeeds = objectsDeep(needsR.body).filter((x) => x.id && fitRe.test(`${x.title || ''} ${x.description || ''} ${JSON.stringify(x.tags || [])}`));
const needs = [...new Map(allNeeds.map((x) => [x.id, {
  id: x.id, title: x.title ?? null, status: x.status ?? null,
  budget: x.budget ?? x.price ?? null, currency: x.currency ?? null,
  funded: x.funded ?? null, fundingStatus: x.fundingStatus ?? null,
  buyerId: x.buyerAgentId ?? x.buyerId ?? x.buyer?.id ?? null,
  tags: x.tags ?? null, createdAt: x.createdAt ?? null, updatedAt: x.updatedAt ?? null,
  low_confidence: lowConfidenceRe.test(`${x.title || ''} ${x.description || ''} ${JSON.stringify(x.tags || [])}`),
}])).values()];

const fundedStates = new Set(['funded', 'escrowed', 'paid', 'payment_confirmed', 'ready']);
const fundedCompatible = needs.filter((x) => !x.low_confidence && (x.funded === true || fundedStates.has(String(x.fundingStatus || '').toLowerCase())));
const buyerFundedDeals = deals.filter((x) => x.buyerAgentId && x.buyerAgentId !== AGENT_ID && (x.funded === true || fundedStates.has(String(x.escrowStatus || x.paymentStatus || x.status || '').toLowerCase())));
const degraded = [agentR, offersR, needsR, dealsR].some((r) => !r.ok);
const agentObj = objectsDeep(agentR.body).find((x) => x.id === AGENT_ID || x.agentId === AGENT_ID) || agentR.body || {};

const result = {
  ok: true,
  channel: 'agentpact',
  listing_status: offers.length ? 'present' : (offersR.ok ? 'not_found' : 'unknown'),
  discovery_status: degraded ? 'degraded_recoverable' : 'present',
  seller: { id: AGENT_ID, handle: agentObj.handle ?? null, status: agentObj.status ?? null },
  offer_count: offers.length,
  offers,
  buyer_count: new Set(needs.map((x) => x.buyerId).filter(Boolean)).size,
  settlement_count: buyerFundedDeals.length,
  verified_neighbor_demand: needs.length > 0,
  external_requests: needs.length,
  intents_402: 0,
  paid_settlements: buyerFundedDeals.length,
  treasury_received: 0,
  revenue: 0,
  variable_cost: 0,
  contribution_margin: 0,
  evidence_quality: degraded ? 'C_channel_degraded' : 'A_official_public_api',
  compatible_requests: needs.filter((x) => !x.low_confidence),
  funded_compatible_requests: fundedCompatible,
  buyer_funded_deals: buyerFundedDeals,
  channel_http: {
    agent: agentR.status, offers: offersR.status, needs: needsR.status, deals: dealsR.status,
  },
};
console.log(JSON.stringify(result, null, 2));
