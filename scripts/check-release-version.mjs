import fs from "node:fs";

const root = JSON.parse(fs.readFileSync("package.json", "utf8"));
const expected = root.version;
const jsonPackages = [
  "channels/partner-gateway/package.json",
  "channels/apify/package.json",
  "channels/base-app/package.json",
  "packages/js-client/package.json",
  "packages/mcp-server/package.json",
];
for (const file of jsonPackages) {
  const version = JSON.parse(fs.readFileSync(file, "utf8")).version;
  if (version !== expected) throw new Error(`${file} is ${version}; expected ${expected}`);
}
const pyproject = fs.readFileSync("packages/python-client/pyproject.toml", "utf8");
if (!pyproject.includes(`version = "${expected}"`)) throw new Error("Python package version drift");
const registry = fs.readFileSync("distribution/mcp/server.template.json", "utf8");
if (!registry.includes(`"version": "${expected}"`)) throw new Error("MCP registry version drift");
const tag = process.env.GITHUB_REF_NAME;
if (tag?.startsWith("v") && tag.slice(1) !== expected) throw new Error(`Tag ${tag} does not match ${expected}`);
console.log(`All release surfaces agree on ${expected}`);
