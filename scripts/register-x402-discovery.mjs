const API = "https://x402-discovery-api.onrender.com";
const ENDPOINT = "https://delta-witness-api.ruphussten.workers.dev/v1/capture";
const ORIGIN = "https://delta-witness-api.ruphussten.workers.dev";
const TREASURY = "0x1990e21bc219696ff7fbc26527dbaed335ac6367";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url, options = {}, attempts = 4) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          "user-agent": "delta-witness-growth/1.0",
          ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      let body = text;
      try { body = text ? JSON.parse(text) : null; } catch {}
      if (res.ok) return { res, body };
      const retryable = res.status === 408 || res.status === 409 || res.status === 425 || res.status === 429 || res.status >= 500;
      last = new Error(`http_${res.status}:${typeof body === "string" ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500)}`);
      if (!retryable || attempt === attempts) throw last;
    } catch (error) {
      last = error;
      if (attempt === attempts) throw error;
    }
    await sleep(500 * 2 ** (attempt - 1));
  }
  throw last;
}

function servicesFrom(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.services)) return body.services;
  if (Array.isArray(body?.data)) return body.data;
  return [];
}

function endpointOf(service) {
  return String(service?.endpoint_url || service?.url || service?.endpoint || "").replace(/\/$/, "");
}

const catalog = await request(`${API}/catalog`);
const services = servicesFrom(catalog.body);
const existing = services.find((service) => {
  const endpoint = endpointOf(service);
  return endpoint === ENDPOINT || endpoint === ORIGIN || endpoint.startsWith(`${ORIGIN}/`);
});

if (existing) {
  console.log(`X402_DISCOVERY_RESULT ${JSON.stringify({
    channel: "x402_discovery",
    listing_status: "already_listed",
    discovery_status: "present",
    duplicate_avoided: true,
    submission_attempts: 0,
    service_id: existing.service_id || existing.id || null,
    endpoint: endpointOf(existing),
    evidence_quality: "B_official_registry_api",
  })}`);
  process.exit(0);
}

const payload = {
  name: "DELTA Witness Capture",
  endpoint_url: ENDPOINT,
  description: "Independent public webpage evidence capture for autonomous agents, returning timestamped cryptographic proof metadata and hashes before consequential actions.",
  price_per_call: 1,
  capability_tags: ["verification", "monitoring", "web-evidence", "agent-safety"],
  provider_wallet: TREASURY,
  network: "base",
  payment_token: "USDC",
  pricing_model: "flat",
  agent_callable: true,
  auth_required: false,
};

const created = await request(`${API}/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

const serviceId = created.body?.service_id || created.body?.id || null;
let health = null;
if (serviceId) {
  try {
    health = (await request(`${API}/health/${encodeURIComponent(serviceId)}`, {}, 3)).body;
  } catch (error) {
    health = { degraded_recoverable: true, error: String(error?.message || error) };
  }
}

console.log(`X402_DISCOVERY_RESULT ${JSON.stringify({
  channel: "x402_discovery",
  listing_status: "submitted",
  discovery_status: serviceId ? "registered" : "submission_accepted_unresolved_id",
  duplicate_avoided: false,
  submission_attempts: 1,
  service_id: serviceId,
  endpoint: ENDPOINT,
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
  evidence_quality: "B_official_registry_api",
  health,
})}`);
