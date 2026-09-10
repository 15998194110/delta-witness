const BASE = 'https://allmcps.com';
const REPO_URL = 'https://github.com/15998194110/delta-witness';
const NAME = 'DELTA Witness MCP';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(url, init = {}) {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 1000) }; }
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

function normalized(value) {
  return String(value || '').trim().toLowerCase().replace(/\/$/, '');
}

let degraded = false;
try {
  const search = await request(`${BASE}/api/v1/search?q=${encodeURIComponent('DELTA Witness')}&limit=100`);
  if (!search.response.ok) throw new Error(`search_http_${search.response.status}`);
  const servers = Array.isArray(search.body?.servers) ? search.body.servers : [];
  const match = servers.find((server) => {
    const url = normalized(server.url);
    const name = normalized(server.name);
    const installName = normalized(server.installName);
    return url === normalized(REPO_URL) || name.includes('delta witness') || installName.includes('delta-witness');
  });
  if (match) {
    console.log(`ALLMCPS_CURRENT id=${match.id} name=${JSON.stringify(match.name)} url=${JSON.stringify(match.url)} active=${Boolean(match.isVerifiedActive)}`);
  } else {
    const payload = {
      name: NAME,
      url: REPO_URL,
      description: 'MCP and x402-native evidence/preflight service for autonomous agents. Captures public page state, verifies fresh conditions before consequential actions, and exposes a production-verified guarded-action pilot on Base.',
      category: 'Security',
      email: 'ruphussten85@gmail.com',
      tags: ['mcp', 'x402', 'agent-safety', 'verification', 'evidence', 'base'],
      license: 'MIT',
      authType: 'none',
      pricingModel: 'paid',
      maintenanceStatus: 'active',
      compatibleClients: ['Claude Code', 'Cursor', 'ChatGPT', 'VS Code'],
      supportUrl: REPO_URL
    };
    const submit = await request(`${BASE}/api/v1/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!submit.response.ok) throw new Error(`submit_http_${submit.response.status}:${JSON.stringify(submit.body).slice(0,500)}`);
    console.log(`ALLMCPS_SUBMITTED id=${submit.body?.id || 'unknown'} status=${submit.body?.status || 'unknown'} success=${Boolean(submit.body?.success)} claim_url=${submit.body?.claim_url || 'none'}`);
    if (submit.body?.badge_markdown) {
      console.log(`ALLMCPS_BADGE ${JSON.stringify(submit.body.badge_markdown)}`);
    }
  }
} catch (error) {
  degraded = true;
  console.error(`ALLMCPS_DEGRADED recoverable=true error=${String(error.message || error)}`);
}

if (degraded) process.exitCode = 1;
