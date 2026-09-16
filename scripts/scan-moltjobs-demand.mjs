const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const URL = 'https://api.moltjobs.io/v1/jobs?status=OPEN&funded=true&limit=100';
const USER_AGENT = 'DELTA-Revenue-Demand-Scanner/1.0';
const OWNER_PRICE = Object.freeze({ capture: 1, preflight: 5, 'guarded-action-pilot': 10 });

const ADJACENT = /\b(evidence|verify|verification|preflight|proof|audit|web\s*page|webpage|website|browser|monitor|price|pricing|availability|inventory|terms|policy|procurement|vendor|public\s+source|public\s+url|change\s+detection|snapshot|capture)\b/i;
const NATIVE_SIGNAL = /\b(page[- ]state|webpage\s+(?:state|snapshot|evidence|proof)|public\s+(?:page|url|source).{0,80}(?:verify|verification|evidence|proof|snapshot|observe|observation|capture|check)|(?:verify|verification|evidence|proof|snapshot|observe|observation|capture|check).{0,80}public\s+(?:page|url|source)|(?:price|availability|inventory|terms|policy|vendor|procurement).{0,80}(?:verify|verification|evidence|proof|snapshot|observe|observation|capture|check)|(?:verify|verification|evidence|proof|snapshot|observe|observation|capture|check).{0,80}(?:price|availability|inventory|terms|policy|vendor|procurement)|change\s+detection.{0,80}(?:page|website|url)|preflight.{0,80}(?:page|website|url|public))\b/i;
const BUILD_DELIVERABLE = /\b(build|implement|write\s+(?:a|an|the)?\s*(?:script|module|library|api|app|crawler|parser)|develop|code|repository|pull\s+request|commit|test\s+suite|package|cli|sdk|interactive\s+(?:site|website)|html\s+site)\b/i;
const GENERIC_RESEARCH = /\b(research|compile|comparison|compare|survey|list\s+\d+|find\s+\d+)\b/i;
const PREFLIGHT_SIGNAL = /\b(preflight|before\s+(?:checkout|purchase|submit|submission|action|execution)|expected\s+(?:text|content|state)|must\s+contain|must\s+not\s+contain|compare\s+(?:state|hash|content))\b/i;
const PILOT_SIGNAL = /\bguarded[- ]action\s+pilot\b/i;

function first(...values) {
  return values.find((v) => v !== undefined && v !== null && v !== '');
}

function textOf(o) {
  return [o.title, o.name, o.description, o.summary, o.outcome, o.requirements, o.acceptanceCriteria, o.acceptance_criteria, o.tags, o.vertical, o.category]
    .map((v) => typeof v === 'string' ? v : JSON.stringify(v ?? ''))
    .join(' ');
}

function deepObjects(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (!Array.isArray(value)) out.push(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepObjects(child, out);
  return out;
}

function money(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function classify(o) {
  const text = textOf(o);
  const category = String(first(o.vertical, o.category, o.jobType, o.job_type) || '').toLowerCase();
  const codeLike = /code|dev|engineering/.test(category) || BUILD_DELIVERABLE.test(text);
  const genericResearch = GENERIC_RESEARCH.test(text) && !NATIVE_SIGNAL.test(text);
  const native = NATIVE_SIGNAL.test(text) && !codeLike && !genericResearch;
  return {
    adjacent: ADJACENT.test(text),
    native,
    reason: codeLike ? 'custom_build_not_existing_delta_product'
      : genericResearch ? 'generic_research_not_delta_fulfillment'
      : native ? 'existing_delta_observation_or_verification_fit'
      : 'adjacent_terms_only',
  };
}

function recommendedProduct(o) {
  const text = textOf(o);
  if (PILOT_SIGNAL.test(text)) return 'guarded-action-pilot';
  if (PREFLIGHT_SIGNAL.test(text)) return 'preflight';
  return 'capture';
}

async function fetchJson() {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(URL, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 2000) }; }
      if ([429, 500, 502, 503, 504].includes(res.status)) throw new Error(`http_${res.status}`);
      return { ok: res.ok, status: res.status, body, attempt };
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  return { ok: false, status: null, body: null, error: last };
}

const response = await fetchJson();
if (!response.ok) {
  console.log(JSON.stringify({
    ok: true,
    checked_at: new Date().toISOString(),
    channel: 'moltjobs',
    discovery_status: 'degraded_recoverable',
    http: response.status,
    error: response.error || `http_${response.status}`,
    external_requests: null,
    adjacent_funded_count: null,
    delta_native_funded_count: 0,
    funded_compatible_requests: [],
    evidence_quality: response.status ? 'B_official_public_api_error' : 'C_channel_degraded',
    mutation: false,
    financial_or_signature_action_taken: false,
  }, null, 2));
  process.exit(0);
}

const objects = deepObjects(response.body);
const candidates = objects.filter((o) => {
  const id = first(o.id, o.jobId, o.job_id);
  const title = first(o.title, o.name, o.description);
  const status = String(first(o.status, o.state) || '').toUpperCase();
  return id && title && (!status || status === 'OPEN');
});

const rows = [...new Map(candidates.map((o) => {
  const cls = classify(o);
  const product = recommendedProduct(o);
  const budget = money(first(o.budgetUsdc, o.budget_usdc, o.budget, o.rewardUsdc, o.reward_usdc));
  const funded = first(o.funded, o.isFunded, o.is_funded);
  const escrowTxHash = first(o.escrowTxHash, o.escrow_tx_hash);
  const knownFunded = funded === true || typeof escrowTxHash === 'string';
  const minimum = OWNER_PRICE[product];
  const priceCompatible = Number.isFinite(budget) ? budget >= minimum : null;
  const row = {
    id: String(first(o.id, o.jobId, o.job_id)),
    title: first(o.title, o.name),
    description: first(o.description, o.summary, o.outcome),
    status: first(o.status, o.state),
    vertical: first(o.vertical, o.category),
    budget_usdc: budget,
    funded: knownFunded,
    escrow_tx_hash: escrowTxHash ?? null,
    delta_native: cls.native,
    fit_reason: cls.reason,
    recommended_product: product,
    minimum_price_usdc: minimum,
    price_compatible: priceCompatible,
    price_fit_reason: priceCompatible === true ? 'buyer_budget_meets_current_owner_price' : priceCompatible === false ? 'buyer_budget_below_current_owner_price' : 'buyer_budget_unknown_do_not_treat_as_compatible',
    certification_required: first(o.certificationRequired, o.certification_required, o.requiredCertification, o.required_certification) ?? null,
    deadline: first(o.deadline, o.deadlineAt, o.deadline_at, o.expiresAt, o.expires_at) ?? null,
  };
  return [row.id, { row, adjacent: cls.adjacent }];
})).values()].map((x) => x.row);

const fundedRows = rows.filter((x) => x.funded === true);
const adjacent = fundedRows.filter((x) => ADJACENT.test([x.title, x.description].filter(Boolean).join(' ')));
const rawNative = fundedRows.filter((x) => x.delta_native === true);
const compatible = rawNative.filter((x) => x.price_compatible === true);
const priceIncompatible = rawNative.filter((x) => x.price_compatible === false);
const unknownPrice = rawNative.filter((x) => x.price_compatible == null);

console.log(JSON.stringify({
  ok: true,
  checked_at: new Date().toISOString(),
  channel: 'moltjobs',
  discovery_status: 'present',
  http: response.status,
  source: URL,
  external_requests: rows.length,
  funded_rows: fundedRows.length,
  adjacent_funded_count: adjacent.length,
  adjacent_funded_requests: adjacent,
  delta_native_raw_count: rawNative.length,
  delta_native_raw_requests: rawNative,
  delta_native_price_incompatible_count: priceIncompatible.length,
  delta_native_price_incompatible_requests: priceIncompatible,
  delta_native_unknown_price_count: unknownPrice.length,
  delta_native_funded_count: compatible.length,
  funded_compatible_requests: compatible,
  funded_semantics: 'Only rows from the official OPEN+funded feed with an explicit funded or escrow transaction signal are treated as funded leads; assignment and settlement remain separate states.',
  commercial_demand_grade: compatible.length ? 'A_funded_compatible_lead' : 'C_no_current_delta_native_funded_match',
  technical_endpoint_grade: 'A_official_public_api',
  next_conversion_action: compatible.length ? 'Read the specific job requirements and certification gate before any bid; do not register, bid, pay, sign, or run a paid eval without the required authorization.' : 'Keep as read-only funded-demand source; do not create an account merely for catalog presence.',
  action_boundary: 'MoltJobs registration/bidding can require account identity, certification, API key, wallet setup, and possibly paid eval access. This scanner performs public GETs only and takes no account, financial, signature, bid, or delivery action.',
  mutation: false,
  financial_or_signature_action_taken: false,
}, null, 2));
