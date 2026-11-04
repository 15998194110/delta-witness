# DELTA payment, original observation and fulfillment audit

2026-11-04 Asia/Shanghai. Starting repository revision: `b20f1b1b4070e51b2899146f7106e16b278b8bf3`. Final integrated code revision/build hashes are recorded in [the final gate report](DELTA_FINAL_GO_NO_GO.md). This audit changes responsibility handling locally; it does not execute payment, refund, production migration, external notification or deployment.

## Authority and compatibility

The only payment/fulfillment authority remains the original [settlement journal](src/settlement.ts), [order binding and capability](src/orders.ts), [fulfillment record](src/fulfillment.ts), [conditional writes](src/claims.ts), and [private proof objects](src/capture.ts). The original ETag fences a write; an unknown acknowledgement grants no retry. The original request hash, payment fingerprint, product, amount, original observation timestamp and full response digest remain bound. D1, a dashboard, recovery cursor, priority item, notification or new remediation view cannot grant payment or prove revenue.

Current repairs preserve old HTTP status/error codes and original records. The authenticated order response now adds an explicit [remediation contract](src/order-remediation.ts) when proof validation fails or original delivery remains unresolved. It names the responsible operator, prohibits another required payment, requires exact original evidence for recovery, and leaves historical financial recognition UNKNOWN. A previously completed record whose evidence is now inconsistent is an integrity review, not an assertion that the customer was never served.

The [bounded internal remediation reader](src/orders.ts) derives an episode ID and first-seen time from the original order/payment identity and original confirmation time. Repeated scans cannot reset that age. Complete verified delivery returns no active obligation; a read outage returns UNKNOWN rather than falsely resolving an existing alert. This projection is selected-order evidence, never a complete debt inventory. A caller must not infer global absence from its null/empty subset.

Revocation or raw-retention expiry previously caused unfinished paid records to be classified as skipped/resolved. [Recovery](src/paid-order-recovery.ts) and [priority processing](src/paid-recovery-priority.ts) now keep these as reconciliation/quarantine responsibilities. Credential revocation still blocks buyer access; recovery cannot extend retention or fetch expired raw evidence. Historical records and observations are retained.

The v1 recovery result keeps its field structure but expands permitted state/reason pairs. A bare historical consumer can reject these new observations; it must not be chosen as a compatible rollback. The [local composition builder](tests/rollback-native/build-continuity.mjs) now pins an exact candidate recovery commit (full SHA), copies its recovery/priority/control modules and original adapter, records source hashes, and retains the older product. It must be built and tested alongside the exact candidate. Its default comparison-only `candidate` mode is not the integrated release candidate.

## Lifecycle fault matrix

| Boundary | Existing authority / current handling | Evidence |
|---|---|---|
| Request not yet persisted / unsigned | No capture or settlement starts; input/payment challenge is bounded | [payment gate](tests/payment-gate.test.ts), [reliability payment](tests/reliability-payment.test.ts) |
| Verified request before settlement | First original reservation and capability binding precede settle; failure cannot mint a second order | [settlement implementation](src/settlement.ts), [order recovery tests](tests/order-recovery.test.ts) |
| Authorization/settle result unknown | Durable non-expiring unknown journal remains; no settle POST retry based on timeout, reported failure or missing ACK | [reliability tests](tests/reliability-payment.test.ts), [native unknown scenario](docs/repair/p0-4-rollback-continuity.md) |
| Confirmation write commits, ACK lost | Original journal readback determines state; no failure rewrite races the uncertain write | [critical write boundaries](tests/review-critical-write-boundaries.test.ts) |
| Browser starts / no result yet | Original fulfillment claim remains; stale processing is unknown, not permission to start another capture | [Core execution](src/index.ts), [fulfillment tests](tests/fulfillment.test.ts) |
| Observation in memory, no durable evidence | Cannot reconstruct the historical instant. Keep original payment and unresolved obligation; show needs_intervention when validation establishes incomplete/inconsistent evidence | [native preproof drill](tests/rollback-native/process-drill.mjs), [remediation tests](tests/order-remediation.test.ts) |
| Some objects saved, manifest incomplete | No fake success; validate the entire original bundle and request binding; preserve all original bytes | [capture reader](src/capture.ts), [critical write tests](tests/review-critical-write-boundaries.test.ts) |
| Proof saved, completion not committed | Original authenticated or background recovery verifies original response/artifacts and performs the original CAS | [background recovery](tests/paid-order-recovery.test.ts), [native crash drill](tests/rollback-native/process-drill.mjs) |
| Completion commits, response/ACK lost | Read the original completion. No second settlement, observation or completion; timestamps stay original | [native capture/preflight/post drills](tests/rollback-native/process-drill.mjs) |
| Same credential retried / changed request | Original identity binding rejects reuse for another request or order; concurrent aliases cannot obtain a second grant | [order recovery](tests/order-recovery.test.ts), [reliability payment](tests/reliability-payment.test.ts) |
| Two recovery workers / lease expires | Original fulfillment ETag arbitrates completion; priority claim ID/attempt/lease fences observation and removal | [priority concurrency tests](tests/paid-recovery-priority.test.ts) |
| Revocation/retention expiry | Access/retention still enforced; unfinished original responsibility is reconciliation, not resolved | [recovery expiry tests](tests/paid-order-recovery.test.ts), [remediation quarantine test](tests/order-remediation.test.ts) |
| New version fails / rollback | Retain same stores and original identities; exact compatibility consumer required; preserve new fields/unknown observations | [rollback evidence](docs/repair/p0-4-rollback-continuity.md), [final runbook](DELTA_PRODUCTION_RELEASE_RUNBOOK.md) |
| D1 fails while R2 remains | Business authority survives; later successful telemetry does not fill missing rows or prove complete costs | [native outage drill](tests/rollback-native/process-drill.mjs) |

These are existing paths plus narrowly scoped responsibility repairs, not a second payment engine. Installed SDK replays and genuinely authorized purchases remain automatic; no per-order human approval was added. Known pre-observation retryable failures retain the original bounded retry policy. Unknown observation/storage outcomes cannot enter that retry policy merely to produce a green result.

## Handling unavailable original history

1. Preserve the original order, settlement, response digest, available artifacts, timestamps and recovery/quarantine observations. Never clear a lock or set complete to dispose of the obligation.
2. First read and verify any exact original evidence that becomes available. [The test](tests/order-remediation.test.ts) removes/corrupts proof, receives needs_intervention, restores the original bytes, then completes the same original order without another payment or Browser call. This is a synthetic restoration, not production data mutation.
3. A transient read failure is UNKNOWN. A missing object alone does not prove permanent loss. Loss must be established from the actual original storage/provider inventory before choosing a remedy.
4. A new observation is a new timestamp and potentially a different Guard result. It requires the buyer's explicit acceptance of substitute service and a recorded link to the original obligation. There is currently no authorized automatic substitute executor; the status contract explicitly says `authorized:false`. Do not fabricate the old time, overwrite the original, or reuse old proof hashes.
5. If original-time service cannot be supplied, retain needs_intervention and the operator's responsibility. A refund or other financial remedy needs separate authorization, original payment reconciliation, original buyer/amount checks, a unique refund identity, Treasury transaction readback and accounting reversal. This task does not create a refund signer or execute funds.

This allows a controlled release decision about a defined, observable failure mode rather than demanding impossible reconstruction. It does **not** erase a real unfulfilled liability or mean a production remedy has occurred. Gate 1 can qualify preservation, truthful disclosure and safe original recovery. Real inventory, notification and approved remedy execution belong to the external/release gates.

## Other products and historical obligations

Capture/Preflight scoped recovery is not automatically available to every historical payment. Legacy/hashless records remain subject to their original replay path and cannot mint a new capability. Pilot, partner and Watch have their own original identities and contract tests. [Watch/partner audit](docs/repair/2026-11-02-watch-partner-results.md) and [adapter qualification](docs/repair/2026-11-02-sdk-fallback-results.md) preserve prepaid credit, lease, same-business-order charge coordination, negative Guard results and unknown platform charges. A trusted platform billing assertion is not proof of actual prepaid funds or payout. No provider-funded escrow or new customer deposit ledger is claimed.

Production must inventory all these original categories, including unknown settlements, quarantine, revoked/expired capabilities, and historical completed obligations before a broad release. The bounded current recovery scan and selected-order alarm do not establish that inventory. Treasury receipt, refund coverage, customer purpose and actual costs remain independently necessary for recognition; see [financial audit](DELTA_TREASURY_AND_COST_AUDIT.md).

## Local validation

Reviewed offline runner: `C:/Users/10122/Documents/ChatGPT/DELTA-cloud-operations-20261103/Run-CloudCheck.ps1`. No live payment, wallet, provider token or production data is used. Logs are create-only; failed attempts remain.

- `FINAL-payment-target-1`: 142 passed across five original/recovery/remediation suites.
- `FINAL-payment-target-2`: 255 passed across nine suites including critical-write interruptions and original retention; stable source fingerprint `c4a1254a947dcbeb638fd36c841df497862ab5547327f5fc09d9a1892301d999`, log SHA256 `f4297a4667d3e7514678c2a266670272f2977b92b8e37eff04363ad64329fe21`.
- `FINAL-payment-target-3`: 256 passed across the same nine suites after the internal original-age reader and reviewed dependency update; stable source fingerprint `99438a24c4162fa55d38db74cd2e193fdc54e40791758f0f331e907a15d5428b`, log SHA256 `ed1dfe500122bd6355ccc340ef4245a4a4cc0117aa47265fc08b03f5f92a3028`.
- `FINAL-payment-types-1`: retained intermediate failure in concurrently edited notification files, not represented as a typecheck pass. The final integrated root validation supersedes this intermediate check.
- `FINAL-payment-types-2`: intermediate updated-Hono handler return-type mismatch at the newly edited webhook route; the notification owner was informed. This failed attempt is also retained rather than reported as passed.
- `FINAL-payment-types-3`: TypeScript emitted no diagnostics, but the evidence wrapper failed because no empty log file was created. This is not counted as a qualified run.
- `FINAL-payment-types-4`: TypeScript completed with exit 0 using explicit beginning/end log output; stable source fingerprint `7f10d79565ec66b5e827846598906bbe7e96b384c3b10e6e50a164dcfc6a446d`, log SHA256 `7b8f1b0a0e906fce76a59d8120ff4f311a04e962d45000668e5ecb825e6aed02`.

## Final exact-byte process and rollback qualification

The final local runtime commit is `770449062da06d844a14aefabebbc2601677550d`. The candidate Worker SHA256 is `06995a4105a5547afdf9c87d2641794862cc93f039894b1d167712e2c0ceb78f`; the separately composed compatible fallback is `c0bf205a78fdfacb0fdf093d70860c15fdbe6859a0e895177171508ea120cde6`. The fallback preserves product source from `0dbf2b3`, adds the selected candidate's original-order recovery consumer and zero-byte recovery input guard, and uses the candidate's reviewed dependency lock. It is not falsely described as the untouched old binary. The unchanged old Worker remains a negative control.

[Native summary and hashes](../DELTA-final-production-20261104/native-summary.json) links the six actual runs. Each run records unchanged inputs before/after, independent native process IDs, original business-object digests, synthetic transport counts and buyer readback. All six have exit 0 and stable source fingerprint `d226274ee9666c4ae8f3cee821dcdce3bc02492e6863bd7e365c69c58eaebe38`.

| Exact candidate scenario | Observed local outcome | Evidence |
| --- | --- | --- |
| Capture interruption, fallback and return | Original draft survives native kill, failed candidate start and R2 outage; completion survives a second kill after CAS before ACK; no second charge, capture or completion | [capture result](../DELTA-final-production-20261104/native-capture-1/result.json) |
| Preflight interruption, fallback and return | Same continuity; original negative Guard result remains negative and the original 5-USDC price is retained | [preflight result](../DELTA-final-production-20261104/native-preflight-1/result.json) |
| Paid-unfulfilled priority queue | Original unfinished response enrolls the existing queue; compatible consumer recovers once and records durable resolution | [priority result](../DELTA-final-production-20261104/native-priority-1/result.json) |
| Unknown settlement | Original unknown reservation remains unresolved through old, compatible and forward versions; no capture or second settlement | [unknown result](../DELTA-final-production-20261104/native-unknown-1/result.json) |
| Kill before proof persistence | Confirmed payment and unfinished liability survive; forward buyer view exposes needs_intervention, unknown permanence of loss, no substitute/refund authorization and no revenue assertion | [preproof result](../DELTA-final-production-20261104/native-preproof-1/result.json), [actual buyer view](../DELTA-final-production-20261104/native-preproof-1/preproof-forward/buyer-readback.json) |
| Actual local HTTP recovery | Compatible empty POST completes once without Cron; native loopback HTTP and dispatch accept zero-byte variants and reject nonempty/payment-bearing/wrong-capability requests | [POST result](../DELTA-final-production-20261104/native-post-1/result.json), [HTTP matrix](../DELTA-final-production-20261104/native-post-1/post-forward/native-post-matrix.json) |

The Capture and Preflight runs also reject D1 telemetry writes during an outage and resume later writes without reclassifying the missed telemetry as complete. Financial totals remain UNKNOWN. These runs establish local recovery behavior, not actual mainnet payments, provider expenses, production inventory or external notification delivery. Earlier `19b43f5` native logs remain historical evidence. No continuous 48-hour production run or customer revenue was verified by these isolated results.
