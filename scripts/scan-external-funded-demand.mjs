const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const USER_AGENT = 'DELTA-Revenue-Demand-Scanner/1.3';
const OWNER_PRICE = Object.freeze({ capture: 1, preflight: 5, 'guarded-action-pilot': 10 });

// Broad terms discover adjacent paid inventory. They are NOT enough to call a task DELTA-compatible.
const ADJACENT = /\b(evidence|verify|verification|preflight|proof|audit|web\s*page|website|browser|scrap|monitor|price|pricing|availability|inventory|terms|policy|procurement|vendor|public\s+source|public\s+url|change\s+detection|snapshot|crawl|product)\b/i;

// A DELTA-native request must ask for an observation/verification result that the existing product can fulfill,
// not for custom software, generic research, scraping code, or a new system to be built.
const NATIVE_SIGNAL = /\b(page[- ]state|webpage\s+(?:state|snapshot|evidence|proof)|public\s+(?:page|url|source).{0,80}(?:verify|verification|evidence|proof|snapshot|observe|observation|capture|check)|(?:verify|verification|evidence|proof|snapshot|observe|observation|capture|check).{0,80}public\s+(?:page|url|source)|(?:price|availability|inventory|terms|policy|vendor|procurement).{0,80}(?:verify|verification|evidence|proof|snapshot|observe|observation|capture|check)|(?:verify|verification|evidence|proof|snapshot|observe|observation|capture|check).{0,80}(?:price|availability|inventory|terms|policy|vendor|procurement)|change\s+detection.{0,80}(?:page|website|url)|preflight.{0,80}(?:page|website|url|public))\b/i;
const BUILD_DELIVERABLE = /\b(build|implement|write\s+(?:a|an|the)?\s*(?:script|module|library|api|app|crawler|parser)|develop|code|repository|pull\s+request|commit|test\s+suite|package|cli|sdk|interactive\s+(?:site|website)|html\s+site)\b/i;
const GENERIC_RESEARCH = /\b(research|compile|comparison|compare|survey|list\s+\d+|find\s+\d+)\b/i;
const PREFLIGHT_SIGNAL = /\b(preflight|before\s+(?:checkout|purchase|submit|submission|action|execution)|expected\s+(?:text|content|state)|must\s+contain|must\s+not\s+contain|compare\s+(?:state|hash|content))\b/i;
const PILOT_SIGNAL = /\bguarded[- ]action\s+pilot\b/i;

async function fetchJson(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 2000) }; }
      if ([429, 500, 502, 503, 504].includes(res.status)) throw new Error(`http_${res.status}`);
      return { ok: res.ok, status: res.status, body, attempt, url };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < 3) await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  return { ok: false, status: null, body: null, error: lastError, url };
}

function deepObjects(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (!Array.isArray(value)) out.push(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') deepObjects(child, out);
  }
  return out;
}

function first(...values) {
  return values.find((v) => v !== undefined && v !== null && v !== '');
}

function textOf(o) {
  return [
    o.title, o.name, o.description, o.summary, o.goal, o.task, o.requirements,
    o.acceptance_criteria, o.acceptanceCriteria, o.tags, o.category, o.job_type,
  ].map((v) => typeof v === 'string' ? v : JSON.stringify(v ?? '')).join(' ');
}

function dedupe(rows) {
  return [...new Map(rows.filter((x) => x.id).map((x) => [String(x.id), x])).values()];
}

function normalizeMoney(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n > 100000 ? n / 1_000_000 : n;
}

function normalizeBaseUnits(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n / 1_000_000;
}

function classifyNative(o) {
  const text = textOf(o);
  const category = String(first(o.category, o.category_slug, o.job_type) || '').toLowerCase();
  const codeLike = category === 'code' || category === 'development' || BUILD_DELIVERABLE.test(text);
  const genericResearch = GENERIC_RESEARCH.test(text) && !NATIVE_SIGNAL.test(text);
  return {
    adjacent: ADJACENT.test(text),
    native: NATIVE_SIGNAL.test(text) && !codeLike && !genericResearch,
    reason: codeLike ? 'custom_build_not_existing_delta_product' : genericResearch ? 'generic_research_not_delta_fulfillment' : NATIVE_SIGNAL.test(text) ? 'existing_delta_observation_or_verification_fit' : 'adjacent_terms_only',
  };
}

function recommendedProduct(row) {
  const text = [row.title, row.description, row.requirements].filter(Boolean).join(' ');
  if (PILOT_SIGNAL.test(text)) return 'guarded-action-pilot';
  if (PREFLIGHT_SIGNAL.test(text)) return 'preflight';
  return 'capture';
}

function withPriceGate(row) {
  const recommended_product = recommendedProduct(row);
  const minimum_price_usdc = OWNER_PRICE[recommended_product];
  const budget = Number(first(row.budget_usdc, row.reward_usdc));
  const knownBudget = Number.isFinite(budget) && budget >= 0;
  const price_compatible = knownBudget ? budget >= minimum_price_usdc : null;
  return {
    ...row,
    recommended_product,
    minimum_price_usdc,
    price_compatible,
    price_fit_reason: price_compatible === true
      ? 'buyer_budget_meets_current_owner_price'
      : price_compatible === false
        ? 'buyer_budget_below_current_owner_price'
        : 'buyer_budget_unknown_do_not_treat_as_compatible',
  };
}

function makeRow(o, extras = {}) {
  const classification = classifyNative(o);
  return withPriceGate({
    id: first(o.id, o.job_id, o.task_id, o.opportunity_id, o.bounty_id),
    title: first(o.title, o.name, o.description),
    description: first(o.description, o.summary, o.goal, o.task),
    requirements: first(o.requirements, o.acceptance_criteria, o.acceptanceCriteria),
    category: first(o.category, o.category_slug, o.job_type),
    delta_native: classification.native,
    fit_reason: classification.reason,
    ...extras,
  });
}

function bountyBookInventory(body) {
  const objs = deepObjects(body);
  const rows = objs.filter((o) => o && first(o.id, o.job_id) && first(o.title, o.description) && ADJACENT.test(textOf(o))).map((o) => makeRow(o, {
    status: first(o.status, o.state),
    budget_usdc: normalizeMoney(first(o.budget_usdc, o.budget, o.reward_usdc, o.reward)),
    funded: first(o.funded, o.is_funded, o.escrowed),
    funding_status: first(o.funding_status, o.fundingStatus, o.payment_status),
    deadline: first(o.deadline, o.expires_at, o.expiresAt),
  }));
  return dedupe(rows).filter((x) => ['open', 'published', 'claimable', 'ready'].includes(String(x.status || '').toLowerCase()) || x.status == null);
}

function rinerInventory(body) {
  const objs = deepObjects(body);
  const rows = objs.filter((o) => o && first(o.id, o.task_id) && first(o.title, o.description) && ADJACENT.test(textOf(o))).map((o) => makeRow(o, {
    status: first(o.status, o.state),
    budget_usdc: normalizeMoney(first(o.budget_amount, o.budget_usdc, o.budget, o.reward)),
    selection_mode: first(o.selection_mode, o.selectionMode),
    deadline: first(o.deadline, o.expires_at, o.expiresAt),
  }));
  return dedupe(rows).filter((x) => String(x.status || '').toLowerCase() === 'published');
}

function agentBountiesInventory(body) {
  const objs = deepObjects(body);
  const rows = objs.filter((o) => o && first(o.id, o.opportunity_id, o.bounty_id) && first(o.title, o.name, o.description) && ADJACENT.test(textOf(o))).map((o) => makeRow(o, {
    status: first(o.status, o.work_status, o.state),
    payment_status: first(o.payment_status, o.paymentStatus, o.funding_status, o.fundingStatus),
    claimable: first(o.claimable, o.is_claimable),
    reward_usdc: normalizeMoney(first(o.solver_reward_usdc, o.reward_usdc, o.reward, o.amount, o.committed_reward)),
    required_external_spend_usdc: normalizeMoney(first(o.required_external_spend_usdc, o.required_external_spend, o.external_spend)),
    deadline: first(o.deadline, o.expires_at, o.expiresAt),
    verification: first(o.verification, o.verification_type, o.verifier),
  }));
  return dedupe(rows).filter((x) => x.claimable === true || ['funded', 'ready', 'claimable'].includes(String(x.payment_status || '').toLowerCase()));
}

function taskmarketInventory(body) {
  const tasks = Array.isArray(body?.tasks) ? body.tasks : [];
  const rows = tasks.filter((o) => o && o.id && o.description && String(o.status || '').toLowerCase() === 'open' && ADJACENT.test(textOf(o))).map((o) => makeRow(o, {
    status: o.status,
    mode: o.mode,
    budget_usdc: normalizeBaseUnits(o.reward),
    requester: o.requester,
    requester_agent_id: o.requesterAgentId ?? null,
    deadline: o.expiryTime,
    tags: Array.isArray(o.tags) ? o.tags : [],
    escrow_tx_hash: o.escrowTxHash ?? null,
  }));
  return dedupe(rows);
}

function clawlancerInventory(body) {
  const objs = deepObjects(body);
  const rows = objs.filter((o) => {
    const type = String(first(o.listing_type, o.listingType, o.type) || '').toUpperCase();
    const status = String(first(o.status, o.state) || '').toLowerCase();
    return o && first(o.id, o.listing_id) && first(o.title, o.description) && (!type || type === 'BOUNTY') && (!status || ['active', 'open', 'available', 'funded'].includes(status)) && ADJACENT.test(textOf(o));
  }).map((o) => makeRow(o, {
    status: first(o.status, o.state),
    listing_type: first(o.listing_type, o.listingType, o.type),
    budget_usdc: normalizeBaseUnits(first(o.price, o.price_wei, o.reward, o.amount)),
    seller_or_buyer: first(o.seller_name, o.buyer_name, o.poster_name, o.agent_name),
    claimed: first(o.claimed, o.is_claimed),
    created_at: first(o.created_at, o.createdAt),
  }));
  return dedupe(rows).filter((x) => x.claimed !== true);
}

const sources = [
  {
    channel: 'bountybook',
    url: 'https://api.bountybook.ai/jobs?status=open&limit=100',
    parse: bountyBookInventory,
    funded_semantics: 'Open jobs are escrow-backed by platform design; exact job state still requires readback before claim.',
    action_boundary: 'claim/auth requires wallet identity/signature; never claim without separate exact-action authorization',
  },
  {
    channel: 'riner',
    url: 'https://api.riner.io/api/v1/tasks?limit=100&sort_by=created_at_desc',
    parse: rinerInventory,
    funded_semantics: 'Published tasks have USDC locked in Base escrow according to Riner documentation.',
    action_boundary: 'autonomous agent registration requires EIP-191 wallet signature; never register/apply without separate exact-action authorization',
  },
  {
    channel: 'agent_bounties',
    url: 'https://api.agentbounties.app/v1/base/autonomous-bounties/feed?network=base-mainnet&claimable_only=true',
    parse: agentBountiesInventory,
    funded_semantics: 'Use only canonical funded/claimable state; settlement requires canonical BountySettled/CompetitionSettledV2 evidence.',
    action_boundary: 'claim requires wallet-owner signature; never sign or claim without separate exact-action authorization',
  },
  {
    channel: 'taskmarket',
    url: 'https://api.taskmarket.dev/api/tasks?status=open&sort=newest&limit=100',
    parse: taskmarketInventory,
    funded_semantics: 'Public open Taskmarket tasks are created with USDC reward escrow; the official status=open list excludes already-expired open tasks.',
    action_boundary: 'worker entry/delivery requires wallet identity/signature and pitch/bid/benchmark entry can require 0.001 USDC x402; never submit, claim, pitch, bid or proof without separate exact-action authorization',
  },
  {
    channel: 'clawlancer',
    url: 'https://clawlancer.ai/api/listings?listing_type=BOUNTY',
    parse: clawlancerInventory,
    funded_semantics: 'Clawlancer documents bounties as pre-funded by the poster; current payout amount is read from the official listings API and must meet DELTA owner pricing before it is considered compatible.',
    action_boundary: 'claim/delivery uses an agent wallet and Base gas; never register, fund gas, claim, deliver, withdraw, or sign without separate exact-action authorization',
  },
];

const fetched = await Promise.all(sources.map((s) => fetchJson(s.url)));
const results = sources.map((source, i) => {
  const response = fetched[i];
  if (!response.ok) {
    return {
      channel: source.channel,
      discovery_status: 'degraded_recoverable',
      http: response.status,
      error: response.error || `http_${response.status}`,
      adjacent_funded_requests: [],
      delta_native_raw_requests: [],
      delta_native_price_incompatible_requests: [],
      delta_native_funded_requests: [],
      delta_native_funded_count: 0,
      evidence_quality: response.status ? 'B_official_public_api_error' : 'C_channel_degraded',
      mutation: false,
    };
  }
  let inventory = [];
  try { inventory = source.parse(response.body); } catch (error) {
    return {
      channel: source.channel,
      discovery_status: 'degraded_recoverable',
      http: response.status,
      error: `parse_error:${error instanceof Error ? error.message : String(error)}`,
      adjacent_funded_requests: [],
      delta_native_raw_requests: [],
      delta_native_price_incompatible_requests: [],
      delta_native_funded_requests: [],
      delta_native_funded_count: 0,
      evidence_quality: 'C_parse_unknown',
      mutation: false,
    };
  }
  const rawNative = inventory.filter((x) => x.delta_native === true);
  const compatible = rawNative.filter((x) => x.price_compatible === true);
  const priceIncompatible = rawNative.filter((x) => x.price_compatible === false);
  const unknownPrice = rawNative.filter((x) => x.price_compatible == null);
  return {
    channel: source.channel,
    discovery_status: 'present',
    http: response.status,
    buyer_count: null,
    adjacent_funded_count: inventory.length,
    adjacent_funded_requests: inventory.slice(0, 20),
    delta_native_raw_count: rawNative.length,
    delta_native_raw_requests: rawNative.slice(0, 20),
    delta_native_price_incompatible_count: priceIncompatible.length,
    delta_native_price_incompatible_requests: priceIncompatible.slice(0, 20),
    delta_native_unknown_price_count: unknownPrice.length,
    delta_native_funded_count: compatible.length,
    delta_native_funded_requests: compatible.slice(0, 20),
    funded_semantics: source.funded_semantics,
    action_boundary: source.action_boundary,
    evidence_quality: 'A_official_public_api_current',
    mutation: false,
  };
});

console.log(JSON.stringify({
  ok: true,
  checked_at: new Date().toISOString(),
  purpose: 'revenue_first_funded_buyer_demand',
  compatibility_rule: 'funded compatible requires existing DELTA Capture/Preflight/Watch/Pilot fulfillment fit AND a known buyer budget at or above the unchanged owner price; generic code/research and unknown/under-floor budgets are excluded',
  owner_price_usdc: OWNER_PRICE,
  results,
  total_delta_native_raw_requests: results.reduce((sum, r) => sum + (r.delta_native_raw_count || 0), 0),
  total_delta_native_price_incompatible_requests: results.reduce((sum, r) => sum + (r.delta_native_price_incompatible_count || 0), 0),
  total_delta_native_funded_requests: results.reduce((sum, r) => sum + (r.delta_native_funded_count || 0), 0),
  total_adjacent_funded_requests: results.reduce((sum, r) => sum + (r.adjacent_funded_count || 0), 0),
  financial_or_signature_action_taken: false,
}, null, 2));
