import { readFileSync } from "node:fs";

const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const policy = readFileSync(new URL("../docs/pricing-policy-2026-09-10.md", import.meta.url), "utf8");
const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

const expected = {
  CAPTURE_BASE_PRICE_USD: "1",
  PREFLIGHT_BASE_PRICE_USD: "5",
  WATCH_BASE_PRICE_USD: "1",
  PARTNER_PREFLIGHT_BASE_PRICE_USD: "1",
};

const authorityMarkers = [
  "Highest-priority pricing authority — 2026-09-10",
  "**$1.00 USDC — entry layer:** Public Capture.",
  "**$5.00 USDC — standard verification layer:** Public Preflight.",
  "**$10.00 USDC — high-value execution layer:** Guarded-Action Pilot.",
  "Do **not** restore `$0.03` or `$1` Public Preflight",
];
for (const marker of authorityMarkers) {
  if (!agents.includes(marker)) throw new Error(`AGENTS.md pricing authority marker missing: ${marker}`);
}

const policyMarkers = [
  "| Public Capture | **$1.00 USDC** |",
  "| Public Preflight | **$5.00 USDC** |",
  "| Guarded-Action Pilot | **$10.00 USDC** |",
  "The commercial ladder is therefore **$1 → $5 → $10**.",
];
for (const marker of policyMarkers) {
  if (!policy.includes(marker)) throw new Error(`pricing policy marker missing: ${marker}`);
}

for (const [key, value] of Object.entries(expected)) {
  if (config.vars?.[key] !== value) {
    throw new Error(`stale pricing config: ${key}=${config.vars?.[key] ?? "missing"}; owner authority requires ${value}`);
  }
}

console.log(JSON.stringify({ owner_pricing_authority: "ok", ladder_usdc: { capture: 1, preflight: 5, pilot: 10, partner_watch_entry: 1 } }));
