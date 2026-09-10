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
4. Store detached timestamp proofs separately from the root-covered bundle, plus a small metadata sidecar binding `proof_id`, `bundle_root`, calendar, submission time, proof hash, and current verification state.
5. Public proof rendering may surface those sidecars as `temporal_attestation` without changing the original root-covered manifest.
6. A later maintenance pass may upgrade a pending OTS receipt to a Bitcoin-block attestation. Upgrading a sidecar must not rewrite the original DELTA bundle or payment record.

## Calendar proof set and upgrade lifecycle

Operational experience shared by PulseFeed suggests using more than one independent public calendar and retaining the proofs independently rather than merging away provenance. The initial fixed allowlist to evaluate in tests is:

- `a.pool.opentimestamps.org`
- `b.pool.opentimestamps.org`
- `finney.calendar.eternitywall.com`

Treat every calendar result as its own proof object, e.g. `${proof_id}/attestations/<calendar-id>.ots`, with a corresponding digest recorded in metadata. Quorum is an availability/redundancy property; one calendar must never become a single point of failure for paid fulfillment.

A freshly returned `.ots` calendar receipt is normally **pending**, not yet a Bitcoin block attestation. Do not run an immediate upgrade attempt and interpret the expected no-op as a failure. The maintenance path should instead revisit receipts after an age threshold (initially about 24 hours) and then on a bounded daily cadence until they either contain a `BitcoinBlockHeaderAttestation` or reach an explicit retry/escalation state.

The OpenTimestamps reference client may rewrite an upgraded `.ots` file in place and leave a `.bak`. DELTA must not let this silently violate sidecar immutability or create ambiguous shadow proofs. Production implementation should either version sidecars explicitly or clean/record backup artifacts deterministically, while keeping the original `bundle_root` and paid proof immutable.

## Availability and failure isolation

Temporal anchoring is enrichment, not a prerequisite for fulfillment. A calendar 5xx, timeout, DNS error, malformed response, or rate limit must be treated as external channel degradation:

- deliver the paid DELTA proof normally;
- record `temporal_attestation.status = pending_retry` in the sidecar when possible;
- retry calendars with bounded backoff from an isolated maintenance path;
- never change the paid price or charge again for an anchoring retry;
- never allow calendar health to block Capture, Preflight, Guarded-Action Pilot, proof retrieval, or Treasury reconciliation.

No wallet signature, Bitcoin transaction, listing fee, or DELTA Treasury movement is required to use public OpenTimestamps calendars.

## Temporal ordering bounds

An upgraded OpenTimestamps proof establishes an **upper bound** on the committed observation digest: the digest existed no later than the attesting Bitcoin block. That is not, by itself, a complete proof that the observation happened before a consequential action.

To make an `observation_before_action` claim independently checkable, DELTA also needs a defensible **lower bound for the action**:

- For an on-chain consequential action, use the action transaction/block as the independent lower-bound evidence.
- Where x402 settlement is the immediately preceding on-chain event and DELTA's execution state machine cryptographically/idempotently binds that settled payment to the exact request, settlement provides an independently timestamped ordering checkpoint; it must still remain distinct from evidence that the downstream action itself occurred.
- For an off-chain consequential action, retain an independently verifiable action receipt/time source when one exists. If none exists, DELTA must not overstate the ordering claim. The correct statement is limited to what the anchor proves, such as `bundle_root existed before Bitcoin block N`, plus separately sourced action telemetry.

Keep `payment_authorized`, `settlement_confirmed`, `treasury_received`, observation attestation, and action receipt as separate evidence dimensions. Do not infer one from another.

## PulseFeed interoperability

The useful reference model is two-layered and non-authoritative in both directions:

- **Current payment-surface state:** cite PulseFeed's free per-endpoint verification URL with endpoint, payTo, network, asset, amount, verdict and observation time.
- **Historical payment-surface state:** cite the PulseFeed daily anchored manifest for the relevant observation date, together with its signature/OTS material.
- **DELTA action-side evidence:** cite the immutable DELTA proof and its own independent temporal-attestation sidecar.

PulseFeed does not authorize the downstream action, and DELTA does not certify the seller. Each reference remains an independent evidence source.

## Evidence language

Until a sidecar has a verified Bitcoin-block attestation, DELTA must not claim an independently proven historical observation time. Use precise states such as `hash_only`, `ots_pending`, and `bitcoin_anchored`; never collapse these into a generic `verified` label.

Even after `bitcoin_anchored`, do not claim `observation_before_action` unless the action has the independent lower-bound evidence described above. An anchor proves existence-before-block, not every downstream temporal relation.

## Implementation gate

Before production rollout, require tests for: root immutability, sidecar-to-root binding, independent per-calendar proof retention, malformed/oversized calendar responses, SSRF-safe fixed calendar allowlist, timeout isolation, idempotent retries, expected pending receipts, delayed upgrade behavior, deterministic `.bak`/version handling, no double charging, public verifier behavior when the sidecar is absent, upgrade of pending receipts without rewriting the original proof bundle, on-chain action lower-bound verification, and safe evidence wording when no independently verifiable off-chain action time exists.