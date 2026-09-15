const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const USER_AGENT = 'DELTA-Revenue-Demand-Scanner/1.0';
const FIT = /\b(evidence|verify|verification|preflight|proof|audit|web\s*page|website|browser|scrap|monitor|price|availability|terms|policy|procurement|vendor|public\s+source|public\s+url|change\s+detection|snapshot)\b/i;

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
  // Some canonical feeds expose USDC base units, others decimal USDC.
  return n > 100000 ? n / 1_000_000 : n;
}

function bountyBookCandidates(body) {
  const objs = deepObjects(body);
  const rows = objs.filter((o) => o && first(o.id, o.job_id) && first(o.title, o.description) && FIT.test(textOf(o))).map((o) => ({
    id: first(o.id, o.job_id),
    title: first(o.title, o.name, o.description),
    status: first(o.status, o.state),
    budget_usdc: normalizeMoney(first(o.budget_usdc, o.budget, o.reward_usdc, o.reward)),
    funded: first(o.funded, o.is_funded, o.escrowed),
    funding_status: first(o.funding_status, o.fundingStatus, o.payment_status),
    deadline: first(o.deadline, o.expires_at, o.expiresAt),
    category: first(o.category, o.job_type),
  }));
  return dedupe(rows).filter((x) => ['open', 'published', 'claimable', 'ready'].includes(String(x.status || '').toLowerCase()) || x.status == null);
}

function rinerCandidates(body) {
  const objs = deepObjects(body);
  const rows = objs.filter((o) => o && first(o.id, o.task_id) && first(o.title, o.description) && FIT.test(textOf(o))).map((o) => ({
    id: first(o.id, o.task_id),
    title: first(o.title, o.name, o.description),
    status: first(o.status, o.state),
    budget_usdc: normalizeMoney(first(o.budget_amount, o.budget_usdc, o.budget, o.reward)),
    selection_mode: first(o.selection_mode, o.selectionMode),
    deadline: first(o.deadline, o.expires_at, o.expiresAt),
    category: first(o.category, o.category_slug),
  }));
  // Riner documentation states publishing locks USDC in escrow; only published tasks are buyer-funded inventory.
  return dedupe(rows).filter((x) => String(x.status || '').toLowerCase() === 'published');
}

function agentBountiesCandidates(body) {
  const objs = deepObjects(body);
  const rows = objs.filter((o) => o && first(o.id, o.opportunity_id, o.bounty_id) && first(o.title, o.name, o.description) && FIT.test(textOf(o))).map((o) => ({
    id: first(o.id, o.opportunity_id, o.bounty_id),
    title: first(o.title, o.name, o.description),
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

const sources = [
  {
    channel: 'bountybook',
    url: 'https://api.bountybook.ai/jobs?status=open&limit=100',
    parse: bountyBookCandidates,
    funded_semantics: 'Open jobs are expected to be escrow-backed by platform design; recheck exact job state before any claim.',
    action_boundary: 'claim/auth requires wallet identity/signature; never claim without separate exact-action authorization',
  },
  {
    channel: 'riner',
    url: 'https://api.riner.io/api/v1/tasks?limit=100&sort_by=created_at_desc',
    parse: rinerCandidates,
    funded_semantics: 'Riner documents that published tasks have USDC locked in Base escrow.',
    action_boundary: 'autonomous agent registration requires EIP-191 wallet signature; never register/apply without separate exact-action authorization',
  },
  {
    channel: 'agent_bounties',
    url: 'https://api.agentbounties.app/v1/base/autonomous-bounties/feed?network=base-mainnet&claimable_only=true',
    parse: agentBountiesCandidates,
    funded_semantics: 'Use only canonical funded/claimable state; settlement requires canonical BountySettled/CompetitionSettledV2 evidence.',
    action_boundary: 'claim requires wallet-owner signature; never sign or claim without separate exact-action authorization',
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
      funded_compatible_requests: [],
      evidence_quality: response.status ? 'B_official_public_api_error' : 'C_channel_degraded',
      mutation: false,
    };
  }
  let candidates = [];
  try { candidates = source.parse(response.body); } catch (error) {
    return {
      channel: source.channel,
      discovery_status: 'degraded_recoverable',
      http: response.status,
      error: `parse_error:${error instanceof Error ? error.message : String(error)}`,
      funded_compatible_requests: [],
      evidence_quality: 'C_parse_unknown',
      mutation: false,
    };
  }
  return {
    channel: source.channel,
    discovery_status: 'present',
    http: response.status,
    buyer_count: null,
    funded_compatible_count: candidates.length,
    funded_compatible_requests: candidates.slice(0, 20),
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
  results,
  total_funded_compatible_requests: results.reduce((sum, r) => sum + (r.funded_compatible_count || 0), 0),
  financial_or_signature_action_taken: false,
}, null, 2));
