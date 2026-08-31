import fs from "node:fs";
const apiKey = process.env.POSTMAN_API_KEY;
let workspace = process.env.POSTMAN_WORKSPACE_ID;
const collectionId = process.env.POSTMAN_COLLECTION_ID;
if (!apiKey) throw new Error("POSTMAN_API_KEY missing");
const headers = { "x-api-key": apiKey, "content-type": "application/json" };
if (!workspace) {
  const response = await fetch("https://api.postman.com/workspaces", {
    method: "POST", headers,
    body: JSON.stringify({ workspace: { name: "DELTA Witness", type: "public", description: "Public API workspace for DELTA Witness", about: "Capture and Guard for public sources before autonomous actions." } })
  });
  if (!response.ok) throw new Error(`Postman workspace create failed ${response.status}: ${await response.text()}`);
  workspace = (await response.json()).workspace.id;
  console.log(`POSTMAN_WORKSPACE_ID=${workspace}`);
}
const collection = JSON.parse(fs.readFileSync("distribution/postman/DELTA-Witness.postman_collection.json", "utf8"));
const endpoint = collectionId
  ? `https://api.postman.com/collections/${encodeURIComponent(collectionId)}`
  : `https://api.postman.com/collections?workspace=${encodeURIComponent(workspace)}`;
const response = await fetch(endpoint, {
  method: collectionId ? "PUT" : "POST", headers, body: JSON.stringify({ collection })
});
if (!response.ok) throw new Error(`Postman collection sync failed ${response.status}: ${await response.text()}`);
const result = await response.json();
if (!collectionId) console.log(`POSTMAN_COLLECTION_ID=${result.collection?.id ?? result.collection?.uid}`);
console.log(JSON.stringify(result));
