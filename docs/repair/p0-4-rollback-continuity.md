# P0-4: rollback fulfillment continuity, local qualification

Date: 2026-11-04 Asia/Shanghai. This is local preparation, not a production acceptance or deployment authorization. No deployment, remote D1/R2 access, paid request, wallet signature, customer data, secret, or external message was used. All payment and browser responses in the drill are synthetic local fixtures.

The compatible rollback composition can continue the existing, bounded paid-draft recovery consumer while retaining the original `0dbf2b3` product handler. Native process termination, uncertain completion acknowledgement, R2 read outage, and D1 write outage were exercised. Complete-proof Capture and Preflight, existing priority enrollment/drain, unknown settlement preservation, and a pre-proof fail-closed boundary were qualified locally. The pre-proof liability remains unfulfilled. This does not close the full paid-obligation inventory or make original `0dbf2b3` a continuity-capable rollback version.

## Final exact candidate qualification

The final matrix below supersedes earlier baseline/comparison runs for the current local candidate. It uses exact committed source **`19b43f5a996e743997ffafa4db125207c20485a4`**, candidate `P0-candidate-worker-final-1/worker/index.js` SHA256 **`325b91e3fe4b1e141035fc2c447ea6eaa3affc96a26827a9bcf49e1023c26bbf`**, unchanged original `0dbf2b3`, and corrected compatible rollback `P0-4-compatible-build-2/worker/index.js` SHA256 **`2ac5253c6009ae28318525e58e391ae37cffb1cca8229fab3256c5b5d76e6948`**. Candidate manifest SHA256 is `e44bf2c4a94a50c59cf3cbea15d8bb8540c3f87036ff2bfa53f40903f28f04ed`.

All six runs finished with exit code 0, `source_stable: true`, `qualification_inputs_stable: true`, and identical source fingerprint **`2e0e43f1dce91a5a428e71fd6665fd6de5767a7d793fd13422862a139f9474a7`**. The fixed harness SHA256 is `339600e3ed18fd80f87b1169c3c955d03195f2aa64aa11b95e752987549bd9fc`. There were **34 independent native processes and 46 check groups** in this matrix. Each run has its own untouched R2/D1 persistence directory, phase logs/readbacks and exact input hashes.

Result paths below are relative to `C:\Users\10122\Documents\ChatGPT\DELTA-production-readiness-20261104`; matching offline runner JSON/log/source snapshots are in `C:\Users\10122\Documents\ChatGPT\DELTA-cloud-operations-20261103` under the same run label.

| Final result | Scope | Result SHA256 |
|---|---|---|
| `P0-4-final-capture-1/result.json` | Capture crash/ACK crash, old/fallback/forward compatibility, R2 and D1 outage/resume | `c90126515b2bc08ce2f8d45ae216fa9deb9ca3c672be0b1100dbda2fcf907c9f` |
| `P0-4-final-preflight-1/result.json` | Same sequence, original 5-USDC terms and negative Preflight decision retained | `2cabbfaaf40c8ba4b573f34d70332e882c505090b6eb3db7f7ff6f01b76f8f17` |
| `P0-4-final-priority-1/result.json` | Actual unfinished-response enqueue, native fallback priority drain, durable resolution | `77d1262b9bbe94a87da3621f40ee85d9423dfc48a0732e79c2983dbf3ed84373` |
| `P0-4-final-unknown-1/result.json` | Original unknown reservation retained; no further verify/settle/browser; payment exposure unresolved | `bae4e18444939132ddbfd61620103be9969be44241907c21984d4113f538d747` |
| `P0-4-final-preproof-1/result.json` | Native crash before artifact storage; original liability/metadata retained; fulfillment remains incomplete | `ea696f6781f50a104677b3decce4a2de9092a41ccbb396a2be060f0562dc7aa7` |
| `P0-4-final-post-1/result.json` | Native HTTP and dispatch zero-byte POST acceptance; original completion exactly once; payload/signature/capability rejection | `f721a1b147d5d0b0eebac534adec37bf2714d46593b22f1fc8d541523a7a92d7` |

These are local native-runtime qualifications with synthetic facilitator/browser transports, no real payment and zero external forwarding. The original proof/order/settlement/idempotency identities and bytes remain authoritative. Unknown payment is not declared rejected or confirmed; pre-proof artifact loss is not declared fulfilled; D1's two injected failed telemetry writes remain incomplete and unreplayed; actual costs and financial totals remain unknown. Production version IDs, bindings, provider delivery and the production observation window are not accepted by this matrix. Full P0-4 closure remains blocked by the retained pre-proof liability and coverage/external gates detailed below.

## Code and exact composition

`src/rollback-continuity.ts` preserves the older handler's fetch reference and original scheduled lanes. On the existing fifteen-minute Cron, and only when both existing operations/recovery flags are already true, it schedules `scheduledPaidOrderRecovery`. It schedules that promise before calling the older scheduled handler, so an unrelated older lane throwing cannot prevent recovery from starting. A degraded recovery rejects its scheduled promise. It does not capture again, charge, change an order ID, delete evidence, enable a flag, or add a trigger.

`tests/rollback-native/build-continuity.mjs` creates a fresh external build directory and composes:

- Product source, config, lockfile, generated types and supporting validator from exact `0dbf2b3963ff56641b96e95b8f358591514cb3c4`.
- `paid-order-recovery.ts`, `paid-recovery-priority.ts`, and `paid-recovery-control.ts` from exact `149c302d278ce83c9faeae4d058f318777a97e0c`.
- The local adapter, SHA256 `d62be49e6a4de28ecc8ad62221b65f8b2b0c62c4458d2fac2fbce1963e13cb64`.
- A build-only default-handler composition entry. The copied config changes only `main`. Two optional type declarations are added to the copied older `RuntimeEnv`; no runtime flags change. The installed dependency lock must equal the reviewed older lock.
- Composition build 2 also transplants the identical zero-byte recovery-input guard described below into the original older `orders.ts`. It does not replace that file with the newer product implementation. Build 1 remains historical evidence.

The builder runs Wrangler dry-run behind the existing offline runner. It does not edit an existing worktree, shared `src/index.ts`, repository Wrangler config, package files, deploy allowlists, or the exploratory `76ef4fc` history. This composition is a local qualification artifact, not a provider version ID or an approved deployment package. A later exact release package needs its own reviewed manifest and qualification.

Evidence root: `C:\Users\10122\Documents\ChatGPT\DELTA-production-readiness-20261104`.

| Artifact | Exact identity |
|---|---|
| Baseline candidate `candidate-worker-final-1/worker/index.js` | commit `28bbdb36f17ae0ab34b49edb39e0372beca0d284`; SHA256 `eab28d67e0b1d198659c7607a960c220b3c41ec708937fe4f095b94aab28f989` |
| Original older Worker `rollback-original-worker-1/worker/index.js` | commit `0dbf2b3963ff56641b96e95b8f358591514cb3c4`; SHA256 `1f91f891b611970035fc4539d15e61cc2d0c678a30f213afad29b7af8ff05c90` |
| Compatible composition `P0-4-compatible-build-1/worker/index.js` | SHA256 `3cd9c58cd33bf2fe1dd01137c521f3bdb5dd1e48e642c771b38d9a83039d917a` |
| Composition manifest `P0-4-compatible-build-1/build-evidence.json` | SHA256 `1ba239230411391d20bb936fd9b3d0bf44f6ac0ba9b9b35bbe0b90ba06f3e746` |
| Earlier baseline native result `P0-4-native-drill-9/result.json` | SHA256 `2fdde9c557367c197bc1a1bc66f9754db352ba38c346694549a98b7aeade4fb8`; expanded final matrix below |

This earlier candidate table refers to the baseline artifact, before the integrated P0 work. `149c302` adds the prior readiness documentation to that code. The integrated `19b43f5` candidate was subsequently built and rerun through all six scenarios in the final matrix above.

## Native process and storage evidence

`tests/rollback-native/process-drill.mjs` loads the unchanged exact bundle bytes into installed Miniflare `5.20260828.0-alpha` / workerd `1.20260828.1`. The fault wrapper is a separate module. The child process permits only loopback sockets; native outbound requests terminate in an explicit local fixture allowlist. Unexpected egress throws. Credentials and inherited Node preload options are removed from child environments; the dedicated local network guard remains active. The source harness, both migrations, three bundles, configs and build manifests are hashed before and after the run. Every stage additionally verifies its bundle against its manifest.

Each stage uses a new Node process and native workerd process with the same local persistent native R2/D1 directory. The two crash checkpoints read the storage back, then the parent forcibly kills the actual workerd PID; they do not merely dispose a mock or gracefully stop the runtime.

| Stage | Actual native PID in baseline run 9 | Verified result |
|---|---:|---|
| `seed-crash` | 4804, forcibly killed | Actual candidate Core processes synthetic settlement and Capture. Original draft and all proof writes are durable; process stops before final complete CAS. Seven original business objects exist. |
| `old-no-consumer` | 13180 | Exact `0dbf2b3` retains the pending obligation and all bytes but does not complete it. This confirms why preserving data alone was insufficient. |
| `failed-new-start` | 21048 | Deliberately injected startup error is verified by its marker. The next stage reads unchanged persistent storage. This is a local startup failure, not a real deployment failure. |
| `storage-down` | 40868 | Injected R2 `get/list` rejection makes the recovery promise degraded/503. No original object is cleared or changed. |
| `recovery-ack-crash` | 36632, forcibly killed | Compatible fallback performs the original complete CAS once. Process stops after native storage commits but before the write acknowledgement reaches the consumer. |
| `fallback-resume` | 34200 | A fresh process and next Cron slot reads the same completed obligation, performs zero additional completion writes, and returns complete order status plus successful original signed replay. |
| `d1-down` | 35064 | Original telemetry writer attempts two native D1 writes and receives injected rejection. Completed order/replay still succeeds, all business bytes remain unchanged, and original D1 rows are retained. |
| `d1-resume` | 35204 | A fresh process removes the fault. Original telemetry writer successfully adds and reads two rows from the same native D1 database. |
| `forward-readback` | 39252 | Baseline candidate reads the same completion and returns the same original proof/bundle on idempotent replay. No charge, capture or completion write repeats. |

The initial synthetic call settles once and captures once. All later stages make zero facilitator verify/settle calls and zero browser calls. The original order, settlement, proof and artifact hashes remain unchanged. The fulfillment changes only `state` and `updated_at`; original fingerprint, paid price, attempts, proof response and response digest remain identical. Original idempotency/payment identity is retained. The injected signature header consists of dummy fixture bytes; no cryptographic signing or asset movement occurs.

Native D1 uses local migrations `0001` and additive `0002`. Three initial rows survive every process. Fallback readback increases the row count to 5, D1 outage leaves it at 5, restored native writer increases it to 7, and forward readback increases it to 9. The two rejected telemetry writes are **not replayed**. `result.json` explicitly preserves `telemetry_gap.completeness: incomplete`, `replayed: false`, and financial totals `unknown`. This proves subsequent database operation and paid replay recover; it does not prove telemetry completeness or reconstruct missing actual costs. R2 original business evidence is independent of that D1 telemetry gap.

Per-stage `process.log`, `state.json`, injection module, expected startup-failure record, and buyer readbacks are under `P0-4-native-drill-9`. They contain only synthetic fixtures. No private production proof is copied into this report.

## Validation and reproduction

Existing offline runner: `C:\Users\10122\Documents\ChatGPT\DELTA-cloud-operations-20261103\Run-CloudCheck.ps1`. Its JSON/log/source manifests are create-only. Use a fresh output directory and label for every run.

| Runner label | Result |
|---|---|
| `P0-4-continuity-build-1` | Offline composition dry-run succeeded, zero remote uploads. |
| `P0-4-continuity-tests-1` | 92 tests across rollback adapter and paid order/control/priority suites passed. Covers disabled flags, retained fetch authority, unrelated older lane failure, repeat event and original bytes. |
| `P0-4-composed-check-1` | Composed external source typecheck passed. |
| `P0-4-native-drill-9` | Baseline nine real native processes, 14 assertions/groups passed; whole-run source snapshot stable and all qualification input hashes stable. Superseded for final harness qualification by the matrix below. |

The initial shared-tree typecheck `P0-4-continuity-check-1` found an unrelated concurrent alert test type error. It is not recorded as a passing check; final shared-tree checks are the coordinating release run's responsibility. Earlier native run 8 passed but had unrelated shared-source changes during its snapshot; run 9 and every final matrix run below have stable source evidence.

The expanded matrix before the zero-byte POST correction used harness SHA256 `c549385ee2a0b3dcb09a2a74042658df364a4a1dae18aa2141fc160a7c4ae473` and unchanged three Worker artifacts. All five runs have `source_stable: true` and `qualification_inputs_stable: true`. Their result paths are relative to the external evidence root above. Corrected POST and product artifact qualifications follow below.

| Result path | Processes / check groups | SHA256 |
|---|---|---|
| `P0-4-native-drill-10/result.json` | 9 / 14, Capture full sequence | `99c92a62dfa49159c75ff306a9f9b2949f91abcaa1cefb3ef6eeede317eb8ae1` |
| `P0-4-native-preflight-2/result.json` | 9 / 14, Preflight full sequence | `93e65a9b556f116b62934ce8cda5cf4264f77a9e23fad250752f642f676a78f8` |
| `P0-4-native-priority-2/result.json` | 4 / 5, actual enqueue and drain | `2b7c86d578144efb825478b56e7ba391ef97549f707c2f67491008ec3869d4f1` |
| `P0-4-native-unknown-3/result.json` | 4 / 4, unknown-payment safety | `dfa01f8104d47c6ae6c53c6e607df3bf3cba99259b0e6820a3231a71d72920c5` |
| `P0-4-native-preproof-3/result.json` | 4 / 4, retained-liability safety | `892d25c338dc8e635d86aa772cb1ebd3f6cdd6088e2f7fea2b83cc8bc9e51cad` |

Preflight uses its original 5-USDC synthetic authorization and an expectation that is false. Restart/fallback returns the original `safe: false`, `reason: expectation_failed`, response digest and proof bundle; it never re-evaluates or turns the negative result into success. Both product runs include the two actual native process kills and database outages described above.

Priority coverage injects a final-write rejection after proof persistence, allowing the actual candidate handler to return 503 and execute its existing `deferUnfinished` enqueue. The pending index survives old `0dbf2b3`. Compatible fallback records one recovery in `work.priority.counts.recovered`, commits the original fulfillment once, writes a durable `resolved/original_delivery_recovered` observation, and removes the pending entry. Fresh candidate readback repeats neither completion nor settlement/browser work.

Unknown-settlement coverage calls the actual guarded facilitator flow once with a synthetic nonterminal failure/transaction hint. The original durable unknown reservation and order binding survive old/fallback/forward processes byte-for-byte. No fulfillment starts and no browser runs. Later scheduled scans remain degraded with `settlement_unknown`; authenticated status remains 202/reconciliation-required and signed replay remains 503 without another verify/settle. The result retains `unknown_payment_exposure`, `fulfilled: false`, and unknown actual costs/financial totals.

Pre-proof coverage forcibly kills native workerd after draft metadata commits but before any proof object is written. Old/fallback/forward processes preserve the three original metadata objects. Background recovery reports `evidence_inconsistent`; buyer status returns 503, while the still-fresh signed replay can return 202 `processing` without delivery, a new payment or browser request. `ok: true` in this result means the **fail-closed liability-preservation gate** passed. It also explicitly records `fulfilled: false`, `liability_unresolved: true`, `confirmed_settlement_unfulfilled`, and unknown actual costs/financial totals. It is not successful fulfillment.

The first extension attempts used bodyless `POST /recover`; native dispatch returned 400. The negative scenarios above use authenticated GET status plus the original signed replay, so those runs do not claim native acceptance of POST. This was subsequently classified and fixed as a product defect, with separate native POST evidence below. The earlier expected-503 assertion was also corrected to accept the existing honest 202 `processing` response, while explicitly rejecting delivered/idempotent-success responses. Failed attempts remain stored and are not counted as passing.

Build command, passed as arguments to `node.exe` through the offline runner:

```text
tests/rollback-native/build-continuity.mjs <fresh-external-build-directory>
```

Native qualification arguments:

```text
tests/rollback-native/process-drill.mjs <exact-candidate-build> <exact-original-0db-build> <compatible-composition-build> <fresh-external-drill-directory> [capture|preflight|priority|unknown|preproof|post]
```

Do not use a script-path loader failure as evidence of a product startup defect. Prior investigation established that the original bundle can start when its exact bytes are supplied inline. This harness preserves those bytes and uses explicit module contents. It adds no unsafe-eval compatibility flag.

## Native zero-byte POST defect and narrow correction

`P0-4-empty-post-probe-1/result.json` records an independent minimal workerd fixture with both Miniflare dispatch and actual Node HTTP requests over loopback. No body, explicit `Content-Length: 0`, empty bytes, and empty string all arrived with a **non-null body stream and zero bytes** on both transports. The old `request.body !== null` guard therefore rejected legitimate HTTP recovery calls. This was a product defect, not solely a dispatch-fixture limitation. One-byte input was also measured as one byte and remains prohibited.

The only product change is in `src/orders.ts`: replace the body-presence condition with a private `assertEmptyRecoveryInput` call at the same authenticated boundary. Original ID, token and scope validation still run first. Both payment-signature headers remain forbidden. The helper inspects actual bytes without accumulating a payload, accepts only EOF with zero bytes, rejects any nonempty chunk, and bounds reads by one second and 64 chunks. Timeout/read failures remain controlled failures. It does not authorize a new order, receipt, payment, capture, refund or credential.

`tests/order-recovery.test.ts` verifies all four empty request forms recover the original draft without extra network/browser work or evidence changes; whitespace, a later nonempty chunk, an endless stream of empty chunks and both signature headers are rejected. A stalled stream is cancelled and returns 503. Runner `P0-4-empty-post-tests-2` passed **140 tests across five suites**. The first fake-timer test attempt is retained as a failed fixture attempt; the final stalled-body test uses the actual bounded timeout.

The same helper and single call replacement are transplanted into the old file by the local builder. A diff between build 1 and build 2 `src/orders.ts` contains only the 21-line helper insertion and one guard replacement. No newer order/export functionality is copied into `0dbf2b3`. The build manifest records:

- Original older `orders.ts`: `ca65ab6438c8a434d9e6dba421b4e758472ab8c230816865a92bcedb38b86936`.
- Shared helper: `34ac8140ededa8eeb8461f51c3eac7f167fbb50a1ced0e26faa0198d9baaffb5`.
- Patched older `orders.ts`: `e8b4bb90c21465028162d9c486f23019ee1ed2def798c37d90a8f874bb1436c1`.

The new local compatible artifact is `P0-4-compatible-build-2/worker/index.js`, SHA256 **`2ac5253c6009ae28318525e58e391ae37cffb1cca8229fab3256c5b5d76e6948`**. Its `build-evidence.json` SHA256 is `9ab3022f3735b37c92e8413425e77caeea5724f6f379c873addb7d3c477170ff`. Original `0dbf2b3`, the exploratory worktree and previous artifacts remain untouched.

`P0-4-empty-post-composed-check-1` confirms this compatible source typechecks successfully. The same command's second check on the comparison-only `149c302 + body guard` composition failed because that local recipe did not copy the existing Treasury checkpoint declaration file; that comparison package is not reported as typecheck-passed. The normal integrated candidate's shared-source checks belong to the coordinating final release validation, while its exact native runtime qualification is recorded above.

For local comparison only, builder mode `candidate` composes exact `149c302` with only the same input guard, retaining its own default entry and existing recovery consumer. `P0-4-body-fixed-candidate-2/worker/index.js` has SHA256 `894bcc42760cc2b27e39356fa70ec1b212e898b11799a2f915b7f194270e9414`; manifest SHA256 `69a31776b2617c2b725b0064f6e2e1559e4dc92c560d2e98c04249f35b6d71ec`. This is not the final integrated P0 release candidate. The first candidate-mode build failed because its existing Treasury custody support file was absent from the local composition recipe; the final recipe copies that exact reviewed dependency too. No product dependency or package changed.

| Corrected native result | Verified scope | Result SHA256 |
|---|---|---|
| `P0-4-native-capture-fixed-1/result.json` | Nine-process Capture crash, outage, fallback and forward sequence on corrected artifacts | `31c03208d2d0d3562a7627363eaf3de2bfb857770dbf05291cf7120ab58ae525` |
| `P0-4-native-preflight-fixed-1/result.json` | Same nine-process sequence preserving original negative Preflight result | `1c3444f3c5c1159687acc0a11866e7a1c4bec764c1b68c6601d7de0f4fe7ac22` |
| `P0-4-native-post-fixed-2/result.json` | Four processes; actual HTTP POST performs the original completion once, then both transports exercise input boundaries | `f51765e1479032619d23988b311f71cf98a29e3df21ad09c8fd97390c615ab88` |

In the POST run, original `0dbf2b3` still returns 400 for all four empty forms as the unchanged control. The compatible stage does **not invoke Cron**: its first real HTTP POST completes the preserved draft using the original CAS. Compatible and candidate stages each pass 18 cases (two transports × nine input/capability cases). Empty forms return complete/200; whitespace and either payment header return 400; wrong original ID or token returns 404. There is one original completion write and no repeated verify/settlement/browser operation. `native-post-matrix.json` under each stage contains the actual responses.

The first POST-matrix attempt hit a stale Node HTTP keep-alive connection reset while testing the unmodified older control. The final fixture uses separate HTTP connections per case, without retrying a failed business operation. It passes with stable whole-source and qualification-input hashes. Final harness SHA256 is `339600e3ed18fd80f87b1169c3c955d03195f2aa64aa11b95e752987549bd9fc`; the corrected Capture/Preflight runs preceded only that HTTP-fixture connection change. This resolves the zero-byte POST blocker locally, including the compatible fallback. It does not resolve missing original artifacts, unknown payment, telemetry gaps, or production authorization/acceptance.

## Remaining release gates and retained failure evidence

The pre-proof boundary cannot be repaired by re-reading another existing durable copy. `capturePage` calls Browser `quickAction("snapshot")` with `cacheTTL: 0`, parses HTML/markdown/screenshot into memory, and returns an in-memory `CaptureArtifacts`. It records no durable provider result ID or fetch-later locator. `executeFulfillment` writes only the response draft/digest first; `storeCapture` then writes three immutable artifact objects followed by the manifest. In the reproduced fault those writes have not started. The draft's proof ID, bundle root, timestamp and Preflight decision cannot reconstruct the missing original bytes or manifest.

The existing liability path is explicit but does not execute a remedy: recovery observations retain `evidence_inconsistent` / `orders_require_reconciliation`, priority may retain a quarantined observation, and accounting exposes `received_pending_delivery_raw` when receipt/refund coverage supports a number plus `core_delivery_or_refund_policy_review` when confirmed settlement remains undelivered. Unknown receipt/cost/refund coverage stays unknown. Accounting is read-only; there is no existing refund executor or durable browser-result recovery endpoint to invoke.

Moving the draft write after artifact storage would move the crash window and lose the saved response at a different boundary; it cannot recreate already-lost observations or eliminate the interval between Browser result creation and the first durable write. A real repair can consume the exact original bytes if an independently preserved source later exists and all original digest/time/binding checks pass. No such source exists in this reproduced case. Re-capturing would create a new observation; fabricating the original timestamp, marking complete without artifacts, or overwriting immutable objects would violate the existing proof contract. A refund/remediation mechanism and resilient result journaling would require substantive design, qualification and any applicable financial authorization, not a harmless flag/CAS patch. They were not implemented here. This is an unresolved local engineering/paid-liability P0, not merely an external-login gate.

- A real unsupported boundary was observed in earlier `P0-4-native-drill-3`: killing after durable draft metadata but **before proof artifact storage** leaves three metadata objects and no proof objects. The compatible consumer reports `evidence_inconsistent` / `orders_require_reconciliation`, keeps `processing`, and performs no new settlement/browser/completion. That pending paid liability is not fulfilled. The failed run is retained; later complete-proof successes do not erase it. Its recovery/reconciliation remains an engineering and liability gate, not an invitation to charge again or silently rewrite the source proof.
- Native successes cover enrolled Capture and Preflight with complete retained proof evidence, unknown-settlement safety, and ordinary priority enqueue/drain. Legacy/hashless orders, Pilot, partner/Watch/prepaid obligations, expired raw artifacts, every priority quarantine/lease transition and a full liability inventory still require explicit coverage. Do not claim a full inventory from bounded scan success.
- The compatible composition consumes the original v1/v2 paid recovery records and uses their original CAS/lease rules. Both compatibility scanning after process loss and ordinary durable priority recovery are covered; every queued transition is not.
- The old product handler does not acquire the new independent monitor/notification transport merely by wrapping recovery. An eventual rollback must preserve the separately qualified independent monitoring and owner notification path and must not clear operations objects to satisfy an older reader.
- The D1 telemetry outage gap remains incomplete. Subsequent writes succeeding does not turn missing actual financial evidence into zero or recognized revenue.
- Production account/version IDs, binding identity, non-secret effective flags, migration ledger/bookmark, old object metadata, provider runtime deployment/rollback behavior, isolation configuration, and independently delivered alerts remain unverified. No production migration, data restore, deletion, deployment, rollback or flag activation was performed.
- The final exact integrated candidate and compatible rollback bytes have now passed the six local scenarios above. Any further runtime change requires qualification on its new exact bytes. Deploy-specific var policy, production schema/binding compatibility, provider rehearsal and production changes still require their own verification and scoped authorization. Local success does not start or satisfy the 48-hour production window.

Status: compatible recovery composition implemented and locally qualified for the stated scope; original paid liabilities and failure evidence retained; production not qualified; full P0-4 acceptance remains conditional on the unresolved coverage and external gates above.
