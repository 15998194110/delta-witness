const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BASE = 'https://workpnp.com/jobs';
const FUNDED_URL = `${BASE}?status=funded`;
const OPEN_URL = `${BASE}?status=open`;
const USER_AGENT = 'DELTA-Revenue-Demand-Scanner/1.0';
const OWNER_PRICE = Object.freeze({ capture: 1, preflight: 5, 'guarded-action-pilot': 10 });

const NATIVE_SIGNAL = /\b(page[- ]state|webpage\s+(?:state|snapshot|evidence|proof)|public\s+(?:page|url|source).{0,80}(?:verify|verification|evidence|proof|snapshot|observe|observation|capture|check)|(?:price|availability|inventory|terms|policy|vendor|procurement).{0,80}(?:verify|verification|evidence|proof|snapshot|observe|observation|capture|check)|preflight.{0,80}(?:page|website|url|public))\b/i;
const PREFLIGHT_SIGNAL = /\b(preflight|before\s+(?:checkout|purchase|submit|submission|action|execution)|must\s+contain|must\s+not\s+contain|compare\s+(?:state|hash|content))\b/i;
const PILOT_SIGNAL = /\bguarded[- ]action\s+pilot\b/i;
const BUILD_DELIVERABLE = /\b(build|implement|write\s+(?:a|an|the)?\s*(?:script|module|library|api|app|crawler|parser)|develop|code|repository|pull\s+request|commit|test\s+suite|package|cli|sdk)\b/i;

function htmlText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchPage(url) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'text/html', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(15000),
      });
      const html = await res.text();
      if ([429, 500, 502, 503, 504].includes(res.status)) throw new Error(`http_${res.status}`);
      return { ok: res.ok, status: res.status, html, attempt };
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  return { ok: false, status: null, html: '', error: last };
}

function shownCount(text, status) {
  const m = text.match(new RegExp(`Work orders\\s*[—-]\\s*${status}\\s+(\\d+)\\s+shown`, 'i'));
  return m ? Number(m[1]) : null;
}

function extractRows(html, status) {
  const rows = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const match of html.matchAll(rowPattern)) {
    const rowHtml = match[1];
    const text = htmlText(rowHtml);
    if (!text || /Title\s+Status\s+Bids\s+Budget/i.test(text) || /^Nothing here yet\.?$/i.test(text)) continue;
    const href = rowHtml.match(/href=["']([^"']*\/jobs\/[^"']+)["']/i)?.[1] || null;
    const budgetMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*USDC\b/i);
    const budget = budgetMatch ? Number(budgetMatch[1]) : null;
    const statusMatch = text.match(/\b(open|funded|delivered|paid)\b/i)?.[1]?.toLowerCase();
    if (statusMatch && statusMatch !== status) continue;
    const title = htmlText(rowHtml.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] || '') || text;
    const native = NATIVE_SIGNAL.test(text) && !BUILD_DELIVERABLE.test(text);
    const product = PILOT_SIGNAL.test(text) ? 'guarded-action-pilot' : PREFLIGHT_SIGNAL.test(text) ? 'preflight' : 'capture';
    const minimum = OWNER_PRICE[product];
    rows.push({
      title,
      status: statusMatch || status,
      url: href ? new URL(href, 'https://workpnp.com').toString() : null,
      budget_usdc: Number.isFinite(budget) ? budget : null,
      delta_native: native,
      recommended_product: product,
      minimum_price_usdc: minimum,
      price_compatible: Number.isFinite(budget) ? budget >= minimum : null,
    });
  }
  return rows;
}

const [funded, open] = await Promise.all([fetchPage(FUNDED_URL), fetchPage(OPEN_URL)]);
if (!funded.ok) {
  console.log(JSON.stringify({
    ok: true,
    checked_at: new Date().toISOString(),
    channel: 'workpnp',
    discovery_status: 'degraded_recoverable',
    http: funded.status,
    error: funded.error || `http_${funded.status}`,
    funded_requests: null,
    delta_native_funded_count: 0,
    funded_compatible_requests: [],
    evidence_quality: funded.status ? 'B_official_public_board_error' : 'C_channel_degraded',
    mutation: false,
    financial_or_signature_action_taken: false,
  }, null, 2));
  process.exit(0);
}

const fundedText = htmlText(funded.html);
const openText = open.ok ? htmlText(open.html) : '';
const fundedShown = shownCount(fundedText, 'funded');
const openShown = open.ok ? shownCount(openText, 'open') : null;
const parsedFundedRows = extractRows(funded.html, 'funded');
const fundedRows = fundedShown === 0 ? [] : parsedFundedRows;
const countConsistent = fundedShown == null || fundedRows.length === fundedShown;
const compatible = fundedRows.filter((x) => x.delta_native && x.price_compatible === true);
const unknown = fundedRows.filter((x) => x.delta_native && x.price_compatible == null);
const underFloor = fundedRows.filter((x) => x.delta_native && x.price_compatible === false);

console.log(JSON.stringify({
  ok: true,
  checked_at: new Date().toISOString(),
  channel: 'workpnp',
  discovery_status: 'present',
  http: funded.status,
  source: FUNDED_URL,
  open_requests_shown: openShown,
  funded_requests_shown: fundedShown,
  funded_rows_parsed: fundedRows.length,
  board_count_consistent: countConsistent,
  funded_requests: fundedRows,
  delta_native_funded_count: compatible.length,
  funded_compatible_requests: compatible,
  delta_native_unknown_price_count: unknown.length,
  delta_native_price_incompatible_count: underFloor.length,
  funded_semantics: 'WorkPnP states Base USDC is locked in escrow before work starts; only the public board status=funded view is treated as funded demand. Open budget rows are not treated as funded.',
  commercial_demand_grade: compatible.length ? 'A_funded_compatible_lead' : 'C_no_current_delta_native_funded_match',
  technical_endpoint_grade: countConsistent ? 'A_official_public_board' : 'B_official_board_parse_incomplete',
  next_conversion_action: compatible.length ? 'Read the specific funded work order and verify direct DELTA fulfillment fit before any bid. Do not register, bid, verify identity, post to X, sign, fund, or deliver unless the relevant authorization boundary is satisfied.' : 'Keep as a read-only funded-demand source. Do not register merely for catalog presence.',
  action_boundary: 'WorkPnP participation requires agent registration followed by human ownership verification using email and an X post; bidding/settlement uses an agent identity/wallet and workers pay a 10% platform fee. This scanner is public read-only and performs no registration, verification, social posting, wallet, bid, signature, financial, or delivery action.',
  evidence_quality: countConsistent ? 'A_official_public_board_current' : 'B_official_public_board_parse_incomplete',
  mutation: false,
  financial_or_signature_action_taken: false,
}, null, 2));
