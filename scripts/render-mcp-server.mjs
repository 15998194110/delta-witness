import fs from "node:fs";
const owner = process.env.GITHUB_REPOSITORY_OWNER;
if (!owner) throw new Error("GITHUB_REPOSITORY_OWNER missing");
const template = fs.readFileSync("distribution/mcp/server.template.json", "utf8");
fs.writeFileSync("server.json", template.replaceAll("__OWNER__", owner));
console.log(`Rendered server.json for ${owner}`);
