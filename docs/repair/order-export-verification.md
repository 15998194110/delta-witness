# D06 authenticated artifact export — local verification

Status: **local implementation and isolated tests only; not published or production accepted**. This document describes the current local route. No live download, wallet signature, provider request, migration, or production object write was performed for these tests.

## Authority and contract

- `GET /v1/orders/{order_id}/artifacts/{artifact}` accepts `html`, `markdown`, `screenshot`, or `manifest`.
- The existing shared order capability is supplied only in `x-delta-recovery-token`. An order ID or public proof ID alone, query token, or old payment signature does not authorize access. Do not put the capability into a URL, command history, logs, chat, or exported evidence.
- Core owns authentication, configured lifetime, revocation, and entitlement. Newly enrolled Capture/Preflight orders have status/recover/export scopes. Older status/recover-only capabilities fail export with 403; this change does not migrate or create historical entitlements.
- An immutable settlement journal must bind the order and authority digest to the original request, payer/asset/network/amount and payment fingerprint. Fulfillment must be complete, and every original artifact must pass Core's manifest/bundle verification. No export starts Browser Run, submits payment, or repairs evidence by replacing files.
- Each export rereads current capability metadata immediately before returning bytes. Expiry/revocation/token changes during a slow read fail closed. The server never returns the token. Shared record lifecycle operations remain Core-owned; export tests mutate synthetic records to prove rejection, not to claim a production rotation/revocation management interface exists.

## Download and local verification

A client that already retained its original opt-in order capability may request each artifact through the authenticated route and save the response as a file. The response includes a fixed attachment filename, `Content-Length`, and `X-Delta-Content-Sha256`. Browser clients at the configured trusted origins may read those headers; there is no wildcard credential CORS.

1. Preserve the downloaded files byte-for-byte, including the original `manifest.json` whitespace. Do not reserialize the manifest or render downloaded HTML on the application origin.
2. Compute SHA-256 of each downloaded file locally (for example, PowerShell `Get-FileHash -Algorithm SHA256 -LiteralPath <downloaded-file>`). Compare its lowercase digest, prefixed with `sha256:`, to `X-Delta-Content-Sha256`.
3. Compare the HTML, Markdown and PNG hashes to `manifest.hashes.html`, `manifest.hashes.markdown`, and `manifest.hashes.screenshot_png`, and compare sizes to `artifact_sizes`.
4. Use Core's `verifyManifestIntegrity`/`bundleRootMaterial` canonicalization to verify `hashes.bundle_root`. Hashing an arbitrary JSON serialization is not equivalent. Confirm proof ID, product, requested URL, original paid price, network, Treasury recipient and observation time against the authenticated original delivery.
5. A matching bundle proves internal byte/metadata integrity, not the truth of the source page, nor an independent signature by a third-party attester. The manifest remains `hash_only`.

HTML and Markdown are delivered as `application/octet-stream` attachments. All export responses use private/no-store, nosniff, no-referrer, noindex, frame denial, and a CSP sandbox with no allowed sources. PNG and JSON also remain attachments. Full API middleware tests verify these protections survive route composition.

## Bounds and failure handling

`src/order-storage.ts` supplies the shared request-local storage view for Core order readers and export:

- Metadata max 32,000 bytes; manifest max 1,048,576 bytes.
- HTML/Markdown/PNG use Core's 2,000,000 / 1,000,000 / 6,000,000 byte limits, with a 9,000,000 byte aggregate artifact limit enforced by Core/export verification.
- Declared size must be a safe nonnegative integer and match the streamed bytes. Reads use one bounded preallocated buffer, avoiding unbounded per-chunk bookkeeping.
- Every artifact is read at most once per export, so repeated shared integrity checks see one consistent snapshot. Authentication/settlement/fulfillment metadata stays fresh.
- One 15-second deadline covers auth, storage streams, integrity checks and final auth recheck. Active readers and late-arriving R2 bodies are canceled. Cancellation cannot masquerade as successful EOF.
- Missing, corrupt, oversized, stalled or inconsistent evidence fails closed. Unknown errors return a controlled 503 without upstream response bodies or credentials. An ambiguous original order is not deleted, re-signed, re-settled or recaptured.
- This does not promise a production retention period or select a default capability TTL. Core still requires explicit configuration. A local deadline cannot prove provider-side cancellation of already dispatched operations.

## Evidence

All log/metadata pairs are under `C:/Users/10122/Documents/ChatGPT/DELTA-repair-evidence-20261028/`, produced by the approved `Run-LocalCheck.ps1 -Offline` runner. No external networking was authorized.

- `29-order-export-target-1`: 33 passed, 2 failed because simulated timers advanced before asynchronous synthetic storage reached the intended stall. Synchronization was corrected to wait for the specific fake storage read.
- `29-order-export-target-2`: 35/35 passed.
- `29-order-export-route-red-3`: 35 passed, 1 failed: global API middleware overwrote the artifact sandbox CSP.
- `29-order-export-route-green-4`: 39/39 passed after Core preserved the route CSP; includes full route, all four original files, wrong buyer/order, missing capability, legacy scope, expiry/revocation/rotation, unknown settlement, tamper/missing evidence, historical price, concurrency, byte bounds and late/stalled stream cancellation.
- `29-order-export-shared-5`: 39/39 passed after extraction to shared `order-storage.ts`.
- `29-order-export-types-1`: typecheck passed before the concurrent integration edits. `29-order-export-types-2` recorded failures in other concurrently edited test fixtures, not in the export module; final integrated typecheck must supersede this stage.

Remaining acceptance: final integrated test/typecheck, release/rollback gate review, production credential-lifetime/retention policy, controlled deployment authorization, and live authenticated provider behavior. No real customer export, revenue restoration, or production success is claimed.

Final D06 targeted stage: `29-order-export-shared-6` passed **42/42**, adding invalid/oversized order-metadata rejection before artifact reads. Frozen source fingerprints at this stage:

| File | SHA-256 |
|---|---|
| src/order-export.ts | 55f7438b329db803e6cd60ce023e156f9c548764029c7b807116af394a678d5a |
| src/order-storage.ts | b438703d6aaad1dbd2bd2d8dc1f1ba8eb19fe4a1fc093d115a41508043ebd9e7 |
| tests/order-export.test.ts | 42e369f135077103242e90a18451950886e10be29b1877920c1754d1f398dc37 |

Historical compatibility limit: the shared artifact verifier currently compares the recorded payment recipient/network with current Core configuration. Changing Treasury/network without a reviewed original-payment-context compatibility path will make old entitled exports fail closed. This batch preserves original paid prices and bytes but does not authorize Treasury reconfiguration or a migration.
