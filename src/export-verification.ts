import { sha256 } from './crypto';
import { verifyManifestIntegrity, MAX_HTML_BYTES, MAX_MARKDOWN_BYTES, MAX_SCREENSHOT_BYTES, MAX_TOTAL_ARTIFACT_BYTES, type ProofManifest } from './capture';
import { isPng } from './png';

// Offline verification only. The expected root must come from the buyer's
// authenticated delivery, independently of these downloaded files.
export async function verifyExportedBundle(files: { manifest: Uint8Array; html: Uint8Array; markdown: Uint8Array; screenshot: Uint8Array }, expectedRoot: string) {
  try {
    if (!/^sha256:[0-9a-f]{64}$/.test(expectedRoot) || files.manifest.length > 1_048_576 || files.manifest.length === 0) throw new Error();
    const manifest: ProofManifest = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(files.manifest));
    if (await verifyManifestIntegrity(manifest) !== true || manifest.hashes.bundle_root !== expectedRoot ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(manifest.proof_id) ||
        !Number.isFinite(Date.parse(manifest.capture_completed_at)) || !Number.isFinite(Date.parse(manifest.capture_started_at)) ||
        Date.parse(manifest.capture_completed_at) < Date.parse(manifest.capture_started_at) ||
        manifest.requested_url_sha256 !== await sha256(manifest.requested_url)) throw new Error();
    const bytes = [files.html, files.markdown, files.screenshot];
    const limits = [MAX_HTML_BYTES, MAX_MARKDOWN_BYTES, MAX_SCREENSHOT_BYTES];
    const sizes = [manifest.artifact_sizes.html_bytes, manifest.artifact_sizes.markdown_bytes, manifest.artifact_sizes.screenshot_png_bytes];
    if (!files.html.length || !files.screenshot.length || bytes.some((b, i) => b.length > limits[i] || b.length !== sizes[i]) ||
        bytes.reduce((sum, b) => sum + b.length, 0) !== manifest.artifact_sizes.total_bytes ||
        manifest.artifact_sizes.total_bytes > MAX_TOTAL_ARTIFACT_BYTES) throw new Error();
    const hashes = await Promise.all(bytes.map(b => sha256(b)));
    if (hashes[0] !== manifest.hashes.html || hashes[1] !== manifest.hashes.markdown || hashes[2] !== manifest.hashes.screenshot_png || !await isPng(files.screenshot)) throw new Error();
    return { ok: true as const, schema: 'delta-export-verification/v1', proof_id: manifest.proof_id,
      product: manifest.product, observed_at: manifest.capture_completed_at, bundle_root: expectedRoot,
      artifact_sizes: manifest.artifact_sizes, hashes: manifest.hashes, attestation: 'hash_only' as const,
      confirms: 'byte_integrity_against_supplied_delivery_root', source_truth_verified: false };
  } catch { return { ok: false as const, schema: 'delta-export-verification/v1', error: 'export_bundle_invalid' }; }
}
