import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ORIGIN = 'https://delta-witness-api.ruphussten.workers.dev';
const HOST = 'delta-witness-api.ruphussten.workers.dev';
const TREASURY = '0x1990e21bc219696ff7fbc26527dbaed335ac6367';
const INDEX = 'https://agent402.tools/api/index';
const REGISTER = 'https://agent402.tools/api/index/register';
const POW_CHALLENGE = 'https://agent402.tools/api/pow/challenge?slug=seller-trust';
const SELLER_TRUST = `https://agent402.tools/api/x402/seller-trust?origin=${encodeURIComponent(HOST)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runGate(script) {
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`core pricing gate failed: ${script} exit=${result.status}`);
  }
}

// Any external listing write is guarded by the repository pricing policy and live 402 probes.
runGate('scripts/check-owner-pricing.mjs');
runGate('scripts/verify-owner-pricing-live.mjs');

const result = {
  channel: 'agent402',
  listing_status: 'unknown',
  discovery_status: 'unknown',
  buyer_count: null,
  settlement_count: null,
  verified_neighbor_demand: true,
  external_requests: 0,
  intents_402: 0,
  paid_settlements: 0,
  treasury_received: 0,
  revenue: 0,
  variable_cost: 0,
  contribution_margin: 0,
  evidence_quality: 'A_official_api_plus_public_settlement_ledger',
  duplicate_avoided: false,
  submission_attempts: 0,
};

function containsDelta(value) {
  const text = JSON.stringify(value ?? '').toLowerCase();
  return text.includes(ORIGIN.toLowerCase())
    || text.includes('delta witness')
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
        event: 'agent402_channel_degraded',
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

function leadingZeroBits(buffer) {
  let total = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      total += 8;
      continue;
    }
    total += Math.clz32(byte) - 24;
    break;
  }
  return total;
}

async function readSellerTrustFree() {
  try {
    const { body: challenge } = await requestJson(POW_CHALLENGE, {
      headers: { accept: 'application/json' },
    }, 2);
    const puzzle = challenge?.challenge;
    const token = challenge?.token;
    const difficulty = Number(challenge?.difficulty);
    if (!puzzle || !token || !Number.isFinite(difficulty)) {
      throw new Error('seller-trust PoW challenge shape changed');
    }

    let nonce = 0;
    for (;; nonce += 1) {
      const digest = createHash('sha256').update(`${puzzle}:${nonce}`).digest();
      if (leadingZeroBits(digest) >= difficulty) break;
      if (nonce > 50_000_000) throw new Error('seller-trust PoW safety cap exceeded');
    }

    const { body } = await requestJson(SELLER_TRUST, {
      headers: {
        accept: 'application/json',
        'X-Pow-Solution': `${token}:${nonce}`,
      },
    }, 1);
    return body;
  } catch (error) {
    console.error(JSON.stringify({
      event: 'agent402_seller_trust_degraded',
      error: String(error),
    }));
    return null;
  }
}

async function readIndex() {
  const { body } = await requestJson(INDEX, {}, 3);
  return body;
}

async function submitOnce() {
  result.submission_attempts += 1;
  try {
    const { response, body } = await requestJson(REGISTER, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origin: ORIGIN }),
    }, 1);
    result.last_response = { status: response.status, body };
    return { ok: true, status: response.status };
  } catch (error) {
    const status = Number(error?.status ?? 0);
    result.last_response = { status, body: error?.body ?? null, error: String(error) };
    return { ok: false, status };
  }
}

let initial;
try {
  initial = await readIndex();
} catch (error) {
  result.listing_status = 'degraded_precheck';
  result.discovery_status = 'degraded';
  result.error = String(error);
  console.log(`AGENT402_RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}

if (containsDelta(initial)) {
  result.listing_status = 'already_listed';
  result.discovery_status = 'present';
  result.duplicate_avoided = true;
  console.log(`AGENT402_RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}

// Agent402's public /api/index can lag or omit a freshly accepted seller even while
// the authoritative seller-trust surface already says listed=true. Resolve that
// discrepancy with the documented free proof-of-work tier before attempting a
// registration write, so the hourly pulse cannot spam duplicate POSTs.
const sellerTrustBeforeWrite = await readSellerTrustFree();
if (sellerTrustBeforeWrite?.listed === true) {
  result.listing_status = 'already_listed_trust_confirmed';
  result.discovery_status = 'listed_index_lag';
  result.duplicate_avoided = true;
  result.seller_trust = {
    listed: true,
    manifestParsed: sellerTrustBeforeWrite.manifestParsed ?? null,
    healthScore: sellerTrustBeforeWrite.healthScore ?? null,
    toolCount: sellerTrustBeforeWrite.toolCount ?? null,
    paidToolCount: sellerTrustBeforeWrite.paidToolCount ?? null,
    priceRangeUsd: sellerTrustBeforeWrite.priceRangeUsd ?? null,
    routableByOurRouter: sellerTrustBeforeWrite.routableByOurRouter ?? null,
    blockers: sellerTrustBeforeWrite.blockers ?? null,
  };
  console.log(`AGENT402_RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}

let submission = await submitOnce();
await sleep(2500);

let readback = null;
try {
  readback = await readIndex();
} catch (error) {
  result.readback_error = String(error);
}

// Retry only on recoverable transport/server/rate failures, and only after a readback
// shows that the ambiguous first attempt did not already create the canonical listing.
if (
  !containsDelta(readback)
  && !submission.ok
  && (submission.status === 0 || submission.status === 408 || submission.status === 429 || submission.status >= 500)
) {
  await sleep(2500);
  submission = await submitOnce();
  await sleep(3000);
  try {
    readback = await readIndex();
  } catch (error) {
    result.readback_error_2 = String(error);
  }
}

if (containsDelta(readback)) {
  result.listing_status = 'live';
  result.discovery_status = 'present';
} else if (submission.ok) {
  const sellerTrustAfterWrite = await readSellerTrustFree();
  if (sellerTrustAfterWrite?.listed === true) {
    result.listing_status = 'live_trust_confirmed';
    result.discovery_status = 'listed_index_lag';
    result.seller_trust = {
      listed: true,
      manifestParsed: sellerTrustAfterWrite.manifestParsed ?? null,
      healthScore: sellerTrustAfterWrite.healthScore ?? null,
      toolCount: sellerTrustAfterWrite.toolCount ?? null,
      paidToolCount: sellerTrustAfterWrite.paidToolCount ?? null,
      priceRangeUsd: sellerTrustAfterWrite.priceRangeUsd ?? null,
      routableByOurRouter: sellerTrustAfterWrite.routableByOurRouter ?? null,
      blockers: sellerTrustAfterWrite.blockers ?? null,
    };
  } else {
    result.listing_status = 'submitted_crawl_pending';
    result.discovery_status = 'pending';
  }
} else if (submission.status >= 400 && submission.status < 500 && submission.status !== 408 && submission.status !== 429) {
  result.listing_status = 'rejected_nonrecoverable';
  result.discovery_status = 'absent';
} else {
  result.listing_status = 'channel_degraded_retry_exhausted';
  result.discovery_status = 'unknown';
}

console.log(`AGENT402_RESULT ${JSON.stringify(result)}`);
