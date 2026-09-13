import { spawnSync } from 'node:child_process';

const DIRECTORY = 'https://nohumans.directory';
const ORIGIN = 'https://delta-witness-api.ruphussten.workers.dev';
const ENDPOINT = `${ORIGIN}/v1/capture`;
const TREASURY = '0x1990e21bc219696ff7fbc26527dbaed335ac6367';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runGate(script) {
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`core pricing gate failed: ${script} exit=${result.status}`);
  }
}

// This is a price-bearing external listing write. Keep the owner policy and
// live 1 / 5 / 10 USDC challenge verification in front of any mutation.
runGate('scripts/check-owner-pricing.mjs');
runGate('scripts/verify-owner-pricing-live.mjs');

const result = {
  channel: 'nohumans_directory',
  listing_status: 'unknown',
  discovery_status: 'unknown',
  duplicate_avoided: false,
  submission_attempts: 0,
  treasury: TREASURY,
  evidence_quality: 'A_official_directory_API',
};

function containsDelta(value) {
  const text = JSON.stringify(value).toLowerCase();
  return text.includes(ENDPOINT.toLowerCase())
    || text.includes('delta witness')
    || (text.includes(ORIGIN.toLowerCase()) && text.includes(TREASURY.toLowerCase()));
}

async function getJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      console.error(JSON.stringify({
        event: 'nohumans_channel_degraded',
        operation: 'read',
        attempt,
        error: String(error),
      }));
      if (attempt < 3) await sleep(800 * attempt);
    }
  }
  throw lastError;
}

async function lookup() {
  // Use two independent queries. If either discovery call is unavailable,
  // fail closed rather than risk creating a duplicate listing.
  const queries = [
    'DELTA Witness',
    'delta-witness-api.ruphussten.workers.dev',
  ];
  const responses = [];
  for (const query of queries) {
    responses.push(await getJson(`${DIRECTORY}/v1/discover?q=${encodeURIComponent(query)}`));
  }
  return responses.filter(containsDelta);
}

async function submitOnce() {
  result.submission_attempts += 1;
  const body = {
    name: 'DELTA Witness Capture',
    description: 'Independent public page-state evidence for consequential agent actions. Keyless x402 on Base; canonical USDC settles directly to the DELTA Treasury.',
    endpoint_url: ENDPOINT,
    category: 'infra.trust',
    price_amount: 1,
    chains: ['base'],
    sample_query: ENDPOINT,
  };

  try {
    const response = await fetch(`${DIRECTORY}/v1/listings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    const text = await response.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch {}
    result.last_response = { status: response.status, body: parsed };
    return { ok: response.ok, status: response.status, body: parsed };
  } catch (error) {
    result.last_response = { transport_error: String(error) };
    return { ok: false, status: 0, body: null };
  }
}

let existing;
try {
  existing = await lookup();
} catch (error) {
  result.listing_status = 'degraded_precheck';
  result.discovery_status = 'degraded';
  result.error = String(error);
  console.log(`NOHUMANS_RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}

if (existing.length) {
  result.listing_status = 'already_listed';
  result.discovery_status = 'present';
  result.duplicate_avoided = true;
  result.matches = existing;
  console.log(`NOHUMANS_RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}

let submission = await submitOnce();
await sleep(1800);
let readback = [];
try {
  readback = await lookup();
} catch (error) {
  result.readback_error = String(error);
}

// Retry only a recoverable transport/server failure, and only after a clean
// dedup readback. Ambiguous success is never blindly repeated.
if (
  !readback.length
  && !submission.ok
  && (submission.status === 0 || submission.status === 429 || submission.status >= 500)
) {
  await sleep(2500);
  submission = await submitOnce();
  await sleep(2000);
  try {
    readback = await lookup();
  } catch (error) {
    result.readback_error_2 = String(error);
  }
}

if (readback.length) {
  result.listing_status = 'live';
  result.discovery_status = 'present';
  result.matches = readback;
} else if (submission.ok) {
  result.listing_status = 'submitted_probe_pending';
  result.discovery_status = 'pending';
} else {
  result.listing_status = 'channel_degraded_or_rejected';
  result.discovery_status = 'unknown';
}

console.log(`NOHUMANS_RESULT ${JSON.stringify(result)}`);
