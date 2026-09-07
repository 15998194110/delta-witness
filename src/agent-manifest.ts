import type { PricingQuote } from "./pricing";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32d4f71b54bdA02913";

export function agentJsonManifest(
  publicOrigin: string,
  payoutAddress: string,
  facilitatorUrl: string,
  capture: PricingQuote,
  preflight: PricingQuote,
): Record<string, unknown> {
  const hostname = new URL(publicOrigin).hostname;
  const payment = {
    networks: [{
      network: "base",
      asset: "USDC",
      contract: BASE_USDC,
      facilitator: facilitatorUrl,
      recipient: payoutAddress,
    }],
  };
  return {
    version: "1.4",
    origin: hostname,
    payout_address: payoutAddress,
    display_name: "DELTA Witness",
    description: "Independent public page-state evidence and deterministic preflight verification for consequential agent actions.",
    payments: { x402: payment },
    intents: [
      {
        name: "capture_page_state",
        description: "Observe a public webpage independently and return timestamped cryptographic proof metadata and hashes.",
        endpoint: "/v1/capture",
        method: "POST",
        parameters: {
          url: { type: "string", required: true, description: "Public HTTP(S) webpage to observe." },
        },
        returns: { type: "object", description: "DELTA proof reference, content hashes, observation metadata, and public verifier URL." },
        price: { amount: capture.grossPriceUsd, currency: "USDC", model: "per_call", network: "base" },
      },
      {
        name: "preflight_verification",
        description: "Independently observe a public source and deterministically compare it with supplied expected content or prior proof state before an agent acts.",
        endpoint: "/v1/preflight",
        method: "POST",
        parameters: {
          url: { type: "string", required: true, description: "Public HTTP(S) source to observe before an action." },
          prior_proof_id: { type: "string", required: false, description: "Optional prior DELTA proof UUID used as a hash baseline." },
          expected: { type: "object", required: false, description: "Optional deterministic contains/excludes or hash expectations." },
        },
        returns: { type: "object", description: "safe/changed/reason/diff plus a new DELTA proof reference and hashes." },
        price: { amount: preflight.grossPriceUsd, currency: "USDC", model: "per_call", network: "base" },
      },
      {
        name: "guarded_action_pilot",
        description: "Produce 1-3 independent public page-state witness receipts and optionally one deterministic preflight verdict as a bounded guarded-action evidence package.",
        endpoint: "/v1/guarded-action-pilot",
        method: "POST",
        parameters: {
          urls: { type: "array", required: true, description: "One to three public HTTPS webpages to witness." },
          preflight: { type: "object", required: false, description: "Optional deterministic preflight rule applied to one submitted URL." },
        },
        returns: { type: "object", description: "Evidence bundle with proof URLs, bundle roots, observation timestamps, and optional preflight verdict." },
        price: { amount: 10, currency: "USDC", model: "flat", network: "base" },
      },
    ],
  };
}
