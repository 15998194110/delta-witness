import { queryD1Read, reportAuditFailure, telemetryAccountingScope } from './query-revenue-candidates.mjs';
import { pathToFileURL } from 'node:url';

export async function main() {
const days = Number(process.argv[2] || 30);
if (!Number.isInteger(days) || days < 1 || days > 365) throw Object.assign(new Error('days must be an integer from 1 through 365'), {category: 'invalid_configuration'});

const query = `
SELECT
  channel,
  sum(CASE WHEN event = 'page_view' THEN event_count ELSE 0 END) AS page_views,
  sum(CASE WHEN event IN ('qualified_request', 'partner_request') THEN event_count ELSE 0 END) AS qualified_requests,
  sum(CASE WHEN event = 'payment_required' THEN event_count ELSE 0 END) AS payment_402,
  sum(CASE WHEN event IN ('payment_verified', 'partner_request') AND success = 'true' THEN event_count ELSE 0 END) AS payment_authorization_events,
  sum(CASE WHEN event IN ('capture_completed', 'watch_checked') AND success = 'true' THEN event_count ELSE 0 END) AS delivered,
  sum(CASE WHEN event = 'repeat_call' THEN event_count ELSE 0 END) AS repeat_calls,
  round(sum(CASE WHEN event IN ('capture_completed', 'watch_checked') THEN gross_usd ELSE 0 END), 6) AS telemetry_gross_usd,
  sum(CASE WHEN event IN ('capture_completed', 'capture_failed', 'watch_checked') AND modeled_variable_cost_usd IS NULL THEN 1 ELSE 0 END) AS cost_unknown_events,
  CASE WHEN sum(CASE WHEN event IN ('capture_completed', 'capture_failed', 'watch_checked') AND modeled_variable_cost_usd IS NULL THEN 1 ELSE 0 END) = 0
    THEN round(sum(CASE WHEN event IN ('capture_completed', 'capture_failed', 'watch_checked') THEN modeled_variable_cost_usd END), 6) END AS estimated_variable_cost_usd,
  CASE WHEN sum(CASE WHEN event IN ('capture_completed', 'capture_failed', 'watch_checked') AND modeled_contribution_margin_usd IS NULL THEN 1 ELSE 0 END) = 0
    THEN round(sum(CASE WHEN event IN ('capture_completed', 'capture_failed', 'watch_checked') THEN modeled_contribution_margin_usd END), 6) END AS estimated_contribution_margin_usd,
  CASE WHEN sum(CASE WHEN event IN ('capture_completed', 'capture_failed', 'watch_checked') AND measured_browser_ms IS NULL THEN 1 ELSE 0 END) = 0
    THEN sum(CASE WHEN event IN ('capture_completed', 'capture_failed', 'watch_checked') THEN measured_browser_ms END) END AS browser_ms,
  CASE WHEN sum(CASE WHEN event IN ('capture_completed', 'capture_failed', 'watch_checked') AND measured_storage_bytes IS NULL THEN 1 ELSE 0 END) = 0
    THEN sum(CASE WHEN event IN ('capture_completed', 'capture_failed', 'watch_checked') THEN measured_storage_bytes END) END AS storage_bytes
FROM telemetry_events
WHERE created_at >= datetime('now', '-${days} days')
GROUP BY channel
ORDER BY estimated_contribution_margin_usd DESC`;

const rows = await queryD1Read(query);
console.log(`DELTA channel funnel — last ${days} day(s)`);
console.log(JSON.stringify({ok: true, scan_complete: true, lookback_days: days, all_time_reconciled: false, ...telemetryAccountingScope}));
console.table(rows);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(reportAuditFailure);
}
