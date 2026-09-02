import { readFile } from "node:fs/promises";

const file = process.argv[2] || "server.json";
const expected = JSON.parse(await readFile(file, "utf8"));
const url = new URL("https://registry.modelcontextprotocol.io/v0.1/servers");
url.searchParams.set("search", expected.name);
let payload;
let lastError;
for (let attempt = 1; attempt <= 4; attempt += 1) {
  try {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = await response.json();
    break;
  } catch (error) {
    lastError = error;
    console.error(`MCP Registry lookup attempt ${attempt}/4 failed: ${error instanceof Error ? error.message : String(error)}`);
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
  }
}
if (!payload) throw new Error(`MCP Registry lookup failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
const match = (payload.servers || []).find((item) =>
  item.server?.name === expected.name && item.server?.version === expected.version &&
  item._meta?.["io.modelcontextprotocol.registry/official"]?.status === "active",
);
if (!match) {
  console.log(`${expected.name}@${expected.version} is not active in the MCP Registry`);
  process.exit(1);
}
console.log(`${expected.name}@${expected.version} is already active in the MCP Registry`);
