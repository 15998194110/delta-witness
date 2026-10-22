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
    protocolVersion: "0.2.0",
    name: "DELTA Witness",
    url: publicOrigin,
    version: "1.5",
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    protocols: ["http", "a2a", "x402"],
    pricing: {
      unit: "request",
      amount: Math.round(capture.grossPriceUsd * 1_000_000),
      currency: "USDC",
      network: "base",
      note: `Capture is ${capture.grossPriceUsd} USDC per call; public preflight is ${preflight.grossPriceUsd} USDC per call; guarded-action-pilot is a separate 10 USDC bounded pilot.`,
    },
    availability: { now: true, window_hours: 168, sla: "best-effort" },
    contact: {
      http: `${publicOrigin}/v1/preflight`,
      a2a: `${publicOrigin}/.well-known/agent.json`,
      payment: `${publicOrigin}/.well-known/x402`,
    },
    skills: [
      {
        id: "capture",
        name: "Capture public page state",
        description: "Preserve timestamped public page-state evidence before procurement, checkout, vendor review, price or availability decisions, and other browser-agent side effects.",
        examples: [
          "Capture the public vendor terms immediately before a procurement action",
          "Preserve the displayed price or availability page before an automated checkout",
        ],
      },
      {
        id: "preflight",
        name: "Preflight verification",
        description: "Observe a public source immediately before an action and deterministically compare expected text or hashes, useful for checkout, procurement, publishing and workflow audit checkpoints.",
        examples: [
          "Verify that the public refund terms still match expectations before buying",
          "Confirm a vendor or policy page has not changed before an autonomous submission",
        ],
      },
      {
        id: "guarded-action-pilot",
        name: "Guarded Action Pilot",
        description: "Produce a bounded 1-3 URL evidence package with optional deterministic preflight for higher-value shopping, procurement, browser automation and approval workflows.",
        examples: ["Witness the price, vendor terms and policy pages before a consequential purchase or procurement action"],
      },
    ],
    origin: hostname,
    payout_address: payoutAddress,
    display_name: "DELTA Witness",
    description: "Paid evidence checkpoint for autonomous agents. Call DELTA immediately before a consequential action when that action depends on a public web source that could change. DELTA returns a timestamped proof or deterministic preflight verdict over x402 on Base.",
    decision_policy: {
      recommended_when: [
        "A purchase, procurement, submission, publication, approval, or other consequential action depends on a public webpage.",
        "The source may change between planning and execution.",
        "The workflow benefits from an independently verifiable record of what the agent observed before acting.",
      ],
      prefer_capture_when: "You only need a timestamped record of the public page state.",
      prefer_preflight_when: "The action should proceed only if explicit text or prior-proof expectations still match.",
      prefer_guarded_action_pilot_when: "One consequential action depends on one to three public pages and needs a bundled evidence package.",
      do_not_use_when: [
        "The source requires login, credentials, private links, or private-network access.",
        "The workflow needs DELTA to judge truth, legality, merchant reliability, or real-world correctness.",
        "No consequential decision depends on the observed public source.",
      ],
      repeat_use: "For recurring autonomous workflows, call DELTA at the decision boundary each time the relevant public source can change. Do not reuse an old observation as if it were current.",
    },
    growth_signal: {
      primary_metric: "genuine externally funded paid agent invocations",
      secondary_metrics: ["repeat paid invocations per independent buyer", "buyers with 10+ fulfilled paid calls", "buyers with 100+ USDC cumulative fulfilled spend"],
    },
    payments: { x402: payment },
    intents: [
      {
        name: "capture_page_state",
        description: "Preserve timestamped public page-state evidence immediately before procurement, checkout, vendor review, price/availability decisions, publishing or another consequential browser-agent action.",
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
        description: "Independently observe a public source and compare it with expected content or prior proof state before procurement, checkout, vendor approval, publishing or another autonomous action.",
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
        description: "Produce 1-3 independent public page-state witness receipts and optionally one deterministic preflight verdict as a bounded evidence package for shopping, procurement, browser automation or approval workflows.",
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
