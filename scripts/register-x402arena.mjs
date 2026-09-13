import { spawnSync } from 'node:child_process';

const API = 'https://core.x402arena.gg';
const ORIGIN = 'https://delta-witness-api.ruphussten.workers.dev';
const ENDPOINT = `${ORIGIN}/v1/capture`;
const TREASURY = '0x1990e21bc219696ff7fbc26527dbaed335ac6367';
const NAME = 'delta-witness';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runGate(script) {
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`core pricing gate failed: ${script} exit=${result.status}`);
}

// This is a price-bearing external listing. Never write it unless the current
// owner policy and live public 402 challenges agree with the canonical ladder.
runGate('scripts/check-owner-pricing.mjs');
runGate('scripts/verify-owner-pricing-live.mjs');

const result = {
  channel: 'x402arena',
  listing_status: 'unknown',
  discovery_status: 'unknown',
  duplicate_avoided: false,
  submission_attempts: 0,
  buyer_count: null,
  settlement_count: null,
  verified_neighbor_demand: true,
  external_requests: null,
  '402_intents': 0,
  paid_settlements: 0,
  treasury_received: 0,
  revenue: 0,
  variable_cost: 0,
  contribution_margin: 0,
  evidence_quality: 'A_official_arena_API',
};

function rows(json) {
  if (Array.isArray(json)) return json;
  for (const key of ['agents', 'data', 'items', 'results']) {
    if (Array.isArray(json?.[key])) return json[key];
  }
  return [];
}

function isDelta(row) {
  const text = JSON.stringify(row).toLowerCase();
  return text.includes(NAME)
    || text.includes('delta witness')
    || text.includes(ENDPOINT.toLowerCase())
    || text.includes(ORIGIN.toLowerCase())
    || text.includes(TREASURY.toLowerCase());
}

async function fetchText(url, init = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(25000) });
      const text = await response.text();
      let body = text;
      try { body = JSON.parse(text); } catch {}
      return { response, body };
    } catch (error) {
      lastError = error;
      console.error(JSON.stringify({
        event: 'x402arena_channel_degraded',
        operation: init.method || 'GET',
        attempt,
        error: String(error),
      }));
      if (attempt < 3) await sleep(800 * attempt);
    }
  }
  throw lastError;
}

async function readCatalog() {
  const { response, body } = await fetchText(`${API}/operator/agents`);
  if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
  const all = rows(body);
  return { all, matches: all.filter(isDelta) };
}

const listing = {
  name: NAME,
  endpoint: ENDPOINT,
  description: 'Independent public page-state evidence for agents: capture a live webpage and return timestamped, hash-addressed proof artifacts. Public Capture is 1.00 USDC on canonical Base USDC.',
  niche: 'agent-trust',
  walletAddress: TREASURY,
  method: 'POST',
  inputSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: {
        type: 'string',
        format: 'uri',
        description: 'Public http(s) URL to preserve as a timestamped evidence bundle.',
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      product: { type: 'string' },
      proof_id: { type: 'string' },
      manifest_url: { type: 'string', format: 'uri' },
      public_proof_url: { type: 'string', format: 'uri' },
      bundle_root: { type: 'string' },
      observed_at: { type: 'string' },
    },
  },
  resourceType: 'http',
};

let catalog;
try {
  catalog = await readCatalog();
  result.buyer_count = Number.isFinite(Number(catalog.all?.buyer_count)) ? Number(catalog.all.buyer_count) : null;
} catch (error) {
  result.listing_status = 'degraded_precheck';
  result.discovery_status = 'degraded';
  result.error = String(error);
  console.log(`X402ARENA_RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}

if (catalog.matches.length) {
  result.listing_status = 'already_listed';
  result.discovery_status = 'present';
  result.duplicate_avoided = true;
  result.matches = catalog.matches;
  console.log(`X402ARENA_RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}

async function submitOnce() {
  result.submission_attempts += 1;
  try {
    const { response, body } = await fetchText(`${API}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(listing),
    });
    result.last_response = { status: response.status, body };
    return { ok: response.ok, status: response.status };
  } catch (error) {
    result.last_response = { transport_error: String(error) };
    return { ok: false, status: 0 };
  }
}

let submission = await submitOnce();
await sleep(1500);
let readback = [];
try {
  readback = (await readCatalog()).matches;
} catch (error) {
  result.readback_error = String(error);
}

// A 402 from the Arena registration endpoint means the channel itself asks for
// payment. Standing DELTA authority forbids paying listing/signup fees, so stop
// cleanly and never sign or move funds. This is distinct from DELTA's own 402.
if (submission.status === 402 && !readback.length) {
  result.listing_status = 'registration_payment_required_not_authorized';
  result.discovery_status = 'blocked_by_channel_fee';
  console.log(`X402ARENA_RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}

// Retry only recoverable transport/server/rate-limit failures. An ambiguous
// first POST is always followed by readback before any retry, preventing a
// duplicate if the remote accepted the write but lost the response.
if (
  !readback.length
  && !submission.ok
  && (submission.status === 0 || submission.status === 429 || submission.status >= 500)
) {
  await sleep(2500);
  submission = await submitOnce();
  await sleep(1800);
  try {
    readback = (await readCatalog()).matches;
  } catch (error) {
    result.readback_error_2 = String(error);
  }
}

if (readback.length) {
  result.listing_status = 'live';
  result.discovery_status = 'present';
  result.matches = readback;
} else if (submission.ok) {
  result.listing_status = 'submitted_readback_pending';
  result.discovery_status = 'pending';
} else {
  result.listing_status = 'channel_degraded_or_rejected';
  result.discovery_status = 'unknown';
}

console.log(`X402ARENA_RESULT ${JSON.stringify(result)}`);
