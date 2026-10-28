import { Actor } from "apify";

function stableInput(value) {
  if (Array.isArray(value)) return value.map(stableInput);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stableInput(value[key])]));
  return value;
}

function completedDelivery(status, result, product) {
  if (status !== 200 || !result || result.ok !== true || result.product !== product) return false;
  const id = result.proof_id;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return false;
  const origin = 'https://delta-witness-api.ruphussten.workers.dev';
  if (result.public_proof_url !== `${origin}/p/${id}` || result.manifest_url !== `${origin}/v1/proofs/${id}`) return false;
  if (!/^sha256:[0-9a-f]{64}$/i.test(result.bundle_root) || typeof result.observed_at !== 'string' || !Number.isFinite(Date.parse(result.observed_at))) return false;
  return product !== 'preflight' || ([true, false, null].includes(result.safe) && [true, false, null].includes(result.changed));
}

async function gatewayResponse(url, init) {
  const controller = new AbortController();
  let reader;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('gateway_deadline_exceeded'));
      controller.abort();
      void reader?.cancel().catch(() => {});
    }, 120_000);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error('gateway_deadline_exceeded'); }
      reader = response.body?.getReader();
      if (!reader) return response;
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) throw new Error('gateway_deadline_exceeded');
          if (done) break;
          size += value.byteLength;
          if (size > 1_048_576) { void reader.cancel().catch(() => {}); throw new Error('gateway_response_too_large'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return new Response(bytes, { status: response.status, headers: response.headers });
    })()]);
  } finally { clearTimeout(timer); }
}

await Actor.init();
let exitCode = 1;
let failureCode = 'actor_configuration_invalid';
try {
  const input = (await Actor.getInput()) ?? {};
  const url = input.url;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("Input must contain a public http/https url");
  if (input.product !== undefined && !['capture', 'preflight'].includes(input.product)) throw new Error('Unsupported product');
  const product = input.product ?? "preflight";

  const gateway = process.env.DELTA_PARTNER_GATEWAY_URL;
  const secret = process.env.DELTA_PARTNER_SECRET;
  if (!gateway || !secret) throw new Error("Actor is not configured");
  const gatewayUrl = new URL(gateway);
  if (gatewayUrl.protocol !== 'https:' || gatewayUrl.username || gatewayUrl.password || gatewayUrl.search || gatewayUrl.hash) throw new Error('Gateway must be a credential-free HTTPS URL');

  const runId = Actor.getEnv().actorRunId ?? crypto.randomUUID();
  const payload = product === "preflight"
    ? { url, expected: input.expected, prior_proof_id: input.prior_proof_id, external_request_id: runId }
    : { url, external_request_id: runId };
  const requestIdentity = JSON.stringify(stableInput({ product, payload }));
  const chargeKey = `DELTA-PROOF-CHARGE-${runId}`;
  failureCode = 'run_requires_reconciliation';
  const previous = await Actor.getValue(chargeKey);
  if (previous) {
    if (previous.state !== 'complete' || previous.requestIdentity !== requestIdentity || !completedDelivery(200, previous.result, product)) throw new Error('Original run requires charge/delivery reconciliation; do not charge again');
    console.log(JSON.stringify(previous.result, null, 2));
    exitCode = 0;
  } else {
  failureCode = 'pricing_not_authorized';

  if (Actor.isAtHome()) {
    const charging = Actor.getChargingManager();
    const pricing = charging.getPricingInfo();
    const eventPrice = Number(pricing.perEventPrices["proof-created"]);
    const minimumGross = Number(process.env.DELTA_MIN_GROSS_EVENT_USD || "1");
    if (!Number.isFinite(minimumGross) || minimumGross < 1) throw new Error('Configured gross minimum is below the current 1 USD partner price');
    if (!pricing.isPayPerEvent || !Number.isFinite(eventPrice) || eventPrice < minimumGross) {
      throw new Error(`proof-created PPE price must be configured at or above $${minimumGross.toFixed(2)}`);
    }
    if (charging.calculateMaxEventChargeCountWithinLimit("proof-created") < 1) {
      throw new Error("Run spending limit does not authorize one proof-created event");
    }
  }

  failureCode = 'delivery_unconfirmed';
  const response = await gatewayResponse(`${gateway.replace(/\/$/, "")}/${product}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-delta-partner-secret": secret,
      "x-delta-partner-user": process.env.APIFY_USER_ID ?? "apify-user",
      "x-delta-partner-plan": "apify-ppe",
      "idempotency-key": runId
    },
    body: JSON.stringify(payload),
    redirect: 'error',
  });
  const result = await response.json().catch(() => null);
  if (!completedDelivery(response.status, result, product)) {
    throw new Error(`DELTA delivery_unconfirmed HTTP ${response.status}; retain original run/idempotency identity before recovery`);
  }

  // Use the run's existing key-value store, not a new logging service. Publish
  // recoverable metadata before billing; uncertain charge/dataset writes are
  // never repeated on a same-run restart. This is not a multi-writer CAS lock.
  failureCode = 'delivery_storage_unconfirmed';
  await Actor.setValue('OUTPUT', result);
  const record = { product, url, requestIdentity, result };
  failureCode = 'charge_guard_unconfirmed';
  await Actor.setValue(chargeKey, { ...record, state: 'charge_unknown' });
  failureCode = 'charge_outcome_unconfirmed';
  const charge = await Actor.charge({ eventName: "proof-created" });
  if (charge.chargedCount !== 1) throw new Error("Apify spending limit did not authorize the result charge");
  failureCode = 'delivery_storage_unconfirmed';
  await Actor.setValue(chargeKey, { ...record, state: 'delivery_unknown' });
  await Actor.pushData(result);
  await Actor.setValue(chargeKey, { ...record, state: 'complete' });
  console.log(JSON.stringify(result, null, 2));
  exitCode = 0;
  }
} catch {
  // SDK failures may contain token-bearing URLs or response bodies. A fixed
  // phase code preserves uncertainty without publishing the upstream error.
  throw new Error(`${failureCode}; original run requires reconciliation before recovery`);
} finally {
  await Actor.exit({ exitCode });
}
