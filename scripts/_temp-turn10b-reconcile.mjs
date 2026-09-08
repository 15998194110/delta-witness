import { writeFile } from 'node:fs/promises';

const ORIGIN = 'https://delta-witness-api.ruphussten.workers.dev';
const TREASURY = '0x1990e21bc219696ff7fbc26527dbaed335ac6367'.toLowerCase();
const USDC = '0x833589fCD6eDb6E08f4c7C32d4f71b54bdA02913'.toLowerCase();
const START_BLOCK = 51040989;
const TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TOPIC2 = `0x${'0'.repeat(24)}${TREASURY.slice(2)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, init = {}, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
      if (res.status >= 500 || res.status === 429) throw new Error(`http_${res.status}`);
      return res;
    } catch (e) {
      last = e;
      if (i + 1 < attempts) await sleep((i + 1) * 2500);
    }
  }
  throw last;
}

function decodePaymentRequired(header) {
  if (!header) return null;
  try {
    const normalized = header.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

async function probe402(route, body) {
  try {
    const res = await fetchRetry(`${ORIGIN}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'delta-turn10b-reconcile/1' },
      body: JSON.stringify(body),
    });
    let payload = null;
    try { payload = await res.clone().json(); } catch {}
    const challenge = decodePaymentRequired(res.headers.get('payment-required')) || payload || {};
    const accept = Array.isArray(challenge.accepts) ? challenge.accepts[0] || {} : {};
    return {
      ok: res.status === 402,
      http_code: res.status,
      amount: accept.amount ?? null,
      asset: accept.asset ?? null,
      network: accept.network ?? null,
      payTo: accept.payTo ?? null,
    };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 500) };
  }
}

async function getJson(url) {
  try {
    const res = await fetchRetry(url, { headers: { 'user-agent': 'delta-turn10b-reconcile/1' } });
    return { ok: res.ok, http_code: res.status, data: await res.json() };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 500), data: null };
  }
}

async function queryD1() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) return { ok: false, error: 'cloudflare_credentials_unavailable' };
  const sql = `SELECT event, channel, partner, success, count(*) AS rows, round(sum(gross_usd),6) AS gross_usd, round(sum(variable_cost_usd),6) AS variable_cost_usd, round(sum(contribution_margin_usd),6) AS contribution_margin_usd, max(created_at) AS latest FROM telemetry_events WHERE created_at >= datetime('now','-2 hours') AND event IN ('payment_verified','partner_request','capture_started','capture_completed','capture_failed','watch_checked') GROUP BY event, channel, partner, success ORDER BY latest DESC`;
  try {
    const res = await fetchRetry(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/c9431b00-27c5-4609-9f3d-6af20cb162df/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql }),
    }, 3);
    const p = await res.json();
    const result = p.result?.[0];
    if (!res.ok || !p.success || !result?.success) return { ok: false, http_code: res.status, error: JSON.stringify(p.errors || p).slice(0, 1000) };
    const rows = result.results || [];
    return { ok: true, candidate_rows: rows.length, rows };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 500) };
  }
}

async function rpc(endpoint, method, params) {
  const res = await fetchRetry(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'delta-turn10b-reconcile/1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, 3);
  const p = await res.json();
  if (p.error) throw new Error(JSON.stringify(p.error));
  return p.result;
}

async function reconcileTreasury() {
  const endpoints = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org'];
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const latest = Number.parseInt(await rpc(endpoint, 'eth_blockNumber', []), 16);
      const logs = [];
      for (let from = START_BLOCK; from <= latest; from += 500) {
        const to = Math.min(from + 499, latest);
        const chunk = await rpc(endpoint, 'eth_getLogs', [{ address: USDC, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [TOPIC0, null, TOPIC2] }]);
        logs.push(...chunk);
      }
      return {
        ok: true,
        source: endpoint,
        from_block: START_BLOCK,
        latest_block: latest,
        canonical_usdc_incoming: logs.map((x) => ({
          block_number: Number.parseInt(x.blockNumber, 16),
          tx_hash: x.transactionHash,
          log_index: Number.parseInt(x.logIndex, 16),
          from: `0x${x.topics[1].slice(-40)}`,
          to: `0x${x.topics[2].slice(-40)}`,
          raw_amount: BigInt(x.data).toString(),
        })),
        errors,
      };
    } catch (e) {
      errors.push({ source: endpoint, error: String(e).slice(0, 500) });
    }
  }
  try {
    const res = await fetchRetry(`https://base.blockscout.com/api/v2/addresses/${TREASURY}/token-transfers?type=ERC-20`, { headers: { 'user-agent': 'delta-turn10b-reconcile/1' } }, 3);
    const p = await res.json();
    const incoming = [];
    for (const x of p.items || []) {
      const token = x.token || {};
      const to = x.to || {};
      const tokenAddress = String(token.address || token.address_hash || token.contract_address_hash || '').toLowerCase();
      const toAddress = String(typeof to === 'object' ? to.hash || '' : to).toLowerCase();
      if (tokenAddress === USDC && toAddress === TREASURY) {
        incoming.push({ block_number: x.block_number ?? x.block ?? null, tx_hash: x.transaction_hash ?? x.tx_hash ?? null, raw_amount: String(typeof x.total === 'object' ? x.total?.value ?? '' : x.value ?? '') });
      }
    }
    return { ok: true, source: 'https://base.blockscout.com/api/v2', from_block: START_BLOCK, latest_block: null, canonical_usdc_incoming: incoming, errors };
  } catch (e) {
    errors.push({ source: 'blockscout', error: String(e).slice(0, 500) });
    return { ok: false, source: null, from_block: START_BLOCK, latest_block: null, canonical_usdc_incoming: [], errors };
  }
}

const [agent, x402, capture, preflight, pilot, d1, treasury] = await Promise.all([
  getJson(`${ORIGIN}/.well-known/agent.json`),
  getJson(`${ORIGIN}/.well-known/x402`),
  probe402('/v1/capture', { url: 'https://example.com' }),
  probe402('/v1/preflight', { url: 'https://example.com', expected: { contains: ['Example Domain'] } }),
  probe402('/v1/guarded-action-pilot', { urls: ['https://example.com'] }),
  queryD1(),
  reconcileTreasury(),
]);

const agentData = agent.data || {};
const evidence = {
  checked_at: new Date().toISOString(),
  production: {
    agent_http: { ok: agent.ok, http_code: agent.http_code, error: agent.error || null },
    x402_http: { ok: x402.ok, http_code: x402.http_code, error: x402.error || null },
    agent_pricing: agentData.pricing ?? null,
    intent_prices: Object.fromEntries((agentData.intents || []).filter((x) => x && x.name).map((x) => [x.name, x.price ?? null])),
    capture_402: capture,
    preflight_402: preflight,
    pilot_402: pilot,
  },
  d1_paid_funnel: d1,
  treasury,
};

const path = 'docs/channel-status/automation-turn10b-reconcile-2026-09-09.json';
await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
