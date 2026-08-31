import fs from "node:fs";
const apiKey = process.env.POSTMAN_API_KEY;
let workspace = process.env.POSTMAN_WORKSPACE_ID;
if (!apiKey) throw new Error("POSTMAN_API_KEY missing");
const headers = { "x-api-key": apiKey, "content-type": "application/json" };
if (!workspace) {
  const response = await fetch("https://api.postman.com/workspaces", {
    method: "POST", headers,
    body: JSON.stringify({ workspace: { name: "DELTA Witness", type: "personal", description: "Public API workspace for DELTA Witness", about: "Pay-per-capture web proofs for humans and AI agents." } })
  });
  if (!response.ok) throw new Error(`Postman workspace create failed ${response.status}: ${await response.text()}`);
  workspace = (await response.json()).workspace.id;
  console.log(`POSTMAN_WORKSPACE_ID=${workspace}`);
}
const collection = JSON.parse(fs.readFileSync("distribution/postman/DELTA-Witness.postman_collection.json", "utf8"));
const response = await fetch(`https://api.postman.com/collections?workspace=${encodeURIComponent(workspace)}`, {
  method: "POST", headers, body: JSON.stringify({ collection })
});
if (!response.ok) throw new Error(`Postman collection create failed ${response.status}: ${await response.text()}`);
console.log(await response.text());
