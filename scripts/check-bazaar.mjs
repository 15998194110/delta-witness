const origin = "https://facilitator.payai.network";
// PayAI's public discovery contract caps limit at 100. Keep the scan bounded
// and read-only so this check cannot accidentally create catalog state or an
// unbounded client-side request fan-out.
const pageSize = 100;
const concurrency = 4;
const maxPages = 400;
const requestTimeoutMs = 30_000;
const attempts = 5;
const requestedPages = Number(process.env.BAZAAR_MAX_PAGES ?? maxPages);
if (!Number.isInteger(requestedPages) || requestedPages < 1 || requestedPages > maxPages) {
  throw new Error(`BAZAAR_MAX_PAGES must be an integer from 1 to ${maxPages}`);
}
const first = await getPage(0);
const total = Number(first.pagination?.total ?? first.total ?? first.items?.length ?? 0);
const offsets = [];
for (let offset = pageSize; offset < total; offset += pageSize) offsets.push(offset);
if (offsets.length + 1 > maxPages) {
  throw new Error(`Bazaar discovery returned ${total} resources; refusing to scan more than ${maxPages} pages`);
}
const scanOffsets = offsets.slice(0, Math.max(0, requestedPages - 1));
const pages = [first];
for (let index = 0; index < scanOffsets.length; index += concurrency) {
  pages.push(...await Promise.all(scanOffsets.slice(index, index + concurrency).map(getPage)));
  if ((index + concurrency) % 40 === 0) {
    console.error(`Bazaar scan progress: ${Math.min(index + concurrency + 1, scanOffsets.length + 1)}/${scanOffsets.length + 1} pages`);
  }
}

const items = pages.flatMap((page) => page.items ?? page.resources ?? []);
const matches = items.filter((item) => JSON.stringify(item).toLowerCase().includes("delta-witness"));
console.log(JSON.stringify({
  checked_at: new Date().toISOString(),
  total,
  scanned: items.length,
  scan_complete: pages.length >= Math.ceil(total / pageSize),
  matches,
}, null, 2));

// Keep cumulative, externally measured x402 settlement telemetry beside the
// rolling Treasury check. This is only an anomaly trigger: Base Treasury plus
// DELTA proof/telemetry remains authoritative for customer-revenue recognition.
const radarUrl = "https://api.402radar.io/v1/radar/services/delta-witness-api.ruphussten.workers.dev";
let radar = { discovery_status: "degraded_recoverable" };
try {
  const response = await fetchWithRetry(radarUrl, { headers: { accept: "application/json" } });
  if (response.status === 200) {
    const body = await response.json();
    const service = body?.service ?? body;
    const txCount = Number(service?.onchainTxCount ?? 0);
    const volumeUsdc = Number(service?.onchainVolumeUsdc ?? 0);
    radar = {
      discovery_status: "present",
      listing_status: service?.reviewStatus === "approved" && service?.active ? "approved_active" : service?.reviewStatus ?? "present",
      onchain_tx_count: txCount,
      onchain_volume_usdc: volumeUsdc,
      onchain_last_paid_at: service?.onchainLastPaidAt ?? null,
      pay_to: service?.payTo ?? null,
      score: body?.metrics?.find?.((m) => m.window === "24h")?.score ?? null,
      cumulative_baseline_known_non_customer_tx_count: 2,
      cumulative_baseline_known_non_customer_usdc: 0.06,
      requires_deep_treasury_audit: txCount > 2 || volumeUsdc > 0.06,
      evidence_quality: "A_external_onchain_index_plus_internal_treasury_reconciliation",
    };
  } else if (response.status === 404) {
    radar = { discovery_status: "absent", listing_status: "absent", evidence_quality: "A_official_api" };
  } else {
    radar = { discovery_status: "degraded_recoverable", http_status: response.status };
  }
} catch (error) {
  radar = { discovery_status: "degraded_recoverable", error: String(error) };
}
console.log(`COMMERCIAL_SIGNAL_402RADAR ${JSON.stringify(radar)}`);

// Agent Bazaar submissions are no-account review-queue writes. Never submit
// again here; only detect when the already-submitted DELTA Capture becomes
// publicly discoverable so the operator can treat that as a completed listing.
let agentBazaar = { discovery_status: "degraded_recoverable" };
try {
  const response = await fetchWithRetry("https://www.agent-bazaar.com/marketplace", { headers: { accept: "text/html" } });
  if (response.ok) {
    const html = await response.text();
    const present = /DELTA Witness Capture|delta-witness-api\.ruphussten\.workers\.dev\/v1\/capture/i.test(html);
    agentBazaar = {
      listing_status: present ? "public_live" : "review_pending_or_not_public",
      discovery_status: present ? "present" : "not_public",
      duplicate_submission_allowed: false,
      evidence_quality: "B_current_public_marketplace_readback",
    };
  } else {
    agentBazaar = { discovery_status: "degraded_recoverable", http_status: response.status };
  }
} catch (error) {
  agentBazaar = { discovery_status: "degraded_recoverable", error: String(error) };
}
console.log(`COMMERCIAL_SIGNAL_AGENT_BAZAAR ${JSON.stringify(agentBazaar)}`);

async function getPage(offset) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${origin}/discovery/resources?limit=${pageSize}&offset=${offset}`, {
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, Math.min(6_000, 750 * 2 ** attempt)));
    }
  }
  throw new Error(`Bazaar discovery failed at offset ${offset}: ${lastError?.message ?? lastError}`);
}

async function fetchWithRetry(url, init = {}) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status >= 500 || response.status === 429) {
        lastError = new Error(`HTTP ${response.status}`);
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, 600 * 2 ** attempt)));
          continue;
        }
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, 600 * 2 ** attempt)));
    }
  }
  throw lastError ?? new Error(`request failed: ${url}`);
}
