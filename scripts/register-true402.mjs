import { spawnSync } from 'node:child_process';

const REGISTRY = 'https://true402.dev/api/v1/services';
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

// Price-bearing external writes are allowed only after both canonical gates pass.
runGate('scripts/check-owner-pricing.mjs');
runGate('scripts/verify-owner-pricing-live.mjs');

const result = {
  channel: 'true402',
  listing_status: 'unknown',
  discovery_status: 'unknown',
  duplicate_avoided: false,
  submission_attempts: 0,
  evidence_quality: 'A_official_registry_API',
};

function rows(json) {
  if (Array.isArray(json)) return json;
  for (const key of ['services', 'data', 'items', 'results']) {
    if (Array.isArray(json?.[key])) return json[key];
  }
  return [];
}

function isDelta(row) {
  const text = JSON.stringify(row).toLowerCase();
  return text.includes('delta witness')
    || text.includes('delta-witness-api.ruphussten.workers.dev')
    || text.includes(TREASURY.toLowerCase());
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
        event: 'true402_channel_degraded',
        operation: 'read',
        attempt,
        error: String(error),
      }));
      if (attempt < 3) await sleep(700 * attempt);
    }
  }
  throw lastError;
}

async function scanRegistry() {
  const found = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const json = await getJson(`${REGISTRY}?limit=100&offset=${offset}`);
    const page = rows(json);
    found.push(...page.filter(isDelta));

    const total = Number(json?.total ?? json?.count ?? NaN);
    const hasMore = json?.has_more ?? json?.hasMore;
    if (hasMore === false) break;
    if (Number.isFinite(total) && offset + page.length >= total) break;
    if (page.length < 100) break;
  }
  return found;
}

async function submitOnce() {
  result.submission_attempts += 1;
  const body = {
    url: ORIGIN,
    manifest: {
      x402: '1.0',
      name: 'DELTA Witness Capture',
      description: 'Independent public page-state evidence for consequential agent actions. Base USDC settles directly to DELTA Treasury.',
      capabilities: ['evidence', 'verification', 'agent-safety', 'x402', 'capture'],
      pricing: { currency: 'USDC', base: '1.00', unit: 'request' },
      payment: {
        address: TREASURY,
        chain: 'base',
        facilitator: 'https://facilitator.payai.network',
      },
      endpoint: ENDPOINT,
    },
  };

  try {
    const response = await fetch(REGISTRY, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    const text = await response.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch {}
    result.last_response = { status: response.status, body: parsed };
    return { ok: response.ok, status: response.status };
  } catch (error) {
    result.last_response = { transport_error: String(error) };
    return { ok: false, status: 0 };
  }
}

let existing;
try {
  existing = await scanRegistry();
} catch (error) {
  result.listing_status = 'degraded_precheck';
  result.discovery_status = 'degraded';
  result.error = String(error);
  console.log(`TRUE402_RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}

if (existing.length) {
  result.listing_status = 'already_listed';
  result.discovery_status = 'present';
  result.duplicate_avoided = true;
  result.matches = existing;
  console.log(`TRUE402_RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}

let submission = await submitOnce();
await sleep(1500);
let readback = [];
try {
  readback = await scanRegistry();
} catch (error) {
  result.readback_error = String(error);
}

// POST retries are guarded by a registry readback so an ambiguous network error
// cannot create a duplicate listing. Only recoverable channel failures qualify.
if (
  !readback.length
  && !submission.ok
  && (submission.status === 0 || submission.status === 429 || submission.status >= 500)
) {
  await sleep(2500);
  submission = await submitOnce();
  await sleep(2000);
  try {
    readback = await scanRegistry();
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
  result.listing_status = 'channel_degraded_retry_exhausted';
  result.discovery_status = 'unknown';
}

console.log(`TRUE402_RESULT ${JSON.stringify(result)}`);
