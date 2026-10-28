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
    throw new Error(`${operation} failed: HTTP ${response.status}`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`${operation} returned invalid JSON shape`);
  return body as Json;
}

// Bound both headers and body even if an injected/payment transport ignores abort.
// The timer never initiates another request; an unknown paid outcome stays unknown.
async function responseWithinDeadline(fetchImpl: typeof fetch, url: string, init: RequestInit,
  timeoutMs: number, observed: (response: Response) => void): Promise<Response> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("response_deadline_exceeded"));
      controller.abort();
      void reader?.cancel().catch(() => {});
    }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error("response_deadline_exceeded"); }
      observed(response);
      reader = response.body?.getReader();
      if (!reader) return response;
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) throw new Error("response_deadline_exceeded");
          if (done) break;
          size += value.byteLength;
          if (size > 1_048_576) { void reader.cancel().catch(() => {}); throw new Error("response_too_large"); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return new Response(bytes, { status: response.status, headers: response.headers });
    })()]);
  } finally { clearTimeout(timer); }
}

function completedDelivery(body: Json, product: PaidProduct, origin: string): boolean {
  if (body.ok !== true || body.product !== product) return false;
  const id = body.proof_id;
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return false;
  if (body.manifest_url !== `${origin}/v1/proofs/${id}` || body.public_proof_url !== `${origin}/p/${id}`) return false;
  if (typeof body.bundle_root !== "string" || !/^sha256:[0-9a-f]{64}$/i.test(body.bundle_root)) return false;
  if (typeof body.observed_at !== "string" || !Number.isFinite(Date.parse(body.observed_at))) return false;
  return product !== "preflight" || ([true, false, null].includes(body.safe as boolean | null) && [true, false, null].includes(body.changed as boolean | null));
}

function errorResult(error: string, message: string, status: number | null = null) {
  return {
    ...result({ error, message, status, retryable: false,
      classification: status === 401 ? "authentication_required" : status === 403 ? "http_forbidden"
        : status === 429 || (status !== null && status >= 500) ? "http_transient"
          : status === 202 ? "fulfillment_pending" : "unknown",
    }),
    isError: true as const,
  };
}

async function paidResult(product: PaidProduct, body: Json) {
  let fetchPaid: typeof fetch;
  let origin: string;
  let active = true;
  try {
    // Configuration failures happen before any external request or signature.
    fetchPaid = paidFetch(product, () => active);
    origin = baseUrl();
  } catch {
    return errorResult("payment_not_attempted", "No payment was attempted. Check the local explicit buyer approval, signing-key configuration, and DELTA base URL.");
  }
  let status: number | null = null;
  try {
    const response = await responseWithinDeadline(fetchPaid, `${origin}/v1/${product}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-delta-channel": "mcp" },
      body: JSON.stringify(body),
    }, 120_000, (response) => { status = response.status; });
    const delivery = await jsonResponse(response, `DELTA ${product}`);
    if (status !== 200 || !completedDelivery(delivery, product, origin)) throw new Error("Delivery not confirmed");
    return result(delivery);
  } catch {
    // A transport error, partial response, or pending delivery cannot establish
    // whether x402 already authorized/settled. Never call paidFetch again here.
    return errorResult("payment_outcome_unconfirmed", "Delivery and payment outcome are unconfirmed; do not approve another payment. Reconcile the original attempt before recovery.", status);
  } finally { active = false; }
}

async function readResult(path: string, operation: string) {
  let status: number | null = null;
  try {
    const response = await responseWithinDeadline(fetch, `${baseUrl()}${path}`, {
      headers: { "x-delta-channel": "mcp" },
    }, 20_000, (response) => { status = response.status; });
    return result(await jsonResponse(response, operation));
  } catch {
    // Transport errors and provider response bodies can contain secrets. Return
    // only controlled diagnostics; this read never signs or retries a payment.
    return errorResult("read_failed", `${operation} could not be verified. No payment was attempted by this read.`, status);
  }
}

function paidFetch(product: PaidProduct, canSign: () => boolean): typeof fetch {
  // Missing approval is reported explicitly; no hidden legacy fallback or automatic budget increase.
  const maxUsd = approvedPaymentUsd(product, process.env.DELTA_MAX_USD_PER_CALL);
  const privateKey = process.env.EVM_PRIVATE_KEY;
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("Paid DELTA tools require EVM_PRIVATE_KEY in the local MCP process environment");
  }
  const client = new x402Client();
  client.setSpendControls({ maxAmountPerPayment: `$${maxUsd.toFixed(2)}` });
  client.registerPolicy(deltaPaymentPolicy(product));
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  let signatureStarted = false;
  registerExactEvmScheme(client, {
    signer: {
      ...account,
      signTypedData: async (parameters) => {
        if (signatureStarted || !canSign()) throw new Error("original_payment_requires_reconciliation");
        signatureStarted = true;
        return account.signTypedData(parameters as never);
      },
    },
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
  const server = new McpServer({ name: "DELTA Witness", version: "0.7.1" });

  server.registerTool("delta_quote", {
    title: "Quote DELTA observation",
    description: "Get the current owner-authorized price before any payment is signed.",
    inputSchema: { product: z.enum(["capture", "preflight"]).default("capture") },
  }, async ({ product }) => {
    return readResult(`/v1/quote?product=${product}`, "DELTA quote");
  });

  server.registerTool("delta_capture", {
    title: "Capture public source",
    description: "Capture costs 1 USDC. Requires the buyer's explicit DELTA_MAX_USD_PER_CALL approval of at least 1.00; pays exactly 1 USDC via x402. Preserves a public webpage and returns proof metadata and hashes; raw artifacts remain private.",
    inputSchema: { url: z.string().url() },
  }, async ({ url }) => {
    return paidResult("capture", { url });
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
    return paidResult("preflight", buildPreflightBody(input));
  });

  server.registerTool("delta_verify_proof", {
    title: "Verify DELTA proof",
    description: "Read public proof metadata, hashes, and manifest integrity status without exposing private raw artifacts.",
    inputSchema: { proof_id: z.string().uuid() },
  }, async ({ proof_id }) => {
    return readResult(`/v1/proofs/${encodeURIComponent(proof_id)}`, "DELTA proof verification");
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
