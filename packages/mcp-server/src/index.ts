#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { x402Client, wrapFetchWithPayment, type PaymentPolicy } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { approvedPaymentUsd, PUBLIC_PAYMENT_USD, type PaidProduct } from "./payment-config.js";

const DEFAULT_BASE_URL = "https://delta-witness-api.ruphussten.workers.dev";
const NETWORK = "eip155:8453";
const TREASURY = "0x1990e21bc219696ff7fbc26527dbaed335ac6367";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

type Json = Record<string, unknown>;

export function buildPreflightBody(input: {
  url: string;
  prior_proof_id?: string;
  html_sha256?: string;
  markdown_sha256?: string;
  contains?: string[];
  excludes?: string[];
  freshness_seconds?: number;
}): Json {
  const expected = {
    html_sha256: input.html_sha256,
    markdown_sha256: input.markdown_sha256,
    contains: input.contains,
    excludes: input.excludes,
  };
  return {
    url: input.url,
    prior_proof_id: input.prior_proof_id,
    freshness_seconds: input.freshness_seconds,
    expected: Object.values(expected).some((value) => value !== undefined) ? expected : undefined,
  };
}

export function deltaPaymentPolicy(product: PaidProduct): PaymentPolicy {
  const rawAmount = String(PUBLIC_PAYMENT_USD[product] * 1_000_000);
  return (_version, requirements) => requirements.filter((requirement) =>
    requirement.network === NETWORK &&
    requirement.scheme === "exact" &&
    requirement.payTo.toLowerCase() === TREASURY &&
    requirement.asset.toLowerCase() === USDC &&
    requirement.amount === rawAmount,
  );
}

function baseUrl(): string {
  const configured = process.env.DELTA_BASE_URL || DEFAULT_BASE_URL;
  const parsed = new URL(configured);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") throw new Error("DELTA_BASE_URL must use HTTPS");
  return configured.replace(/\/+$/, "");
}

async function jsonResponse(response: Response, operation: string): Promise<Json> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${operation} returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    const reason = body && typeof body === "object" && "error" in body ? String((body as Json).error) : "request_failed";
    throw new Error(`${operation} failed: HTTP ${response.status} ${reason}`);
  }
  return body as Json;
}

function paidFetch(product: PaidProduct): typeof fetch {
  // Missing approval is reported explicitly; no hidden legacy fallback or automatic budget increase.
  const maxUsd = approvedPaymentUsd(product, process.env.DELTA_MAX_USD_PER_CALL);
  const privateKey = process.env.EVM_PRIVATE_KEY;
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("Paid DELTA tools require EVM_PRIVATE_KEY in the local MCP process environment");
  }
  const client = new x402Client();
  client.setSpendControls({ maxAmountPerPayment: `$${maxUsd.toFixed(2)}` });
  client.registerPolicy(deltaPaymentPolicy(product));
  registerExactEvmScheme(client, {
    signer: privateKeyToAccount(privateKey as `0x${string}`),
    networks: [NETWORK],
  });
  return wrapFetchWithPayment(fetch, client);
}

function result(body: Json) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
  };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "DELTA Witness", version: "0.7.0" });

  server.registerTool("delta_quote", {
    title: "Quote DELTA observation",
    description: "Get the current owner-authorized price before any payment is signed.",
    inputSchema: { product: z.enum(["capture", "preflight"]).default("capture") },
  }, async ({ product }) => {
    const response = await fetch(`${baseUrl()}/v1/quote?product=${product}`, { headers: { "x-delta-channel": "mcp" } });
    return result(await jsonResponse(response, "DELTA quote"));
  });

  server.registerTool("delta_capture", {
    title: "Capture public source",
    description: "Capture costs 1 USDC. Requires the buyer's explicit DELTA_MAX_USD_PER_CALL approval of at least 1.00; pays exactly 1 USDC via x402. Preserves a public webpage and returns proof metadata and hashes; raw artifacts remain private.",
    inputSchema: { url: z.string().url() },
  }, async ({ url }) => {
    const response = await paidFetch("capture")(`${baseUrl()}/v1/capture`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-delta-channel": "mcp" },
      body: JSON.stringify({ url }),
    });
    return result(await jsonResponse(response, "DELTA capture"));
  });

  server.registerTool("delta_preflight", {
    title: "Public Preflight",
    description: "Public Preflight costs 5 USDC. Requires the buyer's explicit DELTA_MAX_USD_PER_CALL approval of at least 5.00; pays exactly 5 USDC via x402. Compares public-source hashes/text before a consequential action. Safe means expectations matched, not that the source is true. This is not the 10 USDC Guarded-Action Pilot.",
    inputSchema: {
      url: z.string().url(),
      prior_proof_id: z.string().uuid().optional(),
      html_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/i).optional(),
      markdown_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/i).optional(),
      contains: z.array(z.string().min(1).max(200)).max(10).optional(),
      excludes: z.array(z.string().min(1).max(200)).max(10).optional(),
      freshness_seconds: z.number().int().min(0).max(2_592_000).optional(),
    },
  }, async (input) => {
    const response = await paidFetch("preflight")(`${baseUrl()}/v1/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-delta-channel": "mcp" },
      body: JSON.stringify(buildPreflightBody(input)),
    });
    return result(await jsonResponse(response, "DELTA preflight"));
  });

  server.registerTool("delta_verify_proof", {
    title: "Verify DELTA proof",
    description: "Read public proof metadata, hashes, and manifest integrity status without exposing private raw artifacts.",
    inputSchema: { proof_id: z.string().uuid() },
  }, async ({ proof_id }) => {
    const response = await fetch(`${baseUrl()}/v1/proofs/${encodeURIComponent(proof_id)}`, { headers: { "x-delta-channel": "mcp" } });
    return result(await jsonResponse(response, "DELTA proof verification"));
  });

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
