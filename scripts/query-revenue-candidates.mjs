import { appendFile } from "node:fs/promises";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const databaseId = process.env.DELTA_D1_DATABASE_ID || "c9431b00-27c5-4609-9f3d-6af20cb162df";

if (!accountId || !token) {
  console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required for the paid-funnel audit.");
  process.exit(2);
}

const sql = `
SELECT
  event,
  channel,
  partner,
  success,
  count(*) AS rows,
  round(sum(gross_usd), 6) AS gross_usd,
  round(sum(variable_cost_usd), 6) AS variable_cost_usd,
  round(sum(contribution_margin_usd), 6) AS contribution_margin_usd,
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

const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sql }),
  },
);

if (!response.ok) {
  console.error(`D1 paid-funnel audit failed (${response.status}): ${await response.text()}`);
  process.exit(1);
}

const payload = await response.json();
const result = payload.result?.[0];
if (!payload.success || !result?.success) {
  console.error(`D1 paid-funnel audit failed: ${JSON.stringify(payload.errors || payload)}`);
  process.exit(1);
}

const rows = result.results || [];
const output = { ok: true, candidate_rows: rows.length, rows };
console.log(JSON.stringify(output));

if (process.env.GITHUB_STEP_SUMMARY) {
  const summary = [
    "### Paid funnel audit",
    "",
    `Candidate rows in the last two hours: **${rows.length}**`,
    "",
    "A candidate is not revenue until settlement and the matching Base USDC transfer to Treasury are independently confirmed.",
    "",
    "```json",
    JSON.stringify(rows, null, 2),
    "```",
    "",
  ].join("\n");
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}
