import { readFile } from "node:fs/promises";

const file = process.argv[2] || "server.json";
const expected = JSON.parse(await readFile(file, "utf8"));
const url = new URL("https://registry.modelcontextprotocol.io/v0.1/servers");
url.searchParams.set("search", expected.name);
const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
if (!response.ok) throw new Error(`MCP Registry lookup failed: HTTP ${response.status}`);
const payload = await response.json();
const match = (payload.servers || []).find((item) =>
  item.server?.name === expected.name && item.server?.version === expected.version &&
  item._meta?.["io.modelcontextprotocol.registry/official"]?.status === "active",
);
if (!match) {
  console.log(`${expected.name}@${expected.version} is not active in the MCP Registry`);
  process.exit(1);
}
console.log(`${expected.name}@${expected.version} is already active in the MCP Registry`);
