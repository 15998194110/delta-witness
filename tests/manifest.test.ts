import { describe, expect, it } from "vitest";
import { bundleRootMaterial, verifyManifestIntegrity, type ProofManifest } from "../src/capture";
import { sha256, stableJson } from "../src/crypto";

async function manifest(): Promise<ProofManifest> {
  const base = {
    schema: "delta-proof-bundle/v0.6.0" as const,
    proof_id: "7d9d12f7-8f91-5f41-9f0c-5ef257d9ea5d",
    product: "capture" as const,
    requested_url: "https://example.com/",
    requested_url_sha256: `sha256:${"1".repeat(64)}`,
    capture_started_at: "2026-08-31T00:00:00.000Z",
    capture_completed_at: "2026-08-31T00:00:01.000Z",
    observed_http_status: 200,
    observed_title: "Example",
    observed_final_url: "https://example.com/",
    redirects: { preflight_count: 0, browser_count: 0 },
    hashes: { html: `sha256:${"2".repeat(64)}`, markdown: `sha256:${"3".repeat(64)}`, screenshot_png: `sha256:${"4".repeat(64)}` },
    artifact_sizes: { html_bytes: 1, markdown_bytes: 1, screenshot_png_bytes: 1, total_bytes: 3 },
    execution: { browser_ms_used: 1000, estimated_variable_cost_usd: 0.002, gross_price_usd: 0.01, estimated_contribution_margin_usd: 0.008 },
    storage: { html: "id/page.html", markdown: "id/page.md", screenshot: "id/screenshot.png", manifest: "id/manifest.json" },
    payment: { protocol: "x402-v2-upfront" as const, network: "eip155:8453", asset: "USDC" as const, listed_price_usd: 0.01, pay_to: "0x1990e21bc219696ff7fbc26527dbaed335ac6367", channel: "direct", partner: null },
    attestation: { status: "hash_only" as const, canonicalization: "delta-bundle-root/v1" as const },
    disclaimer: "Observation, not truth.",
  };
  const root = await sha256(stableJson(bundleRootMaterial(base)));
  return { ...base, hashes: { ...base.hashes, bundle_root: root } };
}

describe("proof manifest integrity", () => {
  it("verifies canonical manifests and detects tampering", async () => {
    const valid = await manifest();
    expect(await verifyManifestIntegrity(valid)).toBe(true);
    expect(await verifyManifestIntegrity({ ...valid, observed_title: "Tampered" })).toBe(false);
  });

  it("does not misclassify legacy schemas as verified", async () => {
    expect(await verifyManifestIntegrity({ schema: "delta-proof-bundle/v0.2", hashes: { bundle_root: "x" } })).toBe(null);
  });
});
