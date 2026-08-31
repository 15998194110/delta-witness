import test from "node:test";
import assert from "node:assert/strict";
import { DeltaWitness } from "../src/index.js";

test("preflight challenge targets Guard with attribution", async () => {
  let request;
  const client = new DeltaWitness({ fetchImpl: async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ error: "payment_required" }), { status: 402, headers: { "content-type": "application/json" } });
  } });
  const challenge = await client.preflightChallenge({ url: "https://example.com", expected: { contains: ["Example"] } });
  assert.equal(challenge.status, 402);
  assert.equal(request.url, "https://delta-witness-api.ruphussten.workers.dev/v1/preflight");
  assert.equal(request.init.headers["x-delta-channel"], "npm");
});
