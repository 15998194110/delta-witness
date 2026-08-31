import { Actor } from "apify";

await Actor.init();
try {
  const input = (await Actor.getInput()) ?? {};
  const url = input.url;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("Input must contain a public http/https url");
  const product = input.product === "preflight" ? "preflight" : "capture";

  const gateway = process.env.DELTA_PARTNER_GATEWAY_URL;
  const secret = process.env.DELTA_PARTNER_SECRET;
  if (!gateway || !secret) throw new Error("Actor is not configured");

  if (Actor.isAtHome()) {
    const charging = Actor.getChargingManager();
    const pricing = charging.getPricingInfo();
    const eventPrice = Number(pricing.perEventPrices["proof-created"]);
    const minimumGross = Number(process.env.DELTA_MIN_GROSS_EVENT_USD || "0.04");
    if (!pricing.isPayPerEvent || !Number.isFinite(eventPrice) || eventPrice < minimumGross) {
      throw new Error(`proof-created PPE price must be configured at or above $${minimumGross.toFixed(2)}`);
    }
    if (charging.calculateMaxEventChargeCountWithinLimit("proof-created") < 1) {
      throw new Error("Run spending limit does not authorize one proof-created event");
    }
  }

  const runId = Actor.getEnv().actorRunId ?? crypto.randomUUID();
  const payload = product === "preflight"
    ? { url, expected: input.expected, prior_proof_id: input.prior_proof_id, external_request_id: runId }
    : { url, external_request_id: runId };
  const response = await fetch(`${gateway.replace(/\/$/, "")}/${product}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-delta-partner-secret": secret,
      "x-delta-partner-user": process.env.APIFY_USER_ID ?? "apify-user",
      "x-delta-partner-plan": "apify-ppe",
      "idempotency-key": runId
    },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`DELTA gateway error ${response.status}: ${JSON.stringify(result)}`);

  const charge = await Actor.charge({ eventName: "proof-created" });
  if (charge.chargedCount !== 1) throw new Error("Apify spending limit did not authorize the result charge");
  await Actor.pushData(result);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await Actor.exit();
}
