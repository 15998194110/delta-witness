import { spawnSync } from 'node:child_process';

const ORIGIN = 'https://delta-witness-api.ruphussten.workers.dev';
const TREASURY = '0x1990e21bc219696ff7fbc26527dbaed335ac6367';
const API = 'https://api.sifr0.dev/v1';
const SEARCH = `${API}/search?text=${encodeURIComponent('DELTA Witness')}&limit=100`;
const REGISTER = `${API}/register`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runGate(script) {
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`core pricing gate failed: ${script} exit=${result.status}`);
  }
}

// SIFR-0 is a price-bearing external listing, so enforce the canonical owner policy
// and live public 402 amounts immediately before any possible write.
runGate('scripts/check-owner-pricing.mjs');
runGate('scripts/verify-owner-pricing-live.mjs');

const result = {
  channel: 'sifr0',
  source: 'https://api.sifr0.dev/v1/register',
  listing_status: 'unknown',
  discovery_status: 'unknown',
  buyer_count: null,
  settlement_count: null,
  verified_neighbor_demand: false,
  external_requests: 0,
  intents_402: 0,
  paid_settlements: 0,
  treasury_received: 0,
  revenue: 0,
  variable_cost: 0,
  contribution_margin: 0,
  evidence_quality: 'B_official_registry_API_no_buyer_settlement_evidence',
  duplicate_avoided: false,
  submission_attempts: 0,
};

function containsDelta(value) {
  const text = JSON.stringify(value ?? '').toLowerCase();
  return text.includes('delta witness')
    || text.includes(ORIGIN.toLowerCase())
    || text.includes(TREASURY.toLowerCase());
}

async function requestJson(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(25000),
      });
      const text = await response.text();
      let body = text;
      try { body = text ? JSON.parse(text) : null; } catch {}
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        error.body = body;
        throw error;
      }
      return { response, body };
    } catch (error) {
      lastError = error;
      const status = Number(error?.status ?? 0);
      const recoverable = status === 0 || status === 408 || status === 429 || status >= 500;
      console.error(JSON.stringify({
        event: 'sifr0_channel_degraded',
        operation: options.method ?? 'GET',
        url,
        attempt,
        status,
        recoverable,
        error: String(error),
      }));
      if (!recoverable || attempt >= attempts) throw error;
      await sleep(700 * attempt);
    }
  }
  throw lastError;
}

async function readRegistry() {
  const { body } = await requestJson(SEARCH, {}, 3);
  return body;
}

const manifest = {
  sifr0: '0.2.0',
  entity: {
    name: 'DELTA Witness',
    type: 'AI agent verification service',
    category: ['agent-verification', 'web-evidence', 'x402', 'agent-safety'],
    description: `Machine-verifiable public web evidence capture and deterministic preflight verification for autonomous agents. Canonical API: ${ORIGIN}`,
    website: ORIGIN,
  },
  services: [
    {
      id: 'public-capture',
      name: 'DELTA Witness Public Capture',
      description: 'Timestamp a public HTTPS page state and return verifiable proof metadata and hashes through canonical x402 settlement on Base.',
      price: '1 USDC',
      booking_url: `${ORIGIN}/v1/capture`,
      availability: 'on-demand',
      modality: 'API',
    },
    {
      id: 'public-preflight',
      name: 'DELTA Witness Public Preflight',
      description: 'Compare a fresh public-source observation with deterministic expectations before an autonomous agent acts.',
      price: '5 USDC',
      booking_url: `${ORIGIN}/v1/preflight`,
      availability: 'on-demand',
      modality: 'API',
    },
    {
      id: 'guarded-action-pilot',
      name: 'DELTA Witness Guarded-Action Pilot',
      description: 'Capture 1-3 public HTTPS page-state proofs and optionally run one deterministic preflight condition for a guarded autonomous action.',
      price: '10 USDC',
      booking_url: `${ORIGIN}/v1/guarded-action-pilot`,
      availability: 'on-demand',
      modality: 'API',
    },
  ],
  policies: {
    payment_protocol: 'x402',
    network: 'eip155:8453',
    settlement_asset: 'canonical Base USDC',
    treasury: TREASURY,
  },
  agent_interaction: {
    accepts_booking: false,
    accepts_inquiry: false,
    preferred_contact: 'direct canonical x402 HTTP endpoints',
    response_time: 'on-demand',
  },
  contact: {
    website: ORIGIN,
  },
  metadata: {
    manifest_version: 'owner-2026-09-10-1-5-10',
    languages: ['en'],
  },
};

let initial;
try {
  initial = await readRegistry();
} catch (error) {
  result.listing_status = 'channel_degraded_precheck';
  result.discovery_status = 'unknown';
  result.error = String(error);
  console.log(`SIFR0_RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}

if (containsDelta(initial)) {
  result.listing_status = 'already_listed';
  result.discovery_status = 'present';
  result.duplicate_avoided = true;
  result.readback = initial;
  console.log(`SIFR0_RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}

async function submitOnce() {
  result.submission_attempts += 1;
  try {
    const { response, body } = await requestJson(REGISTER, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest }),
    }, 1);
    result.last_response = { status: response.status, body };
    return { ok: true, status: response.status, body };
  } catch (error) {
    const status = Number(error?.status ?? 0);
    result.last_response = { status, body: error?.body ?? null, error: String(error) };
    return { ok: false, status };
  }
}

let submission = await submitOnce();
await sleep(1500);

let readback = null;
try {
  readback = await readRegistry();
} catch (error) {
  result.readback_error = String(error);
}

// An ambiguous transport/server failure is retried only after an official search
// confirms the first attempt did not create the canonical listing.
if (
  !containsDelta(readback)
  && !submission.ok
  && (submission.status === 0 || submission.status === 408 || submission.status === 429 || submission.status >= 500)
) {
  await sleep(2000);
  submission = await submitOnce();
  await sleep(2000);
  try {
    readback = await readRegistry();
  } catch (error) {
    result.readback_error_2 = String(error);
  }
}

if (containsDelta(readback)) {
  result.listing_status = 'live';
  result.discovery_status = 'present';
  result.registry_id = submission.body?.id ?? null;
  result.readback = readback;
} else if (submission.ok) {
  result.listing_status = 'submitted_readback_pending';
  result.discovery_status = 'pending';
  result.registry_id = submission.body?.id ?? null;
} else if (submission.status >= 400 && submission.status < 500 && submission.status !== 408 && submission.status !== 429) {
  result.listing_status = 'rejected_nonrecoverable';
  result.discovery_status = 'absent';
} else {
  result.listing_status = 'channel_degraded_retry_exhausted';
  result.discovery_status = 'unknown';
}

console.log(`SIFR0_RESULT ${JSON.stringify(result)}`);
