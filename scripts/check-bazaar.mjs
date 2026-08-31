const origin = "https://facilitator.payai.network";
const pageSize = 1000;
const first = await getPage(0);
const total = Number(first.pagination?.total ?? first.total ?? first.items?.length ?? 0);
const offsets = [];
for (let offset = pageSize; offset < total; offset += pageSize) offsets.push(offset);
const pages = [first];
for (let index = 0; index < offsets.length; index += 4) {
  pages.push(...await Promise.all(offsets.slice(index, index + 4).map(getPage)));
}

const items = pages.flatMap((page) => page.items ?? page.resources ?? []);
const matches = items.filter((item) => JSON.stringify(item).toLowerCase().includes("delta-witness"));
console.log(JSON.stringify({ checked_at: new Date().toISOString(), total, scanned: items.length, matches }, null, 2));

async function getPage(offset) {
  const response = await fetch(`${origin}/discovery/resources?limit=${pageSize}&offset=${offset}`);
  if (!response.ok) throw new Error(`Bazaar discovery failed at offset ${offset}: HTTP ${response.status}`);
  return response.json();
}
