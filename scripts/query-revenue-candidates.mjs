import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { fetchTextBounded } from './bounded-http.mjs';

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const databaseId = process.env.DELTA_D1_DATABASE_ID || "c9431b00-27c5-4609-9f3d-6af20cb162df";

function auditFailure(category, message, retryable = false) {
  return Object.assign(new Error(message), {category, retryable});
}

// This helper only accepts SELECT statements. Retry is limited to known
// transient failures of this read; no writes or unknown writes are replayed.
export async function queryD1Read(sql) {
  if (!accountId || !token) throw auditFailure("missing_configuration", "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
  if (!/^\s*SELECT\b/i.test(sql) || sql.includes(";")) throw auditFailure("invalid_configuration", "Expected one SELECT statement");
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { response, text } = await fetchTextBounded(fetch, `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
        method: "POST", headers: {authorization: `Bearer ${token}`, "content-type": "application/json"},
        body: JSON.stringify({sql}), redirect: 'error',
      });
      if (!response.ok) {
        const status = response.status;
        throw auditFailure(status === 401 ? "authentication_required" : status === 403 ? "http_forbidden" : status === 429 ? "rate_limited" : status >= 500 ? "server_error" : "http_rejected", `D1 HTTP ${status}`, status === 429 || status >= 500);
      }
      let payload;
      try { payload = JSON.parse(text); } catch { throw auditFailure("malformed_response", "D1 response is not JSON"); }
      if (payload?.success === false) throw auditFailure("provider_rejected", "D1 query rejected; provider cause not independently established");
      if (payload?.success !== true) throw auditFailure("malformed_response", "D1 response is missing a success flag");
      const result = payload.result?.[0];
      if (result?.success === false) throw auditFailure("provider_rejected", "D1 statement rejected; provider cause not independently established");
      if (!Array.isArray(payload.result) || payload.result.length !== 1 || result?.success !== true || !Array.isArray(result.results) || result.results.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
        throw auditFailure("malformed_response", "D1 statement unsuccessful or result rows missing/invalid");
      }
      return result.results;
    } catch (error) {
      const classified = error.category ? error : error.name === "TimeoutError" || error.name === "AbortError"
        ? auditFailure("timeout", "D1 request timed out", true)
        : error instanceof TypeError && error.message === "fetch failed"
          ? auditFailure("network_failure", "D1 transport failed", true)
          : auditFailure("unknown", "D1 request failed; cause unknown");
      if (!classified.retryable || attempt === 2) throw classified;
      console.error(JSON.stringify({event: "d1_read_degraded", category: classified.category, attempt}));
      await new Promise(resolve => setTimeout(resolve, 700));
    }
  }
}

export const telemetryAccountingScope = {
  accounting_scope: "Telemetry aggregates are not purchases, settlement, receipts or revenue. V2 nullable metrics distinguish measurements from models; legacy/missing values remain unknown. Actual invoice costs, refunds and independent purpose require the original-order accounting view. Migration 0002 is required; no legacy zero fallback.",
  recognized_customer_revenue_usdc: null,
  actual_variable_cost_usdc: null,
  actual_contribution_margin_usdc: null,
};

export function reportAuditFailure(error) {
  console.error(JSON.stringify({ok: false, scan_complete: false, candidate_rows: null, category: error.category || "unknown", error: error.category ? error.message : "Audit failed; cause unknown"}));
  process.exitCode = error.category === "missing_configuration" ? 2 : 1;
}

async function main() {
const sql = `
SELECT
  event,
  channel,
  partner,
  success,
  count(*) AS rows,
  round(sum(gross_usd), 6) AS telemetry_gross_usd,
  sum(CASE WHEN modeled_variable_cost_usd IS NULL THEN 1 ELSE 0 END) AS cost_unknown_events,
  CASE WHEN count(modeled_variable_cost_usd) = count(*) THEN round(sum(modeled_variable_cost_usd), 6) END AS estimated_variable_cost_usd,
  CASE WHEN count(modeled_contribution_margin_usd) = count(*) THEN round(sum(modeled_contribution_margin_usd), 6) END AS estimated_contribution_margin_usd,
  max(created_at) AS latest
FROM telemetry_events
WHERE created_at >= datetime('now', '-2 hours')
  AND event IN (
    'payment_verified',
    'partner_request',
    'capture_started',
    'capture_completed',
    'capture_failed',
    'watch_checked'
  )
GROUP BY event, channel, partner, success
ORDER BY latest DESC`;

const rows = await queryD1Read(sql);
const output = { ok: true, scan_complete: true, lookback_hours: 2, all_time_reconciled: false, ...telemetryAccountingScope, candidate_rows: rows.length, rows };
console.log(JSON.stringify(output));

if (process.env.GITHUB_STEP_SUMMARY) {
  const summary = [
    "### Paid funnel audit",
    "",
    `Candidate rows in the last two hours: **${rows.length}**`,
    "",
    "A candidate is not revenue until settlement and the matching Base USDC transfer to Treasury are independently confirmed.",
    telemetryAccountingScope.accounting_scope,
    "",
    "```json",
    JSON.stringify(rows, null, 2),
    "```",
    "",
  ].join("\n");
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(reportAuditFailure);
}
