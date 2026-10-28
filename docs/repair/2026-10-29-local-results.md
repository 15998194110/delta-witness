# DELTA v1.1 — first local repair batch

Status: **local changes tested; not released; not production accepted; not a restored revenue loop**. This batch continues the 2026-10-28 baseline. It does not close all 108 scenarios or G01–G08.

## Baseline and preserved work

The five required v1.1 documents were read from their ZIP entries and the 12 packaged hashes verified. See `2026-10-28-baseline.md` for input digest, commit/tree relationships, original dirty state and data authority. Source is upstream `455f7be8278205f78e2099b85c45867ba39163b6`, branch `codex/stability-repair-20261028`. The original outer `d570f69` checkout remains at 44 modified / 108 untracked entries; the original nested `1bd01581` checkout remains clean. No reset, clean, production proof deletion or credential copy was performed.

The recovered 35-file candidate was selectively ported rather than applied over later changes. Its 2026-10-04 historical 337 tests are not this run's evidence. The actual clean baseline was 154 tests and six checks. Current package labels are 0.7.1; lock root metadata and Worker version literals now agree. Dependency versions/integrity were not upgraded. Labels alone do not identify the candidate: use Git commit and per-file/artifact hashes. A future public package needs an unused release version.

## Implemented scope

- Core/Pilot claim transitions share conditional creation and ETag compare-and-swap for retry, draft, final, failure and recovery writes. Lost claims cannot overwrite later delivery state.
- Settlement reservations precede external settlement. Unknown results are retained and do not authorize another settlement POST. Binding checks retain canonical chain, token, recipient, amount and request identity. Existing completed historical-price responses remain replayable.
- Capture persists original response drafts, verifies original artifacts on recovery, writes required artifacts before the manifest and conditionally creates every proof object. Identical retries are accepted; conflicting observations cannot replace earlier bytes. Negative Preflight conclusions remain negative.
- PNG validation now checks chunk boundaries/CRC, legal encoding, compressed data, decoded size and row filters with pixel/byte/time limits. Incoming bodies, Browser headers/body, adapters and read-only scripts have finite limits. Cancelling a reader cannot turn an expired operation into successful EOF; late response bodies are cancelled where the transport exposes them.
- Base/JS/MCP/Gateway distinguish completed delivery from HTTP success or unknown outcome. MCP bounds signing within one invocation while retaining automatic authorized purchases. Apify persists output before billing and preserves unknown billing; cross-run atomic billing is still open.
- Treasury reads validate canonical Base-USDC logs, chain, bounded/confirmed ranges, block identity, exact integer amounts and response envelopes. Explicit local checkpoint snapshots are immutable and use CAS. Partial scans and contradictory historical readback remain unknown. Workflow semantic checks retain a visible failure and evidence upload.
- true402 is import-safe and read-only; pagination exhaustion/malformed responses do not imply absence. Catalog identity, declared contract compatibility and actual callability are separate. Query scripts do not equate telemetry or receipt candidates with customer revenue.

## Actual local verification

Evidence logs and command metadata live in the private sibling `DELTA-repair-evidence-20261028` folder. Each execution records command, timestamps, exit code, log SHA-256 and a source fingerprint. Earlier failed attempts are retained. Final evidence index is `validation-evidence.json` alongside this report.

| Suite | Passed | Scope |
|---|---:|---|
| Core | 272 | Includes artifact, payment, Watch, Treasury, read-only scanners and Apify mock tests |
| Base App | 77 | Existing behavior, buyer locks, response/body limits |
| Partner Gateway | 15 | Auth/tenant/request forwarding and bounded delivery |
| MCP | 42 | Payment policy, one-call signing guard, completed/unknown delivery |
| JS | 14 | Challenges, delivered/unknown semantics and transport limits |
| Total | **420** | Test cases, not 420 distinct acceptance scenarios |

Six module type/syntax checks passed. Core/Gateway Wrangler `deploy --dry-run` builds and Base/MCP builds passed. Wrangler 4.127.1 was reviewed first: dry-run skips `requireAuth`, upload and migration paths. No actual deploy command without dry-run was run. Base accountAssociation source was preserved; local manifest/assets validation passed. No live manifest readback is claimed.

JS and MCP `npm pack --ignore-scripts` archives were unpacked and every byte matched the reviewed source/build files. Unpacked JS performed one unsigned mocked challenge; unpacked MCP initialized and listed Capture/Preflight over stdio using existing locked local dependencies. This is not a clean registry install or published-package verification. Python is still a discovery-only client; bundled Python has no httpx/hatchling/build, so Python runtime/package parity was not qualified.

Node tests use a preload that denies fetch/HTTP/TCP/TLS until explicit mocks replace the permitted transport, and the local runner removes ambient credential variables. This is process-level isolation, not an OS network sandbox. The Python tarball comparison was a reviewed stdlib-only filesystem script with no network code; the Node preload does not constrain Python. Mock provider timing and memory R2 behavior do not establish real Cloudflare/facilitator guarantees.

Defects actually reproduced and corrected include cancelled-body EOF races, stale proof-object replacement, Treasury contradictory history, late Browser body retention, and the local pricing source guard's outdated one-argument MCP call matcher. The matcher still requires the chosen product; it now accepts the added cancellation predicate. Tests continue to verify authorized automatic initial signing. Failed logs were not rewritten.

## Acceptance status by requirement

`partial` means useful local implementation/tests exist but the full requirement is not closed. None of these rows is an online/commercial acceptance claim.

| Requirement / scenarios | Status and evidence | Outstanding scope |
|---|---|---|
| D01 T01–T04 | Partial; provenance, baseline, version inventory, local package comparison | Live/artifact-to-deployment mapping and old installed clients |
| D02 T01–T05 | Local payment regression passed for current journal and original headers | Historical semantic-header mapping, externally verified reconciliation |
| D03 T01–T04 | Partial; CAS and concurrent replay tests | Stable buyer business order, restart/new-nonce identity; old-worker rollback |
| D04 T01–T05 | Partial; verified draft recovery, immutable bytes, negative Preflight replay, bounded retries | Missing drafts, queryable final liability and partial Pilot |
| D05 T01–T05 | Partial; locks, account checks and deadlines | Authenticated order lookup/recovery and secure restart flow |
| D06 T01–T05 | Open local | Buyer entitlement, scoped export, expiry/revocation and offline export verifier |
| D07 T01–T04 | Open local/policy | Configurable retention snapshots and dry-run; no retroactive deletion or new promise |
| D08 T01–T04 | Partial; PNG, hash, immutable artifact and manifest-last regressions | Full artifact/draft interruption recovery and export qualification |
| D09 T01–T05 | Local checkpoint/RPC regression passed (55 targeted tests, included in Core) | Approved production cursor store/start boundary, real gap fill and provider evidence |
| D10 T01–T05 | Partial; unknown accounting remains unknown | One order-to-receipt/delivery/refund/liability ledger view |
| D11 T01–T04 | Partial; semantic payload validator and final workflow failure retained | Actual workflow execution/artifact delivery and release/rollback exercise |
| D12 T01–T04 | Read-only local inventory | Independent provider task states, pause reasons, triggers and delivered reports |
| D13 T01–T04 | Partial; aggregate draft/final write recovery | Per-page durable progress and partial Pilot recovery |
| D14 T01–T04 | Partial; existing tenant/quota tests plus gateway bounds | Full prepaid concurrent end-to-end order/entitlement qualification |
| D15 T01–T04 | Partial; retained prepaid budget, lease/CAS tests | Durable webhook event/retry separation and interruption qualification |
| D16 T01–T04 | Partial; same-run output/billing mocks | Platform-supported cross-run/multi-instance atomic billing and actual payout evidence |
| D17 T01–T04 | Partial; JS/MCP policy/delivery tests and local unpack/start | Python parity, secure restart and published-package/registry install verification |
| D18 T01–T04 | Partial; current price and local version checks, negative/observation states | Unified future order/export schema, published discovery synchronization |
| D19 T01–T04 | External not run | Current authoritative listing readbacks and authenticated updates; no registrations performed |
| D20 T01–T05 | Partial; true402 22 tests and import/read-boundary regressions | Other scanners and current official external schema/callable readback |
| D21 T01–T04 | Open local/external contract | Business transaction/service fee correlation contract; no guessed provider fields |
| D22 T01–T04 | Partial; reports distinguish estimates from actual accounting | Missing Browser header still defaults to zero; retention duration, failure/platform cost, order attribution remain open |
| D23 T01–T04 | Open local/external control plane | Canonical operator ledger concurrency, SENT reconciliation and cross-environment deduplication |
| D24 T01–T05 | Partial; existing SSRF plus new bounded input, redaction and locked-build checks | Full buyer/export isolation, provider behavior and dependency security audit |
| D25 T01–T04 | External/commercial not run | Independent buyer purpose, settlement, fulfillment, Treasury receipt and actual margin |

## System gates and rollback

| Gate | Result |
|---|---|
| G01 | Partial: authority/responsibility table and shared claims; complete stable order contract still absent |
| G02 | Partial: 154 baseline → 420 current tests; legacy same-header/old-price evidence; mixed-version gap remains |
| G03 | Not passed: local payment→proof fixtures do not include authenticated buyer export plus receipt/revenue linkage |
| G04 | Partial: concurrency, final-write interruption, unknown settlement and artifact integrity tested; Pilot/Apify/old-runtime gaps remain |
| G05 | Partial: bounded paths and one-call signing tests; provider action cancellation and all layers' budgets still need full qualification |
| G06 | Not run: deterministic repeated fixtures are not a predeclared sustained workload/soak test |
| G07 | **Blocked, no release:** unchanged 455f7be cannot safely consume new unknown/blocked/draft records |
| G08 | Partial: independent cross-module source review; real alerts/report delivery not verified |

See `independent-review.md` for exact current/historical evidence. Do not roll back to the unmodified old Worker after the new runtime has written settlement/fulfillment records. A future release must first provide and exercise a fencing-compatible fallback or a verified isolation procedure for all affected in-flight orders, with concrete artifacts and thresholds. Code rollback cannot undo a settlement; no lock removal, payment retry or evidence deletion is an acceptable substitute.

There is no migration in this batch. Existing direct and partner rails, old completed response formats and original proof schemas remain readable. The new settlement journal and immutable artifact writes replace unguarded side-effect/final-write behavior locally; they are not dual payment paths. Historical snapshots/unknown records are retained. No legacy cleanup date is authorized. The legacy same-header replay path must stay until trustworthy historical identity/entitlement migration is designed and separately approved.

## Next local dependency batch and external boundaries

Next local work is one Core-owned business-order/authentication/recovery contract, with explicit identities for buyer request, payment authorization, settlement, fulfillment and exported entitlement. Thin adapters should consume that contract; they must not independently invent new signing/recovery rules. Then durable Pilot page progress, retention snapshots/dry-run and order-level accounting can build on it. These remain engineering work, not a request for production permission.

Production publishing/migration, real artifact deletion, transfers/refunds/signatures, customer contact, listing writes and task activation remain outside this authorization. No approval is requested prematurely. Actual provider policy/account actions can be presented only after a concrete local candidate and its release gates are ready. No First Stranger Revenue, restored autonomous income or online acceptance is inferred from this report.
