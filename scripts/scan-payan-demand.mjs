const REQUESTS_URL = 'https://payanagent.com/api/v1/requests?status=open&limit=100';
const BASE_RPCS = [
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchBounded(url, init = {}, attempts = 4) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          'user-agent': 'DELTA-Witness-Demand-Scanner/1.0',
          accept: 'application/json',
          ...(init.headers || {}),
        },
      });
      const body = await response.text();
      if (response.ok) return { ok: true, response, body, attempt };
      const retryable = response.status === 429 || response.status >= 500;
      lastError = new Error(`http_${response.status}:${body.slice(0, 300)}`);
      if (!retryable || attempt === attempts) break;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
    } finally {
      clearTimeout(timer);
    }
    await wait(Math.min(8_000, 600 * 2 ** (attempt - 1)));
  }
  return { ok: false, error: String(lastError?.message || lastError || 'unknown_error') };
}

async function rpcReceipt(txHash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) {
    return { verified: false, evidence: 'missing_or_invalid_tx_hash' };
  }

  let degraded = [];
  for (const rpc of BASE_RPCS) {
    const result = await fetchBounded(
      rpc,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getTransactionReceipt',
          params: [txHash],
        }),
      },
      2,
    );
    if (!result.ok) {
      degraded.push(`${rpc}:${result.error}`);
      continue;
    }
    try {
      const payload = JSON.parse(result.body);
      const receipt = payload?.result;
      if (receipt && receipt.transactionHash?.toLowerCase() === txHash.toLowerCase()) {
        const success = receipt.status === '0x1';
        return {
          verified: success,
          evidence: success ? 'base_receipt_success' : 'base_receipt_failed',
          blockNumber: receipt.blockNumber || null,
          rpc,
        };
      }
    } catch (error) {
      degraded.push(`${rpc}:malformed_json:${error.message}`);
    }
  }
  return { verified: false, evidence: 'base_receipt_unavailable', degraded };
}

function requestArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.requests)) return payload.requests;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.openRequests)) return payload.openRequests;
  return [];
}

function normalize(raw) {
  const id = raw.id || raw.requestId || raw.request_id || null;
  const title = String(raw.title || raw.name || '');
  const description = String(raw.description || raw.details || raw.inputPayload || raw.input_payload || '');
  const text = `${title}\n${description}`.toLowerCase();
  const budgetMaxCents = Number(raw.budgetMaxCents ?? raw.budget_max_cents ?? raw.budgetCents ?? raw.budget_cents ?? 0);
  const escrow = Boolean(raw.escrow ?? raw.isEscrowed ?? raw.is_escrowed ?? false);
  const escrowStatus = String(raw.escrowStatus ?? raw.escrow_status ?? '').toLowerCase() || null;
  const escrowTxHash = raw.escrowTxHash ?? raw.escrow_tx_hash ?? raw.txHash ?? raw.tx_hash ?? null;
  const bidCount = Number(raw.bidCount ?? raw.bid_count ?? raw.bids?.length ?? 0);
  const createdAt = raw.createdAt ?? raw.created_at ?? null;

  const fit = /(evidence|proof|verify|verification|preflight|capture|browser|webpage|public url|snapshot|audit|guarded|policy|terms|compliance|integrity|sha-?256|timestamp|page state|website state)/i.test(text);
  const spamLike = /(need-check|not a hire|not hiring|micros live|buy urls|seller|companion pack|reply:|promotion|affiliate)/i.test(text);
  const forbidden = /(stake required|worker pays|pay to work|listing fee|verification fee|deposit required)/i.test(text);
  const fundedStatus = ['funded', 'held', 'locked', 'escrowed', 'deposited'].includes(escrowStatus || '');

  return {
    id,
    title,
    description,
    budgetMaxCents: Number.isFinite(budgetMaxCents) ? budgetMaxCents : 0,
    escrow,
    escrowStatus,
    escrowTxHash,
    bidCount: Number.isFinite(bidCount) ? bidCount : 0,
    createdAt,
    fit,
    spamLike,
    forbidden,
    fundedStatus,
  };
}

const fetched = await fetchBounded(REQUESTS_URL);
if (!fetched.ok) {
  const output = {
    ok: true,
    channel: 'payanagent_requests',
    discovery_status: 'degraded_recoverable',
    error: fetched.error,
    external_requests: null,
    funded_compatible_requests: 0,
    evidence_quality: 'C_channel_degraded',
    mutation: false,
  };
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(fetched.body);
} catch (error) {
  console.log(JSON.stringify({
    ok: true,
    channel: 'payanagent_requests',
    discovery_status: 'degraded_recoverable',
    error: `malformed_json:${error.message}`,
    external_requests: null,
    funded_compatible_requests: 0,
    evidence_quality: 'C_channel_degraded',
    mutation: false,
  }, null, 2));
  process.exit(0);
}

const requests = requestArray(payload).map(normalize);
const provisional = requests.filter((r) =>
  r.id && r.fit && !r.spamLike && !r.forbidden && r.budgetMaxCents > 0 && r.escrow && (r.fundedStatus || r.escrowTxHash),
);

const candidates = [];
for (const request of provisional) {
  let detail = null;
  const detailFetch = await fetchBounded(`https://payanagent.com/api/v1/requests/${encodeURIComponent(request.id)}`, {}, 3);
  if (detailFetch.ok) {
    try {
      const detailPayload = JSON.parse(detailFetch.body);
      detail = normalize(detailPayload?.request || detailPayload);
    } catch {
      detail = null;
    }
  }

  const merged = detail ? { ...request, ...detail } : request;
  const receipt = await rpcReceipt(merged.escrowTxHash);
  const grade = receipt.verified ? 'A' : (merged.fundedStatus || merged.escrowTxHash ? 'B' : 'C');
  candidates.push({
    id: merged.id,
    title: merged.title,
    budgetMaxCents: merged.budgetMaxCents,
    escrow: merged.escrow,
    escrowStatus: merged.escrowStatus,
    escrowTxHash: merged.escrowTxHash,
    bidCount: merged.bidCount,
    createdAt: merged.createdAt,
    evidence_grade: grade,
    chain_receipt: receipt,
    action: grade === 'A' ? 'funded_compatible_request_requires_operator_bid_decision' : 'recheck_when_chain_evidence_available',
  });
}

const aGrade = candidates.filter((candidate) => candidate.evidence_grade === 'A');
const output = {
  ok: true,
  checked_at: new Date().toISOString(),
  channel: 'payanagent_requests',
  listing_status: 'existing_provider_state_unchanged',
  discovery_status: 'checked',
  external_requests: requests.length,
  funded_requests_detected: requests.filter((r) => r.escrow && r.budgetMaxCents > 0 && (r.fundedStatus || r.escrowTxHash)).length,
  compatible_candidates: candidates.length,
  funded_compatible_requests: aGrade.length,
  buyer_count: aGrade.length,
  settlement_count: 0,
  paid_settlements: 0,
  treasury_received: 0,
  revenue: 0,
  variable_cost: 0,
  contribution_margin: 0,
  evidence_quality: aGrade.length ? 'A_platform_escrow_plus_base_receipt' : 'B_public_request_inventory_no_A_grade_match',
  candidates,
  mutation: false,
  note: 'Read-only scan. No bid is sent unless a separately authorized operator action evaluates the specific request terms.',
};

console.log(JSON.stringify(output, null, 2));

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `\n### PayanAgent buyer-demand scan\n- Open requests: \`${output.external_requests}\`\n- Funded requests observed: \`${output.funded_requests_detected}\`\n- DELTA-compatible candidates: \`${output.compatible_candidates}\`\n- A-grade funded compatible: \`${output.funded_compatible_requests}\`\n- Evidence quality: \`${output.evidence_quality}\`\n`,
  );
}
