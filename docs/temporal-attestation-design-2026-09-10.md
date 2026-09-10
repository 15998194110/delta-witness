# DELTA temporal attestation design — 2026-09-10

Status: implementation design for future paid proof bundles; does not alter current production capture semantics by itself.

## Why this exists

DELTA currently proves internal bundle integrity by hashing a canonical proof manifest into `hashes.bundle_root`. That is useful for tamper detection, but a hash plus a self-reported timestamp does not independently prove that the digest existed before a later consequential action.

A technical interoperability review with PulseFeed identified a stronger, free path: timestamp the immutable DELTA `bundle_root` with OpenTimestamps and expose the resulting proof as a separate temporal-attestation sidecar. PulseFeed independently anchors its own daily dataset manifests and can be referenced separately for historical payment-surface state.

## Non-circular construction

Do **not** place an OpenTimestamps receipt inside the material used to compute the same `bundle_root`; doing so would make the commitment circular.

The safe construction is:

1. Complete the existing DELTA capture and compute the immutable `bundle_root` exactly as today.
2. Persist the proof bundle first. Paid delivery must not depend on any third-party timestamp calendar.
3. Submit only the 32-byte SHA-256 digest represented by `bundle_root` to multiple public OpenTimestamps calendars using the standard protocol.
4. Store the returned detached timestamp proof separately, for example `${proof_id}/attestation.ots`, plus a small `${proof_id}/attestation.json` metadata sidecar binding `proof_id`, `bundle_root`, calendar set, submission time, proof hash, and current verification state.
5. Public proof rendering may surface that sidecar as `temporal_attestation` without changing the original root-covered manifest.
6. A later maintenance pass may upgrade a pending OTS receipt to a Bitcoin-block attestation. Upgrading the sidecar must not rewrite the original DELTA bundle or payment record.

## Availability and failure isolation

Temporal anchoring is enrichment, not a prerequisite for fulfillment. A calendar 5xx, timeout, DNS error, malformed response, or rate limit must be treated as external channel degradation:

- deliver the paid DELTA proof normally;
- record `temporal_attestation.status = pending_retry` in the sidecar when possible;
- retry calendars with bounded backoff from an isolated maintenance path;
- never change the paid price or charge again for an anchoring retry;
- never allow calendar health to block Capture, Preflight, Guarded-Action Pilot, proof retrieval, or Treasury reconciliation.

No wallet signature, Bitcoin transaction, listing fee, or DELTA Treasury movement is required to use public OpenTimestamps calendars.

## PulseFeed interoperability

The useful reference model is two-layered and non-authoritative in both directions:

- **Current payment-surface state:** cite PulseFeed's free per-endpoint verification URL with endpoint, payTo, network, asset, amount, verdict and observation time.
- **Historical payment-surface state:** cite the PulseFeed daily anchored manifest for the relevant observation date, together with its signature/OTS material.
- **DELTA action-side evidence:** cite the immutable DELTA proof and its own independent temporal-attestation sidecar.

PulseFeed does not authorize the downstream action, and DELTA does not certify the seller. Each reference remains an independent evidence source.

## Evidence language

Until a sidecar has a verified Bitcoin-block attestation, DELTA must not claim an independently proven historical observation time. Use precise states such as `hash_only`, `ots_pending`, and `bitcoin_anchored`; never collapse these into a generic "verified" label.

## Implementation gate

Before production rollout, require tests for: root immutability, sidecar-to-root binding, malformed/oversized calendar responses, SSRF-safe fixed calendar allowlist, timeout isolation, idempotent retries, no double charging, public verifier behavior when the sidecar is absent, and upgrade of pending receipts without rewriting the original proof bundle.