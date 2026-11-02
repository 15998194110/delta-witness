# D17 / G07 local SDK and compatibility evidence

Local candidate based on d85b367; not a publication, deployment, migration, real payment or production rollback. The sole v1.1 handoff remains authoritative. Tests use synthetic private order capabilities, fixture providers and temporary local storage; they are not customer transactions.

## One Core contract, thin adapters

MCP adds prepare / execute / recover / export tools while retaining its old single-invocation Capture/Preflight tools. The new tools import the shared JS SDK source; build copies those exact bytes into the package and verifies the rewritten import is unique. No second MCP payment state machine was introduced. Existing exact-price payment policy and explicit buyer budget remain. A prepared business UUID and durable `signing_started` marker precede the first payment callback; restarts query Core without signer/budget. The caller must preserve the original UUID. No automatic migration of uncertain legacy calls is allowed.

MCP's private filesystem store uses exclusive revision creation and fsync, not lease expiry or lock deletion. Torn/corrupt records stop payment. Export writes data-only files with exclusive creation; an existing file is accepted only if its size/hash match, using bounded reads even if it grows. Output exposes path/hash/size, never raw captured content or recovery token. Windows ACLs and network filesystem atomicity remain owner/provider responsibilities; these tests do not establish power-loss guarantees.

Python implements the same Core wire API and scoped recovery capability with a private SQLite store (`BEGIN IMMEDIATE`, conditional revision update, synchronous FULL, closed connections). The local record schema is explicitly Python-specific; there is no silent cross-language database conversion. Payment remains a buyer-provided transport; it must enforce budget, exact x402 challenge and one signing attempt, disable redirects and respect the cancellation predicate. The SDK never retries that callback. Python cannot forcibly terminate arbitrary supplied code: eight bounded transport slots prevent unbounded thread growth, and all occupied slots fail closed until completion/restart. Default unsigned httpx uses streaming limits and disabled redirects. Error/output paths omit upstream strings and credentials.

Python export shares the Core endpoint and per-artifact byte limits, hash/length checks and safe data filenames. No wallet key, new custody service or service-side signing logic is added. Missing/expired/unknown status does not mean unpaid. Negative Preflight delivery stays negative.

## Executed package checks

Private evidence folder remains `DELTA-repair-evidence-20261028` next to the repair worktree. Command JSON includes source fingerprint, source stability, timestamps, exit code and original log SHA. Diagnostic runs are retained; later package builds below supersede earlier package hashes.

| Evidence label | Actual result |
|---|---|
| `02-b4-sdk-mcp-review-3` | 50 tests pass, including bounded existing-export growth and persistent original-order recovery |
| `02-b4-sdk-python-review-4` | 19 tests pass, including actual httpx MockTransport, four-process SQLite CAS and actual subprocess restart recovering via GET with no second paid callback |
| `02-b4-sdk-mcp-pack-final` | TypeScript check, 50 tests, build and local pack pass |
| `02-b4-sdk-mcp-archive-final` | All 10 archive files exactly match local source/build; bundled JS SDK exactly matches shared source |
| `02-b4-sdk-mcp-smoke-final` | Extracted package starts in memory, lists eight actual tools and performs one unsigned mocked quote |
| `02-b4-sdk-python-build-final` | Wheel/sdist three module files byte-match source; wheel is imported directly and uses installed httpx with mocked transport |

MCP tarball SHA256: `1f3c476e576ac5357a7b0c4e9154d478bfdda07283dec1a57bd8d95b532e7310`.
Python wheel SHA256: `c078d9947d811d1e2e7fb2fac15d732628d394bbf5c2386d9286273e97e88e96`.
Python sdist SHA256: `34099cb6f4d86dabc59f7348055fec01df9e9bd82beb9200314b58b9b8e8b7d7`.

The Python runtime/build wheel dependencies were installed only into the private evidence folder with `--only-binary=:all: --no-deps --isolated`: httpx 0.28.1, httpcore 1.0.9, anyio 4.11.0, certifi 2025.10.5, idna 3.11, sniffio 1.3.1, h11 0.16.0, hatchling 1.27.0, packaging 25.0, pathspec 0.12.1, trove-classifiers 2025.9.11.17, pluggy 1.6.0, build 1.3.0, pyproject-hooks 1.2.0. This is a pinned validation environment, not a change to production dependency resolution. No source-distribution setup hooks were installed. Python tests/build block socket construction; the Node preload alone does not constrain Python. No registry publication or clean remote install is claimed.

Independent accounting agent reviewed Python/MCP implementation and requested two corrections: strict proof UUID/optional response types, and bounded reads when an existing export grows. Both were implemented with regressions and read back. The review is local source/fixture evidence, not real provider or OS ACL qualification.

## Exact prior Core compatibility exercise

`scripts/build-compatible-fallback.mjs` reads exact d85b367 Git source into a fresh private output directory and compares the parsed lockfile with that commit. The original Git lock and Windows checkout byte hashes are recorded separately because of line endings. It does not checkout/reset or modify the original repositories.

`fallback-d85-b4-3/build-evidence.json` records 23 exact source file hashes and the isolated Node-bundled artifact SHA256 `8ca0d0233f12fac4ea15ead231965741437944679fcdc9c3754a384372995987`. This is a Node test artifact, **not a deployable Worker or authorization to roll back**.

`02-b4-fallback-test-2`: ten opt-in tests passed. Current Core creates Capture/negative Preflight orders; d85 reads or recovers them, then current Core resumes with the same in-memory R2. Cases cover completed/interrupted-final-write, known/missing browser cost metric, unknown settlement and retention expiry. Original artifact hashes stay unchanged. Recovery makes no further settlement or Browser calls. Unknown settlement remains unknown and expired raw export stays denied; objects remain present. These are instance/module switches in synthetic storage, not real Cloudflare deployments or power-loss tests.

Failed diagnostics were retained: strict raw lock bytes initially differed by checkout line endings; browser-target isolated bundling could not resolve a Node `url` dependency; an initial test incorrectly expected `changed=true` for a Preflight with no prior observation. The corrected assertion preserves the actual original `changed=null`, `safe=false`, `expectation_failed`; no production semantics were weakened.

This qualifies only the listed local Capture/Preflight compatibility cases. The old unmodified 455f7be remains prohibited as a fallback. Full Worker Watch/Pilot/partner behavior, new telemetry migration, actual regional concurrency and approved rollout/rollback artifacts still require their separate evidence. Retaining current adapter packages while reverting Core is a concrete candidate strategy, not an executed release. New package versions, Core configuration and external registry/discovery synchronization remain pending approval/release validation.

## Follow-up independent review and refreshed package evidence

Source review identified a real retention regression: a settled scoped order whose original Browser call failed could be retried with its original payment after settlement-based raw retention expired. Status correctly reported expiry, but the signed retry captured again and returned 200. `02-b4-sdk-review-expired-retry-1` preserves the failing reproduction. Root corrected the authoritative policy gate before capture preparation/retry claim and checked the handler again. The same original payment without capability headers must not bypass its journal's purchased terms. `02-b4-sdk-review-expired-retry-2` passes both cases; no second settlement, Browser call or storage change occurs. The retained regression is `tests/review-retention-retry.test.ts`.

Review also found that repeatedly recovering an already-completed SDK record wrote a new revision every time. In Base App, cross-tab storage listeners can turn unnecessary writes into repeated status traffic; in MCP they consume bounded append-only revisions. JS and Python now leave an already-complete revision unchanged while still querying Core. `02-b4-sdk-js-completed-read-review-1` passes 43 tests, and `02-b4-sdk-python-review-5` passes 20 including zero-write repeated recovery. This is an isolated storage/callback regression, not a claim of a multi-tab browser session qualification.

An additional pre-existing gap in scoped enrollment read metadata directly before the bounded status/recovery path. Root applied a fresh bounded snapshot and 15-second deadline before payment middleware. `02-b4-enrollment-bounds-review-1` passes three regressions in `tests/review-enrollment-bounds.test.ts`: stalled R2 get, stalled metadata stream and a misdeclared body exceeding the actual-byte limit. All fail closed before payment/Browser work, cancel late bodies and leave stored objects untouched.

The following refreshed artifacts supersede the earlier hashes above:

| Evidence | Result |
|---|---|
| `02-b4-sdk-mcp-pack-reviewed` | Typecheck, 50 tests, shared-source build and local pack pass |
| `02-b4-sdk-mcp-archive-reviewed` | 10 archive files equal build/source; shared SDK bytes equal current JS source |
| `02-b4-sdk-mcp-smoke-reviewed` | Extracted package starts, lists eight tools, mocked unsigned quote passes |
| `02-b4-sdk-python-build-reviewed` | Wheel/sdist source equality, direct wheel import and installed-httpx mocked quote pass |

Reviewed MCP archive SHA256: `1fa00d1823a6652aa0736c17f5cf84ee9d0ed7c479ede13cf06310ea132ec95d`.
Reviewed Python wheel SHA256: `4d99fcf7bf8f68d80a651f8069fecc7db282e1c17f45b77c94a1a3a4a9983835`.
Reviewed Python sdist SHA256: `f28f0f0078b6bc9a7bbcfc81d64e0415bd4f5b1f70554bcd97c4553cf914a4b8`.

Watch source/fixture review covered nested metadata bounds, the 50-second whole-check budget within its 60-second lease, late Browser body disposal, fences after submitted storage writes, count-bounded inventory, concurrent notification processing and partner-owned terminal status. No new blocking defect was identified in that inspected scope. Already-submitted provider writes can still commit after local cancellation; original leases/outbox records must be reconciled. The review is not evidence of remote cancellation or provider-region behavior.

## Exact d85 Worker build and its qualification limit

`scripts/build-worker-fallback.mjs` additionally built exact d85 as a Worker module using already installed Wrangler 4.127.1. It extracts 26 Git source/config/package files into a fresh directory, verifies lock-content equality, rejects unreviewed config features, reuses the existing dependency tree without install hooks, and invokes only `deploy --dry-run`. The CLI inherits the outbound-deny preload; metrics are disabled and a separate `os.homedir`/XDG location avoids the owner's saved Wrangler configuration. No credentials are copied. The reviewed CLI dry-run branch skips migrations, asset upload, resource provisioning and Worker upload.

`02-b4-fallback-worker-build-1` passed and the saved CLI log confirms `--dry-run: exiting now.`. `fallback-worker-d85-b4-1/build-evidence.json` ties source hashes, lock hashes, CLI version, build-log hash and artifact hashes together. Its Worker module is 958,957 bytes, SHA256 `74ed31347c3212d4909ab0c873ded25c0ac5d5594822aa0b8253b3e910691902`; the source map is retained separately. This is auditable local build evidence, not an independently signed provenance attestation or a deployed version.

The outer runner observed concurrent changes elsewhere in the current working tree during that Worker build (`source_stable=false`). The build inputs themselves came from the fixed immutable d85 Git blobs, not those modified working files. Do not describe that run as a stable whole-worktree test; use its extracted input hashes and build log. The refreshed MCP package run separately recorded `source_stable=true`.

**Unmodified d85 is not an approved fallback for this release:** its earlier ten passing compatibility cases do not cover the newly identified expired signed-retry defect. That invariant requires an explicitly reviewed backport candidate and fresh evidence. The exact old public config also does not enable scoped-order TTL/retention; future authorized deployment must preserve compatible original-order settings and bindings. Worker-compatible build success does not establish full Watch/Pilot/partner rollback safety or actual Cloudflare acceptance.

Both local build generators now optionally accept a third argument containing an exact reviewed 40-hex local commit; branch names and implicit HEAD are rejected. The default remains d85. The compatibility suite can bind that same exact commit through `DELTA_FALLBACK_REVIEWED_COMMIT`, alongside the generator evidence path; it checks schema, Node platform, source inventory and artifact hash. These options allow a separately reviewed backport artifact without checking out or overwriting the primary worktree. They do not establish review/approval merely because a caller supplies a hash.

## Reviewed minimal fallback candidate

The separate local fallback worktree contains commit `3a91f4d8411913d6638ea7d618878f14f2cd9be7`, based on d85. Its five-file diff was independently read: two source files backport original purchased-retention enforcement, bounded enrollment, and preservation of existing scoped credentials when new enrollment is disabled; three test files exercise these boundaries. It does not replace the main repair worktree or remove any original object. The unmodified d85 artifact above remains disqualified.

| Evidence | Actual result |
|---|---|
| `02-b4-fallback-backport-node-build-1` | Exact candidate Git blobs, 23 source files, lock-content equality and Node build pass |
| `02-b4-fallback-backport-worker-build-1` | Exact candidate Worker build using isolated offline Wrangler dry-run; no uploads |
| `02-b4-fallback-backport-compatibility-2` | 23 mixed-runtime tests pass against the recorded Node artifact |

Node artifact: `fallback-backport-node-b4-1/fallback-core.mjs`, SHA256 `8f542fe668a6ee2a8c6552b0843e066240b1816ee922af0b697fc8bd323be8a3`.
Worker artifact: `fallback-backport-worker-b4-1/worker/index.js`, 961,245 bytes, SHA256 `173227d1b1bf752b0d3ce7aad38d8486055388933e0683cb2d4ffb2c2a3dda75`.
The adjacent `build-evidence.json` files bind these outputs to exact source/lock hashes and the reviewed local generator run, not to independent signed build provenance.

Current Core creates the original orders, the recorded fallback reads/replays/recovers them, and current Core resumes against the same synthetic storage. Coverage includes Capture and negative Guard; completed and interrupted final writes; unknown settlement; missing browser metrics; raw export expiry; expired original signed retries both with and without capability headers; disabled current enrollment TTL preserving original complete/draft orders; stalled get/metadata bodies and actual-byte overflow before any payment; completed replay under a malformed current retention proposal. Original artifacts remain unchanged, unknown settlement stays unknown, and prohibited second payment/capture never occurs. A diagnostic run is retained: two initial assertions incorrectly prohibited the harmless mocked `GET /supported` needed when current Core resumes an unpaid 402 request. The assertions were narrowed to allow only that support lookup, while still prohibiting settlement and Browser work.

This is a **locally qualified Capture/Guard fallback candidate for the tested conditions with current adapters retained**, not authorization or evidence of an actual rollback. It does not qualify Watch, Pilot, newly introduced partner billing coordination, remote storage concurrency, configuration migration, or Cloudflare deployment. The old candidate lacks `delta-partner-billing/v1`, so the new Actor must fail closed against it. Preserve original purchased policy, recovery credentials, storage bindings and compatible configuration during any separately authorized release. The exact old public config alone is not a safe operational rollout recipe.

## D16 local original-business billing coordination

`src/partner-billing.ts` coordinates the platform billing attempt on the existing original fulfillment record and ETag CAS. No second ledger or capture/payment engine was introduced. The trusted partner/user plus stable business ID resolve one Core identity across Actor runs. The first successful reservation records `charge_unknown` before releasing a single permission to invoke the platform SDK. Neither lost storage/HTTP acknowledgements, another run, nor another attempt ID grants it again. The Actor queries capabilities and original status before new work; an older or disabled Core fails closed. The feature flag has no production default and was not enabled by this repair.

The original verified proof is saved as `OUTPUT` before billing; a negative Guard observation is still a complete delivery. A successful adapter acknowledgement can mark only `platform_charged` with `partner_adapter_assertion_only`. Settlement, Treasury receipt, payout and revenue remain null. Recovery restores original OUTPUT without another dataset append, payment or capture. Unknown legacy run records are preserved and cannot silently become new business orders. Asynchronous platform operations are bounded to 30 seconds, gateway headers/body to 120 seconds and 1 MiB. An uncooperative provider operation may still complete after timeout, but its late result cannot resume Actor billing/delivery continuation or reset the original reservation.

`02-b4-partner-billing-check-2` passed TypeScript. `02-b4-partner-billing-test-4` passed **57 tests** across adapter fault cases and the actual Core → Gateway → Actor contract with synthetic provider/storage implementations. Cases include two Actor runs, twelve racing reservations, identity/payload conflict, original negative Guard and hashes, missing original digest, lost reservation/charge/confirmation acknowledgements, late reservation writes, hanging SDK input/storage/charge/dataset/exit, late charge acknowledgement, pre-charge OUTPUT interruption, disabled/old capability, budget/PPE/default dataset price, no x402 settlement and no new financial object namespace. Independent review prompted a delivery allowlist and optional-field type validation; a valid proof with extra secret-like fields is stripped before OUTPUT/dataset/logs on both initial and recovering runs.

The Actor uses the installed Apify 3.7.2 SDK's actual `charge({eventName,count})` and `calculateMaxEventChargeCountWithinLimit`, without inventing an idempotency option. Its default dataset-item event must be unpriced. Tests do **not** demonstrate provider internal charge retry semantics, final billing readback, real platform prices/fees, net payout, account KYC/authorization or publication. Those are external qualification gates; there was no real platform charge, outbound registration, deployment or revenue claim.

## Earlier Capture/Guard fallback candidate including D08

The earlier Capture/Guard-only fallback is **`0a7ef80cf210263ced2ba197c8461535c1ac350b`**, a child of the interim `3a91f4d` candidate above. Its additional three-file diff was read independently. New captures now reject empty or whitespace-only HTML/markdown even with a valid PNG. The historical artifact reader retains its original contract, including a correctly hashed zero-byte markdown artifact. The interim candidate's 23 cases did not qualify this new D08 invariant. The later extended candidate below supersedes both for the expanded local test scope.

| Final evidence | Result |
|---|---|
| `02-b4-fallback-final-node-build-1` | Exact `0a7ef80` Git source, locked dependencies and Node artifact built offline |
| `02-b4-fallback-final-worker-build-1` | Exact `0a7ef80` Worker dry-run completed offline with zero uploads |
| `02-b4-fallback-final-compatibility-2` | **28 mixed-runtime cases pass**, including the 23 earlier cases plus D08 rejection/historical export |

Final Node artifact: `fallback-final-node-b4-1/fallback-core.mjs`, SHA256 `54be64775a1c1f5f5ff559cf224f06ed4333311649e5ec48ce924856dd3c64a2`.
Final Worker artifact: `fallback-final-worker-b4-1/worker/index.js`, 961,272 bytes, SHA256 `9d768956c86b2e2a6408f0f30b7a0dcd2e973200deae9ca455f21ed6245f2cb5`.
Worker map SHA256: `c61ddb08c918068719240735baec2579a8e2b3c856344ee3b0a0fceb2923bf27`.

The four new blank HTML/markdown Capture/Guard cases verify failed delivery cannot produce a success manifest; current Core preserves the same blocked original without a second settlement, Browser call or storage change. The historical export case assembles self-consistent synthetic old evidence before the compatibility boundary, then verifies both runtimes return its exact zero bytes and hash without writes. No real existing proof was altered. Initial diagnostic failures remain recorded: the test first incorrectly expected a blocked incomplete capture to retry automatically, and its historical fixture hashed the previous bundle root into the new root. Only these test errors were corrected; neither runtime's safety or historical validation was weakened.

The qualification remains **local Capture/Guard compatibility under these exact tested conditions, with current client adapters retained**. It is not a full Watch/Pilot/partner rollback, actual Cloudflare rollback, release authorization, or live acceptance. New D16 Actors fail closed against this older Core because its billing capability is absent. No deployment, migration, deletion, payment or provider activation was performed.

## Extended local fallback candidate for Watch and Pilot

The interim extended fallback is **`b83abea82b9c12496c6ccb66dc72a00687353cc5`**, a child of `0a7ef80`. This is a safety backport, not an unmodified historical binary: it adds the reviewed Watch whole-check/inventory/body/deferred-write bounds; finite, bounded registration CAS and recovery; strict absent-browser-usage handling; original Pilot response compatibility; shared 15-second metadata reads; and isolated 1-second diagnostic writes. It preserves the existing capture/pricing model rather than importing the primary release's full new retention-pricing policy. The final write-boundary candidate below supersedes it.

The expanded tests first rejected the old `0a7ef80` candidate: Watch inventory and late writes were not bounded, missing Browser usage became zero, and new Pilot responses failed the old aggregate equality check. The old artifact remains available only to create actual historical Pilot records in the fixture. It is not qualified for the extended rollout scope. The Pilot backport permits only the absence of the new optional economics basis field after independently verifying the original response digest and page evidence; every other field remains exact, and stored response/hash bytes are preserved.

| Evidence | Actual result |
|---|---|
| `02-b5-fallback-shared-final-check-1` | Fallback TypeScript check passes, stable source fingerprint |
| `02-b5-fallback-shared-final-full-1` | **536 tests pass, 1 explicit opt-in skip**, stable source fingerprint |
| `02-b5-fallback-extended-node-build-1` | Exact `b83abea` Git source and unchanged locked dependencies build offline |
| `02-b5-fallback-extended-worker-build-1` | Exact `b83abea` Worker dry-run passes, isolated configuration, zero uploads |
| `02-b5-product-fallback-final-2` | **48 mixed-runtime cases pass**: 28 Capture/Guard and 20 Watch/Pilot |

Node artifact: `fallback-extended-node-b5-1/fallback-core.mjs`, SHA256 `275226e0ac304854a38871f9abc4f94283d37a842d883d5894975ee4faa599ee`.
Worker artifact: `fallback-extended-worker-b5-1/worker/index.js`, 968,447 bytes, SHA256 `96adf3678abfc105b0790db6bb2e8d3f8e248f6e13532d6662f00a7ca495bd58`.
Worker map SHA256: `35822081dda23abd849d48edae56a5129cf331ed3c17560e10c665d59c80e61d`.
Both adjacent build manifests bind exact Git inputs, lock hashes and output hashes to the audited local generator runs. These are local integrity records, not independent provenance attestations or provider deployment receipts.

The new mixed cases exercise current → candidate → current with original synthetic storage: racing notification dispatch; original signed webhook retry; interrupted outbox promotion; prepaid quota preservation; absent usage metrics; hung inventory; late lease/artifact/final writes; stalled or late Watch registration; complete/negative, partial, observed-draft, unknown-page and unknown-settlement Pilot recovery. Two additional fixture paths actually run the earlier `0a7ef80` binary to create completed/interrupted-final-write Pilot records before current/candidate recovery. The tests preserve artifact hashes and original response digests and prohibit another settlement or repeat observation of completed pages. One test scheduling correction waits for independent successful WebCrypto before advancing the inventory deadline; the corrected test still rejects the old binary.

This qualifies **only the listed local Capture, Guard, Watch and Pilot compatibility cases with current adapters retained**. The new partner billing feature is not backported; new Actors fail closed against the absent capability. Remote concurrency, provider cancellation, Cloudflare upload/activation and actual rollback remain outside this evidence. The additive telemetry columns must be retained: an old D1 schema produces a bounded diagnostic failure, not accepted telemetry or a new financial truth. Original policy/TTL settings, credentials, storage bindings and original unknown records must be preserved by a separately authorized release. No real deployment, migration, deletion, payment or scheduled-task activation occurred.

## Actual Wrangler no-bundle byte equality

`02-b5-fallback-no-bundle-equality-1` exercised the installed Wrangler 4.127.1 CLI against the exact `b83abea` Worker artifact with `deploy <original index.js> --no-bundle --dry-run`. The process inherited the outbound network guard, had metrics disabled, used a new private home/XDG directory and the original public extracted config, and copied no credentials. A fresh output directory retained the CLI log and result; no upload or migration occurred.

`fallback-extended-no-bundle-b5-1/evidence.json` records identical input/output Worker bytes: 968,447 bytes, SHA256 `96adf3678abfc105b0790db6bb2e8d3f8e248f6e13532d6662f00a7ca495bd58`. The original artifact and config remained byte-identical. This demonstrates local CLI payload preservation for the reviewed release helper's no-bundle path, beyond an injected-runner argument assertion. It is not a receipt for a provider upload or proof that a deployed endpoint runs those bytes.

Independent review of `scripts/verified-cloudflare-artifact.mjs` prompted two fixes before freeze: replace an incomplete Wrangler config denylist with exact Core/Gateway key allowlists, and permit the actual Pages `js.map`/`css.map` filenames. The resulting helper records bounded public files and metadata, rechecks lock/config/CLI version and hashes before the authorized callback, submits the recorded payload without rebuilding, and does not retry an unknown submission. The workflow now downloads the same verified Core/Gateway/Pages artifacts; Pages includes the hidden signed manifest path. Source identity is bound by the checkout/approved workflow context and the manifest, not independently attested by the helper. Concurrent malicious modification of the trusted CI filesystem and real provider behavior remain outside its guarantee.

## Final original-write boundaries and exact fallback

The current local fallback is **`0dbf2b3963ff56641b96e95b8f358591514cb3c4`**, a clean separate-worktree commit following `b83abea`. The earlier candidate lacked a necessary direct-request boundary. `02-b5-critical-write-repro-1` recorded two real failing tests: the original settlement reservation and first fulfillment claim remained pending after 15 seconds, and their late acknowledgements resumed work. Both primary and fallback now use the same bounded write primitive for claims, settlement reservation/confirmation/diagnostics, immutable order binding and immutable artifacts. An uncertain write never means absence, never grants a retry/lease reset, and may still commit only the originally submitted value. Its caller cannot continue into a new settlement, Browser operation, final manifest or completion transition.

An uncertain confirmation/binding write no longer triggers a racing failure-journal overwrite. The facilitator reports original `settlement_unknown`; a late confirmation is preserved for read-only reconciliation. Immutable artifact conflicts and direct legacy draft recovery use the same actual-byte bounded snapshots. General order metadata still defaults to 32 KiB with a 256 KiB maximum override; prior-proof manifests use their distinct, UUID-scoped 1 MiB allowance. Original missing/expired/invalid evidence never becomes permission to capture again.

`02-b5-critical-write-fixture-check-1` passed **78 tests** across the 14 new late-write/read cases and original artifact, Watch and Pilot suites. Initial diagnostic failures were retained. Two immutable unit fixtures were upgraded to a real proof UUID and streamed R2 object; the original Pilot whole-budget test was changed to use individual operations below their stricter new limits while still expiring the 90-second overall budget. Its late-phase prohibition remains intact. Independent review confirmed these changes do not weaken the original invariants.

The exact fallback passed `02-b5-fallback-write-boundaries-full-2`: **550 tests, 1 opt-in skip**; typecheck passed again at the committed identity in `02-b5-fallback-final-check-1`. The subsequent test-only parameterization adds an opt-in execution of HTTP boundary cases through the recorded candidate module; it does not change runtime code. The internal store helper is not exported by the Worker entrypoint, so its candidate variant is explicitly skipped there and covered by the candidate's full source suite instead of falsely labelling a current-source call as a fallback call.

| Final exact artifact | SHA256 |
|---|---|
| `fallback-bounded-node-b5-1/fallback-core.mjs` | `ad3114c972f4ba6f6083703ed9f51bb7cc866766aa1597c9d7e4304d127c5d22` |
| `fallback-bounded-worker-b5-1/worker/index.js` (970,861 bytes) | `1f91f891b611970035fc4539d15e61cc2d0c678a30f213afad29b7af8ff05c90` |
| `fallback-bounded-worker-b5-1/worker/index.js.map` | `9e82a45a3917120be00563c98087f6e56d595743864631f33b4e5679b018ae93` |

Exact Git build evidence is in `02-b5-fallback-bounded-node-build-1` and `02-b5-fallback-bounded-worker-build-1`. `02-b5-fallback-final-no-bundle-equality-1` independently ran the actual installed Wrangler CLI with `--no-bundle --dry-run` on this final Worker file: output is byte-identical to the 970,861-byte input and both retain the SHA above. The public config and original artifact remained unchanged; fresh isolated home, outbound network guard and zero uploads were recorded in `fallback-bounded-no-bundle-b5-1/evidence.json`.

`02-b5-final-bounded-compatibility-1` then exercised the final exact `0dbf2b3` Node artifact against primary `8aa7fbb88e475e01b5bdd31929642646387decbb`: **75 tests passed, 1 explicitly skipped internal-helper variant**, with `source_stable=true`. This combines 28 Capture/Guard mixed cases, 20 Watch/Pilot mixed cases, 14 current-runtime critical boundaries and 13 candidate-runtime HTTP critical boundaries. The historical fixture still uses the recorded `0a7ef80` binary solely to create genuinely old Pilot responses before recovery. The log SHA256 is `70516359ebd58e1e4e6919c3abe6d9581264dc03ce971d4d513177fb0b49cd7c`. Thus the final candidate, rather than only its interim parent, has actual mixed-runtime and late-acknowledgement evidence.

Earlier `d85`, `3a91f4d`, `0a7ef80` and `b83abea` artifacts remain historical evidence only and must not be substituted for this final qualified scope. All release, provider, configuration, D1 additive-schema, D16 capability and live-acceptance limitations stated above still apply. This work did not activate any runtime or submit a production transaction.
