const API = 'https://api.agentpact.xyz/api';
const AGENT_ID = '5fdb4f2a-0d15-4e27-8d4a-15998194110d';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Broad terms are discovery signals only. They must never be enough to call a need DELTA-native.
const ADJACENT = /\b(evidence|verify|verification|preflight|proof|audit|web\s*page|website|browser|scrap|monitor|price|availability|terms|policy|procurement|vendor|public\s+source|public\s+url|change\s+detection|snapshot|crawl|product|x402|usdc|base)\b/i;
const NATIVE_SIGNAL = /\b(page[- ]state|webpage\s+(?:state|snapshot|evidence|proof)|public\s+(?:page|url|source).{0,80}(?:verify|verification|evidence|proof|snapshot|observe|observation|capture|check)|(?:verify|verification|evidence|proof|snapshot|observe|observation|capture|check).{0,80}public\s+(?:page|url|source)|(?:price|availability|inventory|terms|policy|vendor|procurement).{0,80}(?:verify|verification|evidence|proof|snapshot|observe|observation|capture|check)|(?:verify|verification|evidence|proof|snapshot|observe|observation|capture|check).{0,80}(?:price|availability|inventory|terms|policy|vendor|procurement)|change\s+detection.{0,80}(?:page|website|url)|preflight.{0,80}(?:page|website|url|public))\b/i;
const BUILD_DELIVERABLE = /\b(build|implement|write\s+(?:a|an|the)?\s*(?:script|module|library|api|app|crawler|parser)|develop|code|repository|pull\s+request|commit|test\s+suite|package|cli|sdk)\b/i;
const GENERIC_RESEARCH = /\b(research|compile|comparison|compare|survey|list\s+\d+|find\s+\d+)\b/i;
const lowConfidenceRe = /fleet|bootstrap|self[- ]?test|demo|free[- ]?tier|synthetic|canary/i;

async function fetchJson(path) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${API}${path}`, {
        headers: { 'accept': 'application/json', 'user-agent': 'DELTA-AgentPact-Monitor/1.1' },
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

function needText(x) {
  return `${x.title || ''} ${x.description || ''} ${JSON.stringify(x.tags || [])} ${x.category || ''}`;
}

function classifyNeed(x) {
  const text = needText(x);
  const category = String(x.category || '').toLowerCase();
  const nativeSignal = NATIVE_SIGNAL.test(text);
  const codeLike = category === 'code' || category === 'development' || BUILD_DELIVERABLE.test(text);
  const genericResearch = GENERIC_RESEARCH.test(text) && !nativeSignal;
  const native = nativeSignal && !codeLike && !genericResearch;
  return {
    adjacent: ADJACENT.test(text),
    native,
    reason: codeLike
      ? 'custom_build_not_existing_delta_product'
      : genericResearch
        ? 'generic_research_not_delta_fulfillment'
        : native
          ? 'existing_delta_observation_or_verification_fit'
          : 'adjacent_terms_only',
  };
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

const allNeeds = objectsDeep(needsR.body).filter((x) => x.id && ADJACENT.test(needText(x)));
const needs = [...new Map(allNeeds.map((x) => {
  const fit = classifyNeed(x);
  return [x.id, {
    id: x.id, title: x.title ?? null, description: x.description ?? null, status: x.status ?? null,
    budget: x.budget ?? x.price ?? null, currency: x.currency ?? null,
    funded: x.funded ?? null, fundingStatus: x.fundingStatus ?? null,
    buyerId: x.buyerAgentId ?? x.buyerId ?? x.buyer?.id ?? null,
    tags: x.tags ?? null, category: x.category ?? null, createdAt: x.createdAt ?? null, updatedAt: x.updatedAt ?? null,
    low_confidence: lowConfidenceRe.test(needText(x)),
    delta_native: fit.native,
    fit_reason: fit.reason,
  }];
})).values()];

const fundedStates = new Set(['funded', 'escrowed', 'paid', 'payment_confirmed', 'ready']);
const nativeCompatible = needs.filter((x) => x.delta_native === true && !x.low_confidence);
const fundedCompatible = nativeCompatible.filter((x) => x.funded === true || fundedStates.has(String(x.fundingStatus || '').toLowerCase()));
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
  buyer_count: new Set(nativeCompatible.map((x) => x.buyerId).filter(Boolean)).size,
  settlement_count: buyerFundedDeals.length,
  verified_neighbor_demand: needs.length > 0,
  external_requests: needs.length,
  adjacent_requests: needs,
  delta_native_requests: nativeCompatible,
  intents_402: 0,
  paid_settlements: buyerFundedDeals.length,
  treasury_received: 0,
  revenue: 0,
  variable_cost: 0,
  contribution_margin: 0,
  evidence_quality: degraded ? 'C_channel_degraded' : 'A_official_public_api',
  compatibility_rule: 'DELTA-native requires an existing Capture/Preflight/Watch/Pilot observation or verification fit; generic web/scraping/code/research work is adjacent only',
  compatible_requests: nativeCompatible,
  funded_compatible_requests: fundedCompatible,
  buyer_funded_deals: buyerFundedDeals,
  channel_http: {
    agent: agentR.status, offers: offersR.status, needs: needsR.status, deals: dealsR.status,
  },
};
console.log(JSON.stringify(result, null, 2));
