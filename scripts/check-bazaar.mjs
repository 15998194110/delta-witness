const origin = "https://facilitator.payai.network";
// PayAI's public discovery contract caps limit at 100. Keep the scan bounded
// and read-only so this check cannot accidentally create catalog state or an
// unbounded client-side request fan-out.
const pageSize = 100;
const concurrency = 8;
const maxPages = 400;
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

async function getPage(offset) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${origin}/discovery/resources?limit=${pageSize}&offset=${offset}`, {
        signal: AbortSignal.timeout(15_000),
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 750 * 2 ** attempt));
    }
  }
  throw new Error(`Bazaar discovery failed at offset ${offset}: ${lastError?.message ?? lastError}`);
}
