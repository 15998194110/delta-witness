import type { RuntimeEnv } from "./env";
import { sha256, stableJson, uuidFromDigest } from "./crypto";
import { estimateVariableCost } from "./pricing";
import {
  assertPublicDns,
  BROWSER_REJECT_PATTERNS,
  MAX_REDIRECTS,
  readJsonResponseBounded,
  validateTarget,
  type RedirectResolution,
} from "./security";

export const MAX_HTML_BYTES = 2_000_000;
export const MAX_MARKDOWN_BYTES = 1_000_000;
export const MAX_SCREENSHOT_BYTES = 6_000_000;
export const MAX_SNAPSHOT_RESPONSE_BYTES = 17_000_000;
export const MAX_TOTAL_ARTIFACT_BYTES = 9_000_000;
export const MAX_BROWSER_MS = 30_000;

export type ProofProduct = "capture" | "preflight" | "watch_check";

export type ProofManifest = {
  schema: "delta-proof-bundle/v0.6.0";
  proof_id: string;
  product: ProofProduct;
  requested_url: string;
  requested_url_sha256: string;
  capture_started_at: string;
  capture_completed_at: string;
  observed_http_status: number | null;
  observed_title: string | null;
  observed_final_url: string | null;
  redirects: { preflight_count: number; browser_count: number };
  hashes: {
    html: string;
    markdown: string;
    screenshot_png: string;
    bundle_root: string;
  };
  artifact_sizes: {
    html_bytes: number;
    markdown_bytes: number;
    screenshot_png_bytes: number;
    total_bytes: number;
  };
  execution: {
    browser_ms_used: number;
    estimated_variable_cost_usd: number;
    gross_price_usd: number;
    estimated_contribution_margin_usd: number;
  };
  storage: {
    html: string;
    markdown: string;
    screenshot: string;
    manifest: string;
  };
  payment: {
    protocol: "x402-v2-upfront" | "partner-prepaid";
    network: string;
    asset: "USDC";
    listed_price_usd: number;
    pay_to: string;
    channel: string;
    partner: string | null;
  };
  attestation: {
    status: "hash_only";
    canonicalization: "delta-bundle-root/v1";
  };
  disclaimer: string;
};

export type CaptureArtifacts = {
  manifest: ProofManifest;
  html: string;
  markdown: string;
  screenshot: Uint8Array;
};

export type CaptureInput = {
  env: RuntimeEnv;
  product: ProofProduct;
  target: RedirectResolution;
  fulfillmentFingerprint: string;
  grossPriceUsd: number;
  paymentProtocol: ProofManifest["payment"]["protocol"];
  channel: string;
  partner?: string;
};

function base64ToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("invalid_screenshot_base64");
  }
  if (value.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 + 4) {
    throw new Error("capture_too_large");
  }
  const binary = atob(value);
  if (binary.length > MAX_SCREENSHOT_BYTES) throw new Error("capture_too_large");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function nonNegativeInteger(value: string | null): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function isSnapshot(value: unknown): value is BrowserRunSnapshotSuccessResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BrowserRunSnapshotSuccessResponse>;
  return candidate.success === true && Boolean(candidate.result) && Boolean(candidate.meta);
}

async function validateObservedNavigation(snapshot: BrowserRunSnapshotSuccessResponse): Promise<void> {
  const redirectChain = snapshot.meta.redirectChain ?? [];
  if (redirectChain.length > MAX_REDIRECTS) throw new Error("too_many_browser_redirects");
  for (const hop of redirectChain) {
    const url = validateTarget(hop.url);
    await assertPublicDns(url.hostname);
  }
  if (snapshot.meta.finalUrl) {
    const finalUrl = validateTarget(snapshot.meta.finalUrl);
    await assertPublicDns(finalUrl.hostname);
  }
}

export function bundleRootMaterial(manifest: Omit<ProofManifest, "hashes"> & { hashes: Omit<ProofManifest["hashes"], "bundle_root"> }): unknown {
  return {
    schema: manifest.schema,
    proof_id: manifest.proof_id,
    product: manifest.product,
    requested_url: manifest.requested_url,
    requested_url_sha256: manifest.requested_url_sha256,
    capture_started_at: manifest.capture_started_at,
    capture_completed_at: manifest.capture_completed_at,
    observed_http_status: manifest.observed_http_status,
    observed_title: manifest.observed_title,
    observed_final_url: manifest.observed_final_url,
    redirects: manifest.redirects,
    hashes: manifest.hashes,
    artifact_sizes: manifest.artifact_sizes,
    execution: manifest.execution,
    storage: manifest.storage,
    payment: manifest.payment,
    attestation: manifest.attestation,
    disclaimer: manifest.disclaimer,
  };
}

export async function verifyManifestIntegrity(manifest: unknown): Promise<boolean | null> {
  if (!manifest || typeof manifest !== "object") return false;
  const candidate = manifest as Partial<ProofManifest>;
  if (candidate.schema !== "delta-proof-bundle/v0.6.0") return null;
  if (!candidate.hashes?.bundle_root) return false;
  const { bundle_root: expected, ...artifactHashes } = candidate.hashes;
  const withoutHashes = { ...candidate, hashes: artifactHashes } as Omit<ProofManifest, "hashes"> & {
    hashes: Omit<ProofManifest["hashes"], "bundle_root">;
  };
  return (await sha256(stableJson(bundleRootMaterial(withoutHashes)))) === expected;
}

export async function capturePage(input: CaptureInput): Promise<CaptureArtifacts> {
  const { env, target, fulfillmentFingerprint } = input;
  const captureStartedAt = new Date().toISOString();
  const response = await env.BROWSER.quickAction("snapshot", {
    url: target.finalUrl,
    formats: ["content", "screenshot", "markdown"],
    screenshotOptions: { fullPage: true, type: "png", optimizeForSpeed: true },
    viewport: { width: 1_280, height: 900, deviceScaleFactor: 1 },
    gotoOptions: { waitUntil: ["domcontentloaded", "networkidle2"], timeout: 20_000 },
    actionTimeout: 25_000,
    cacheTTL: 0,
    rejectRequestPattern: BROWSER_REJECT_PATTERNS,
    rejectResourceTypes: ["media", "websocket"],
  });
  const browserMs = nonNegativeInteger(response.headers.get("x-browser-ms-used"));
  if (browserMs > MAX_BROWSER_MS) throw new Error("browser_cost_limit_exceeded");
  if (!response.ok) throw new Error(`capture_upstream_${response.status}`);

  const raw = await readJsonResponseBounded(response, MAX_SNAPSHOT_RESPONSE_BYTES);
  if (!isSnapshot(raw)) throw new Error("capture_incomplete");
  await validateObservedNavigation(raw);

  const html = raw.result.content ?? "";
  const markdown = raw.result.markdown ?? "";
  const screenshotBase64 = raw.result.screenshot ?? "";
  if (!html || !screenshotBase64) throw new Error("capture_incomplete");
  const screenshot = base64ToBytes(screenshotBase64);
  const htmlBytes = new TextEncoder().encode(html).byteLength;
  const markdownBytes = new TextEncoder().encode(markdown).byteLength;
  const totalBytes = htmlBytes + markdownBytes + screenshot.byteLength;
  if (
    htmlBytes > MAX_HTML_BYTES ||
    markdownBytes > MAX_MARKDOWN_BYTES ||
    screenshot.byteLength > MAX_SCREENSHOT_BYTES ||
    totalBytes > MAX_TOTAL_ARTIFACT_BYTES
  ) {
    throw new Error("capture_too_large");
  }

  const proofId = uuidFromDigest(await sha256(`${fulfillmentFingerprint}\n${input.product}`));
  const completedAt = new Date().toISOString();
  const [htmlHash, markdownHash, screenshotHash, requestUrlHash] = await Promise.all([
    sha256(html),
    sha256(markdown),
    sha256(screenshot),
    sha256(target.requestedUrl),
  ]);
  const variableCost = estimateVariableCost(env, browserMs, totalBytes);
  const base = {
    schema: "delta-proof-bundle/v0.6.0" as const,
    proof_id: proofId,
    product: input.product,
    requested_url: target.requestedUrl,
    requested_url_sha256: requestUrlHash,
    capture_started_at: captureStartedAt,
    capture_completed_at: completedAt,
    observed_http_status: raw.meta.status ?? null,
    observed_title: raw.meta.title ?? null,
    observed_final_url: raw.meta.finalUrl ?? target.finalUrl,
    redirects: {
      preflight_count: target.redirects.length,
      browser_count: raw.meta.redirectChain?.length ?? 0,
    },
    hashes: {
      html: htmlHash,
      markdown: markdownHash,
      screenshot_png: screenshotHash,
    },
    artifact_sizes: {
      html_bytes: htmlBytes,
      markdown_bytes: markdownBytes,
      screenshot_png_bytes: screenshot.byteLength,
      total_bytes: totalBytes,
    },
    execution: {
      browser_ms_used: browserMs,
      estimated_variable_cost_usd: variableCost,
      gross_price_usd: input.grossPriceUsd,
      estimated_contribution_margin_usd: input.grossPriceUsd - variableCost,
    },
    storage: {
      html: `${proofId}/page.html`,
      markdown: `${proofId}/page.md`,
      screenshot: `${proofId}/screenshot.png`,
      manifest: `${proofId}/manifest.json`,
    },
    payment: {
      protocol: input.paymentProtocol,
      network: env.NETWORK,
      asset: "USDC" as const,
      listed_price_usd: input.grossPriceUsd,
      pay_to: env.PAY_TO,
      channel: input.channel,
      partner: input.partner ?? null,
    },
    attestation: {
      status: "hash_only" as const,
      canonicalization: "delta-bundle-root/v1" as const,
    },
    disclaimer: "DELTA proves what its capture system observed and stored at a time; it does not prove that statements on the source page are factually true or legally admissible in every jurisdiction.",
  };
  const bundleRoot = await sha256(stableJson(bundleRootMaterial(base)));
  const manifest: ProofManifest = { ...base, hashes: { ...base.hashes, bundle_root: bundleRoot } };
  return { manifest, html, markdown, screenshot };
}

export async function storeCapture(env: RuntimeEnv, artifacts: CaptureArtifacts): Promise<void> {
  const { manifest, html, markdown, screenshot } = artifacts;
  const id = manifest.proof_id;
  await Promise.all([
    env.PROOFS.put(`${id}/page.html`, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } }),
    env.PROOFS.put(`${id}/page.md`, markdown, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } }),
    env.PROOFS.put(`${id}/screenshot.png`, screenshot, { httpMetadata: { contentType: "image/png" } }),
    env.PROOFS.put(`${id}/manifest.json`, JSON.stringify(manifest, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    }),
  ]);
}
