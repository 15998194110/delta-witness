import type { RuntimeEnv } from "./env";
import { sha256, stableJson, uuidFromDigest } from "./crypto";
import { costModelAssumptions, estimateVariableCost, type CostModelAssumptions } from "./pricing";
import type { RetentionPolicy } from "./retention";
import { withinDeadline } from "./deadline";
import { createOrderReadSnapshot, MetadataReadError, writeOrderObject } from "./order-storage";
import { isPng } from "./png";
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
    browser_ms_used: number | null;
    browser_ms_source?: "provider_header" | "unknown";
    estimated_browser_ms?: number;
    cost_basis?: "model_not_invoice";
    cost_model?: CostModelAssumptions;
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
  // Core supplies only the verified original order snapshot. Absence is an
  // explicit limited one-month estimate, not current-policy retroactivity.
  retentionPolicy?: RetentionPolicy;
};

async function base64ToBytes(value: string): Promise<Uint8Array> {
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
  if (!await isPng(bytes)) throw new Error("invalid_screenshot_png");
  return bytes;
}

function nonNegativeInteger(value: string | null): number | null {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isSnapshot(value: unknown): value is BrowserRunSnapshotSuccessResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BrowserRunSnapshotSuccessResponse>;
  if (candidate.success !== true || !candidate.result || typeof candidate.result !== "object" || Array.isArray(candidate.result) || !candidate.meta || typeof candidate.meta !== "object" || Array.isArray(candidate.meta)) return false;
  const { content, markdown, screenshot } = candidate.result;
  const { status, title, finalUrl, redirectChain } = candidate.meta;
  return typeof content === "string" && typeof markdown === "string" && typeof screenshot === "string" &&
    (status === undefined || status === null || (Number.isInteger(status) && status >= 100 && status <= 599)) &&
    (title === undefined || title === null || typeof title === "string") &&
    (finalUrl === undefined || finalUrl === null || typeof finalUrl === "string") &&
    (redirectChain === undefined || (Array.isArray(redirectChain) && redirectChain.every((hop) => hop && typeof hop === "object" && typeof hop.url === "string")));
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
  const costModel = costModelAssumptions(env, input.retentionPolicy);
  const captureStartedAt = new Date().toISOString();
  let expired = false;
  const response = await withinDeadline(env.BROWSER.quickAction("snapshot", {
    url: target.finalUrl,
    formats: ["content", "screenshot", "markdown"],
    screenshotOptions: { fullPage: true, type: "png", optimizeForSpeed: true },
    viewport: { width: 1_280, height: 900, deviceScaleFactor: 1 },
    gotoOptions: { waitUntil: ["domcontentloaded", "networkidle2"], timeout: 20_000 },
    actionTimeout: 25_000,
    cacheTTL: 0,
    rejectRequestPattern: BROWSER_REJECT_PATTERNS,
    rejectResourceTypes: ["media", "websocket"],
  }).then(response => {
    // The binding has no caller cancellation handle. Do not retain a body that
    // arrives after our deadline, and never start another observation here.
    if (expired) void response.body?.cancel().catch(() => {});
    return response;
  }), MAX_BROWSER_MS, "capture_response_timeout", () => { expired = true; });
  const browserMs = nonNegativeInteger(response.headers.get("x-browser-ms-used"));
  if (browserMs !== null && browserMs > MAX_BROWSER_MS) throw new Error("browser_cost_limit_exceeded");
  if (response.status !== 200) throw new Error(`capture_upstream_${response.status}`);

  const raw = await readJsonResponseBounded(response, MAX_SNAPSHOT_RESPONSE_BYTES);
  if (!isSnapshot(raw)) throw new Error("capture_incomplete");
  await validateObservedNavigation(raw);

  const html = raw.result.content ?? "";
  const markdown = raw.result.markdown ?? "";
  const screenshotBase64 = raw.result.screenshot ?? "";
  // A new capture requires both textual representations and a PNG. A valid
  // screenshot alone must not turn a missing/blank text snapshot into success.
  // Historical reads below keep the original manifest contract and bytes.
  if (!html.trim() || !markdown.trim() || !screenshotBase64) throw new Error("capture_incomplete");
  const screenshot = await base64ToBytes(screenshotBase64);
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
  const variableCost = estimateVariableCost(env, browserMs ?? MAX_BROWSER_MS, totalBytes, 5, { retentionMonths: costModel.storageMonths });
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
      browser_ms_source: browserMs === null ? "unknown" as const : "provider_header" as const,
      estimated_browser_ms: browserMs ?? MAX_BROWSER_MS,
      cost_basis: "model_not_invoice" as const,
      cost_model: costModel,
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
  const putImmutable = async (key: string, value: string | Uint8Array, contentType: string) => {
    const expected = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const written = await writeOrderObject(env, key, value, {
      onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType },
    });
    if (written) return;
    // An ambiguous write may already have succeeded. Accept identical bytes,
    // but never replace an earlier observation to make a retry complete.
    const snapshot = createOrderReadSnapshot(env);
    snapshot.allowArtifactsFor(id);
    try {
      await withinDeadline((async () => {
        const actual = await snapshot.readArtifact(key);
        snapshot.assertActive();
        if (actual.byteLength !== expected.byteLength || await sha256(actual) !== await sha256(expected)) throw new Error("artifact_identity_conflict");
        snapshot.assertActive();
      })(), 15_000, "order_evidence_unavailable", snapshot.cancel);
    } catch (error) {
      if (error instanceof Error && error.message === "artifact_identity_conflict") throw error;
      throw new MetadataReadError();
    } finally { snapshot.cancel(); }
  };
  await Promise.all([
    putImmutable(`${id}/page.html`, html, "text/html; charset=utf-8"),
    putImmutable(`${id}/page.md`, markdown, "text/markdown; charset=utf-8"),
    putImmutable(`${id}/screenshot.png`, screenshot, "image/png"),
  ]);
  // Publish the manifest only after every required artifact write succeeded.
  await putImmutable(`${id}/manifest.json`, JSON.stringify(manifest, null, 2), "application/json; charset=utf-8");
}

// Recovery reads already-published evidence only. It never captures, settles,
// rewrites artifacts, or infers success from a manifest without its bytes.
type StoredCaptureInput = {
  env: RuntimeEnv;
  fulfillmentFingerprint: string;
  product: ProofProduct;
  requestedUrl: string;
  grossPriceUsd: number;
  paymentProtocol: ProofManifest["payment"]["protocol"];
  partner?: string;
};
export async function readStoredCapture(input: StoredCaptureInput): Promise<CaptureArtifacts | null> {
  const snapshot = createOrderReadSnapshot(input.env);
  try {
    const id = uuidFromDigest(await sha256(`${input.fulfillmentFingerprint}\n${input.product}`));
    snapshot.allowArtifactsFor(id);
    return await withinDeadline((async () => {
      const result = await readStoredCaptureWithinBounds({ ...input, env: snapshot.env });
      snapshot.assertActive();
      return result;
    })(), 15_000, "order_evidence_unavailable", snapshot.cancel);
  } catch { throw new MetadataReadError(); }
  finally { snapshot.cancel(); }
}
async function readStoredCaptureWithinBounds(input: StoredCaptureInput): Promise<CaptureArtifacts | null> {
  const id = uuidFromDigest(await sha256(`${input.fulfillmentFingerprint}\n${input.product}`));
  const object = await input.env.PROOFS.get(`${id}/manifest.json`);
  if (!object) return null;
  const manifest = await object.json<ProofManifest>();
  if (await verifyManifestIntegrity(manifest) !== true || manifest.proof_id !== id || manifest.product !== input.product ||
    manifest.requested_url !== input.requestedUrl || manifest.requested_url_sha256 !== await sha256(input.requestedUrl) ||
    manifest.payment?.network !== input.env.NETWORK || manifest.payment.asset !== "USDC" ||
    manifest.payment.pay_to?.toLowerCase() !== input.env.PAY_TO.toLowerCase() ||
    manifest.payment.protocol !== input.paymentProtocol || manifest.payment.partner !== (input.partner ?? null) ||
    manifest.payment.listed_price_usd !== input.grossPriceUsd || manifest.execution?.gross_price_usd !== input.grossPriceUsd) return null;
  const keys = [`${id}/page.html`, `${id}/page.md`, `${id}/screenshot.png`];
  if (manifest.storage?.html !== keys[0] || manifest.storage.markdown !== keys[1] || manifest.storage.screenshot !== keys[2] || manifest.storage.manifest !== `${id}/manifest.json`) return null;
  const objects = await Promise.all(keys.map((key) => input.env.PROOFS.get(key)));
  const limits = [MAX_HTML_BYTES, MAX_MARKDOWN_BYTES, MAX_SCREENSHOT_BYTES];
  if (objects.some((artifact, i) => !artifact || artifact.size > limits[i])) return null;
  const bytes = await Promise.all(objects.map(async (artifact) => new Uint8Array(await artifact!.arrayBuffer())));
  const sizes = [manifest.artifact_sizes?.html_bytes, manifest.artifact_sizes?.markdown_bytes, manifest.artifact_sizes?.screenshot_png_bytes];
  if (bytes.some((value, i) => value.byteLength !== sizes[i] || value.byteLength > limits[i]) || bytes[0].length === 0 || bytes[2].length === 0 ||
    bytes.reduce((total, value) => total + value.byteLength, 0) !== manifest.artifact_sizes.total_bytes || manifest.artifact_sizes.total_bytes > MAX_TOTAL_ARTIFACT_BYTES) return null;
  const hashes = await Promise.all(bytes.map((value) => sha256(value)));
  if (hashes[0] !== manifest.hashes.html || hashes[1] !== manifest.hashes.markdown || hashes[2] !== manifest.hashes.screenshot_png || !await isPng(bytes[2])) return null;
  return { manifest, html: new TextDecoder().decode(bytes[0]), markdown: new TextDecoder().decode(bytes[1]), screenshot: bytes[2] };
}
