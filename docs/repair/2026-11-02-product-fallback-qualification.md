# Additional local Watch / Pilot fallback qualification

This follow-up extends the prior Capture/Guard exercise in `2026-11-02-sdk-fallback-results.md`. It does not deploy a Worker, activate a scheduled task, migrate data, perform a platform charge or establish production recovery. The new file `tests/compatible-product-fallback.test.ts` uses the current Core and immutable, hash-verified local Node artifacts against synthetic R2, Browser, DNS, webhook and facilitator implementations.

## Reproduced compatibility gaps

The exact earlier candidate `0a7ef80cf210263ced2ba197c8461535c1ac350b` remains evidence, but cannot qualify new Watch operations or newly authored Pilot responses for this expanded release scope. `02-b5-product-fallback-old-repro-2` recorded 8 passes and 7 failures: missing Watch browser usage was coerced to zero; inventory and lease/artifact/final writes lacked the new whole-operation deadlines; and completed current Pilot responses could not replay in the older runtime because their optional economics basis differed. The initial diagnostic additionally had a fixture scheduling mistake: it had not advanced fake time to the prepaid Watch's first due check. Only the fake clock was corrected; no stored lease, quota or evidence was removed.

Primary Pilot recovery now verifies the original response digest and all original page proofs, then tolerates only the exact historical absence of the optional economics basis. It preserves the original response and digest instead of rewriting an old financial claim. `02-b5-product-historical-pilot-1` used the actual old `0a7ef80` binary to create completed and interrupted-final-write negative Pilot orders; both replayed through current/old/current without new observation or settlement. These two filtered cases passed; that result does not qualify the entire old candidate.

The backport also requires bounded Watch registration: a single 20-second view covers metadata and conditional-write readback, and a maximum of three conflicts prevents an indefinitely resolved retry chain from starving timers. Late submitted writes may commit, but cannot emit a late success or grant another quota. Independent source readback of the primary registration and Pilot fixes found no new blocker in those changed regions.

## Scope of the new mixed-runtime suite

Twenty cases cover:

- Current Watch notification retry through fallback and current, with identical event body, identity, signature material, original artifact hashes and prepaid counters; only the next legitimate due slot consumes another check.
- Fallback-authored Watch with unknown browser usage, original outbox promotion and negative deterministic decisions.
- Hanging inventory, original lease/artifact/final writes and registration metadata/conditional writes; deadlines fence continuations while current preserves original unknown state or promotes an acknowledged original result.
- Current Pilot completed negative responses and partial page recovery through fallback/current, including absent browser metrics, observed page drafts and preserved original page hashes.
- Unknown Pilot Browser and settlement outcomes never becoming replacement work or another settlement.
- Synthetic historical no-basis response fixtures plus completed and interrupted orders actually created by the independently pinned old runtime; original response/hash remain unchanged.

The scheduled handler is invoked only as an in-memory function with collected `waitUntil` promises. A fixed noon timestamp excludes the discovery/IndexNow branch. There is no external scheduler or runtime task change.

## Final artifact execution

Exact reviewed fallback commit: `b83abea82b9c12496c6ccb66dc72a00687353cc5`. Its Node artifact is `fallback-extended-node-b5-1/fallback-core.mjs`, SHA256 `275226e0ac304854a38871f9abc4f94283d37a842d883d5894975ee4faa599ee`; the Worker dry-run artifact `fallback-extended-worker-b5-1/worker/index.js` is 968,447 bytes, SHA256 `96adf3678abfc105b0790db6bb2e8d3f8e248f6e13532d6662f00a7ca495bd58`. These paths are relative to the private `DELTA-repair-evidence-20261028` directory. Generator evidence binds exact Git source, dependency lock and local artifact hashes; it is not an independent signed provenance attestation.

`02-b5-product-fallback-final-2` passed **48 tests: 20 Watch/Pilot and 28 Capture/Guard**, with no skipped case. Both suites used that same exact candidate. Historical Pilot cases separately load the immutable `0a7ef80` artifact. The primary working source was stable throughout the test, fingerprint `2d6b391999e4d59cc712049d41c271252637f58a9c4d1804b94823e5019e166e`; Git HEAD at execution was `f5501c2` with the documented local follow-up fixes. Original log SHA256 is `6f72e65c6ca34eb3e69616a7ab447c3591a9233963f93fc94af0b6d48e9175d2`. The product test file SHA256 is `119d5d8e9d7f9482fe98ac3bf4728f2addc9bdc1574763082361a5e9f5e618d2`. `02-b5-product-check-final-1` passed TypeScript; the later fixture-only change is the notification timing correction described below.

The first final run retained one fixture failure: WebCrypto was still completing the independent successful notification when fake time advanced for the hung inventory. The corrected test waits for that original event to be delivered, then advances the inventory deadline and allows bounded asynchronous completion. It still fails against old `0a7ef80` (`02-b5-product-old-inventory-confirm-1`), so no deadline assertion was weakened. The SDK agent independently read all 20 cases and found no actionable blocker within their stated scope; it confirmed that no original lock, quota, hash or response digest is deleted/replaced to obtain a pass.

Exact passing product case names and suggested matrix associations follow. All 20 support G07 and D11-T04's local compatibility component; timing cases additionally support G05. None establishes actual deployment/rollback execution.

| # | Passing case | Additional association |
|---|---|---|
| 1 | current Watch retries one original notification in fallback, then current consumes only the next prepaid slot | D18-T04 |
| 2 | fallback new Watch preserves missing browser usage as unknown and current restores the same event without recapture | D18-T04 |
| 3 | fallback promotes an interrupted current Watch outbox from its original committed check | D18-T04 |
| 4 | fallback bounds a hung Watch inventory while original notification dispatch still completes | G05 |
| 5 | fallback fences a late Watch lease write and current retains original quota and evidence | G05 |
| 6 | fallback fences a late Watch artifact write and current retains original quota and evidence | G05 |
| 7 | fallback fences a late Watch final write and current retains original quota and evidence | G05 |
| 8 | fallback bounds existing Watch registration get before current retrieves the same prepaid record | G05 |
| 9 | fallback bounds existing Watch registration body before current retrieves the same prepaid record | G05 |
| 10 | fallback registration late conditional write remains one original prepaid record for current retry | G05 |
| 11 | completed negative Pilot replays byte-consistent original response across fallback (missing metric=false) | D18-T04 |
| 12 | completed negative Pilot replays byte-consistent original response across fallback (missing metric=true) | D18-T04 |
| 13 | partial Pilot fallback resumes only page two; returning current retains page one negative observation and bytes | D18-T04 |
| 14 | Pilot observed page draft reconciles in fallback and current never repeats that observation | D18-T04 |
| 15 | unknown Pilot page outcome remains unknown across fallback and current without replacement work | D18-T04 |
| 16 | unknown Pilot settlement remains original unknown through fallback and resume with no Browser call | D18-T04 |
| 17 | historical Pilot response without optional economics basis survives (draft=false) | D18-T04 |
| 18 | historical Pilot response without optional economics basis survives (draft=true) | D18-T04 |
| 19 | actual old-runtime Pilot survives current/candidate/current (interrupted final write=false) | D18-T04 |
| 20 | actual old-runtime Pilot survives current/candidate/current (interrupted final write=true) | D18-T04 |

Even after these local cases pass, remote R2 concurrency, Cloudflare scheduling/cancellation, provider billing/payout, secret/configuration bootstrap and actual release/rollback remain external gates. The fallback deliberately lacks the new partner-billing coordinator; the current Actor must fail closed against its absent/disabled capability. Local artifact qualification does not authorize production rollout or establish autonomous revenue.


## Final bounded candidate: 0dbf2b3 (supersedes b83)

The earlier b83/48-case evidence remains historical. The final candidate is `0dbf2b3963ff56641b96e95b8f358591514cb3c4`; current source is `8aa7fbb88e475e01b5bdd31929642646387decbb`. It adds the original-order bounded metadata and conditional-write protections without replacing original records or evidence. The exact final mixed-artifact run `02-b5-final-bounded-compatibility-1` passed **75 cases**, with **1 explicit skip**: 28 Capture/Guard, 20 Watch/Pilot, 14 current read/write boundary cases and 13 fallback read/write cases. The internal artifact helper is not exported by the fallback bundle, so that binary case is explicitly skipped rather than claimed as passing. The final fallback source regression separately passed 550 tests and its TypeScript check.

The run has `source_stable=true`; its log SHA256 is `70516359ebd58e1e4e6919c3abe6d9581264dc03ce971d4d513177fb0b49cd7c`. Exact final Node bundle SHA256: `ad3114c972f4ba6f6083703ed9f51bb7cc866766aa1597c9d7e4304d127c5d22`. Exact Worker: 970861 bytes, SHA256 `1f91f891b611970035fc4539d15e61cc2d0c678a30f213afad29b7af8ff05c90`. The installed Wrangler 4.127.1 was actually run in isolated `--no-bundle --dry-run` mode against that Worker, and its input/output bytes matched. Full paths and command records are attached in `validation-evidence-batch4.json`.

Qualification remains limited to the listed local conditions and unchanged current clients. D16 partner billing coordination is deliberately absent from the fallback: the Actor must refuse unsupported new work. This does not qualify live migrations, provider billing, remote R2 concurrency, publication or production rollback. No source tree was reset and no unknown order, lock, original artifact, signature or quota was removed to obtain these results.
