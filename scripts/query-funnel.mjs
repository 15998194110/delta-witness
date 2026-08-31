const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const databaseId = process.env.DELTA_D1_DATABASE_ID || "c9431b00-27c5-4609-9f3d-6af20cb162df";
const days = Math.min(Math.max(Number(process.argv[2] || 30), 1), 365);

if (!accountId || !token) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID and a D1-read CLOUDFLARE_API_TOKEN, then run: npm run funnel -- 30");
  process.exit(2);
}

const query = `
SELECT
  channel,
  sum(CASE WHEN event = 'page_view' THEN event_count ELSE 0 END) AS page_views,
  sum(CASE WHEN event IN ('qualified_request', 'partner_request') THEN event_count ELSE 0 END) AS qualified_requests,
  sum(CASE WHEN event = 'payment_required' THEN event_count ELSE 0 END) AS payment_402,
  sum(CASE WHEN event IN ('payment_verified', 'partner_request') THEN event_count ELSE 0 END) AS paid,
  sum(CASE WHEN event IN ('capture_completed', 'watch_checked') AND success = 'true' THEN event_count ELSE 0 END) AS delivered,
  sum(CASE WHEN event = 'repeat_call' THEN event_count ELSE 0 END) AS repeat_calls,
  round(sum(CASE WHEN event IN ('capture_completed', 'watch_checked') THEN gross_usd ELSE 0 END), 6) AS gross_revenue_usd,
  round(sum(CASE WHEN event IN ('capture_completed', 'watch_checked') THEN variable_cost_usd ELSE 0 END), 6) AS variable_cost_usd,
  round(sum(CASE WHEN event IN ('capture_completed', 'watch_checked') THEN contribution_margin_usd ELSE 0 END), 6) AS contribution_margin_usd,
  round(sum(CASE WHEN event IN ('capture_completed', 'watch_checked') THEN browser_ms ELSE 0 END), 0) AS browser_ms,
  round(sum(CASE WHEN event IN ('capture_completed', 'watch_checked') THEN storage_bytes ELSE 0 END), 0) AS storage_bytes
FROM telemetry_events
WHERE created_at >= datetime('now', '-${days} days')
GROUP BY channel
ORDER BY contribution_margin_usd DESC`;

const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ sql: query }),
});

if (!response.ok) {
  console.error(`D1 funnel query failed (${response.status}): ${await response.text()}`);
  process.exit(1);
}

const payload = await response.json();
if (!payload.success) {
  console.error(`D1 funnel query failed: ${JSON.stringify(payload.errors || [])}`);
  process.exit(1);
}
console.log(`DELTA channel funnel — last ${days} day(s)`);
console.table(payload.result?.[0]?.results || []);
