# Watch / Partner local acceptance — 2026-11-02

Parent candidate: d85b367. Only local changes and isolated fixtures; no provider action, deployment, billing, secret access, or task change.

## Changes and authority

Watch continues to use the original watch record, prepaid count, sequence, lease, proof artifacts and notification outbox. The shared Core bounded metadata reader now also guards the entire check, with a 50-second deadline before the existing 60-second lease expires. Storage continuations and Browser calls check that fence; a late Browser response is cancelled. Already submitted R2 writes may still commit. The original lease remains unknown and is not erased or treated as permission to repeat a capture.

Inventory reads and cursor writes each have a 20-second operation bound. Checks remain concurrent, with the existing maximum 25 entries per batch. Existing notifications dispatch independently, and a second pass handles newly committed events. These phase limits give a conservative 150-second scheduler bound (20 inventory + 50 checks + 20 cursor + 60 notification pass), assuming the JS runtime services timers. Tests use fake time for noncooperative dependencies, not a production runtime guarantee.

Failed captures report unknown Browser/storage/cost/margin values as null, retaining the original prepaid consumption semantics. No failed capture becomes successful/unchanged content evidence. A tenant-authenticated Watch read includes the last notification's state, attempt count and reconciliation action. Terminal failures do not silently reset attempts or resend; receiver reconciliation remains necessary. Secrets and raw notification payloads are omitted from that status.

Gateway body reads now have a 10-second deadline, covering the actual stream. Cancellation cannot turn a timed-out body into successful empty JSON. No Core call occurs for that timeout.

## Actual tests

Private evidence directory: `C:/Users/10122/Documents/ChatGPT/DELTA-repair-evidence-20261028`.

- `02-b4-watch-final-targets-1`: 158 passed across Watch, notification, reliability-payment, partner whole-flow and unchanged Apify mocked-delivery suites.
- `02-b4-watch-gateway-test-2`: all 16 Gateway tests passed.
- `02-b4-watch-gateway-check-1`: Gateway TypeScript passed.
- `02-b4-watch-check-1`: intermediate Core TypeScript passed. Final integrated root checks supersede intermediate source fingerprints.

New fault injection covers stalled inventory, lease CAS, artifact write and final CAS. A late claim cannot start a Browser call; late artifacts retain an unknown original slot; a late final commit is promoted to the original outbox without recapture. Existing expired-worker and negative Guard regressions remain intact.

The new Core + Gateway tests verify same tenant/key concurrency, cross-tenant isolation, original negative Guard replay after proxy credential rotation, one concurrent Watch registration and last-credit consumption, and cost deterioration refusing a new order while preserving an original completed replay. This does not establish a general platform deposit ledger: current Capture/Preflight authorize a trusted server's billing assertion; only Watch has the finite prepaid balance tested here.

Diagnostic failures retained: the first new Gateway fake-timer test advanced before asynchronous authentication had acquired the stream; it now waits for the reader before advancing time. A new economics test initially expected the wrong error-code spelling; aligned to the shared Core `economics_unavailable` contract. Neither failure was suppressed.

## Apify D16: initial audit superseded by local coordination

Read the installed lock-resolved `apify` 3.7.2 and `apify-client` 2.25.0 source. `apify/dist/charging.js` destructures only eventName/count at line 241 and calls run.charge without a caller idempotency key at line 296. `apify-client/dist/resource_clients/run.js` lines 256–274 accepts a key but otherwise generates a new one for each invocation. Internal HTTP retries can retain that generated key; a second Actor.charge invocation cannot be assumed to do so.

The [official Apify charge API](https://docs.apify.com/api/v2/post-charge-run), checked 2026-11-02, documents a charge idempotency header and says the caller must enforce the run budget. This is not evidence of cross-run business-order deduplication. Passing an extra key to this installed Actor.charge would be silently ineffective; changing to the lower-level API would require explicit budget, result and platform accounting contract tests. No SDK was upgraded, no charge was performed, and no platform ledger guarantee was invented.

The initial audit found that the old sequential same-run KVS guard changed identity on a new run and could not exclude concurrent writers. That finding is now superseded by the local Core original-fulfillment CAS coordinator and stable partner/user/business-order identity described in [SDK and fallback results](2026-11-02-sdk-fallback-results.md#d16-local-original-business-billing-coordination). The existing Core fulfillment record remains authoritative; no independent ledger or duplicated capture engine was introduced. A successful reservation records `charge_unknown` before returning one permission for a single SDK invocation. A lost acknowledgement or new run cannot regrant it. Original output is persisted before billing, negative Guard stays negative, and unknown legacy markers remain unresolved.

Independent readback covered `src/partner-billing.ts`, the new authenticated Core/Gateway routes and the actual Actor source. Tenant and business identity bind the request hash and original verified delivery; concurrent reservations use the original ETag, and post-deadline continuations cannot issue a charge permit or confirm a late SDK result. `02-b4-watch-d16-review-1` independently reran all 57 adapter/Core/Gateway tests successfully. No new blocking defect was found in that inspected local scope.

The feature remains opt-in and was not enabled in production. Adapter-reported `platform_charged` is not settlement, Treasury receipt, net payout or revenue: those fields remain null. Real platform identity provenance, funded budget, SDK/provider internal retry semantics, prices/fees, payout readback and remote concurrency still require external qualification. Submitted provider writes or charges may complete after local timeout; their original unknown marker must be reconciled without a replacement purchase. D16 is locally repaired and tested, pending release and external verification.

## Independent review

The SDK agent read the Watch implementation and reported no new blocking defect in the wrapper nesting, deadlines, late-result fences, original outbox recovery or owner-only status. It explicitly retained the limitation that already submitted R2 writes can commit after cancellation.

The Watch agent independently read the browser order store, App integration and JS export change: one durable active-pointer/capability cell under a distinct Web Lock; revision CAS; only matching legacy attempts cleared; unconfirmed/404/expired recovery cannot sign; late wallet response fenced while payment lock is retained; authenticated opaque export verifies bytes/length. No blocking defect found in that review. Browser archive capacity, lost local capabilities and real runtime/provider behavior remain explicit limits; an endpoint-supplied hash is not independent attestation.
