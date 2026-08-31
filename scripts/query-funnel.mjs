const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const dataset = process.env.DELTA_ANALYTICS_DATASET || "delta_witness_events";
const days = Math.min(Math.max(Number(process.argv[2] || 30), 1), 365);

if (!accountId || !token) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID and a read-only CLOUDFLARE_API_TOKEN, then run: npm run funnel -- 30");
  process.exit(2);
}

const query = `
SELECT
  blob4 AS channel,
  sum(if(blob2 = 'page_view', double1, 0)) AS page_views,
  sum(if(blob2 IN ('qualified_request', 'partner_request'), double1, 0)) AS qualified_requests,
  sum(if(blob2 = 'payment_required', double1, 0)) AS payment_402,
  sum(if(blob2 IN ('payment_verified', 'partner_request'), double1, 0)) AS paid,
  sum(if(blob2 IN ('capture_completed', 'watch_checked') AND blob6 = 'true', double1, 0)) AS delivered,
  sum(if(blob2 = 'repeat_call', double1, 0)) AS repeat_calls,
  round(sum(if(blob2 IN ('capture_completed', 'watch_checked'), double2, 0)), 6) AS gross_revenue_usd,
  round(sum(if(blob2 IN ('capture_completed', 'watch_checked'), double5, 0)), 6) AS variable_cost_usd,
  round(sum(if(blob2 IN ('capture_completed', 'watch_checked'), double6, 0)), 6) AS contribution_margin_usd,
  round(sum(if(blob2 IN ('capture_completed', 'watch_checked'), double3, 0)), 0) AS browser_ms,
  round(sum(if(blob2 IN ('capture_completed', 'watch_checked'), double4, 0)), 0) AS storage_bytes
FROM ${dataset}
WHERE timestamp >= NOW() - INTERVAL '${days}' DAY
GROUP BY channel
ORDER BY contribution_margin_usd DESC
FORMAT JSON`;

const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
  body: query,
});

if (!response.ok) {
  console.error(`Analytics Engine query failed (${response.status}): ${await response.text()}`);
  process.exit(1);
}

const payload = await response.json();
console.log(`DELTA channel funnel — last ${days} day(s)`);
console.table(payload.data || []);
