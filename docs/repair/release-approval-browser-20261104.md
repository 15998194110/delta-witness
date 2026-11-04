# Browser qualification — release approval boundary

Observed 2026-11-04. This is an existing release limitation, not a newly introduced product feature or a completed provider security test. No Browser Run session, payment, network-rebinding attack or production write was executed.

## What is established

- [Candidate capture](../../src/capture.ts) uses `BROWSER.quickAction("snapshot", ...)` with `cacheTTL: 0`, a 20,000ms navigation timeout, a 25,000ms action timeout and a 30,000ms caller deadline. It bounds returned HTML/Markdown/PNG and rejects late output. The [security audit](../../DELTA_SECURITY_AUDIT.md) identifies the exact local controls and their tests.
- Official [Quick Actions timeouts](https://developers.cloudflare.com/browser-run/reference/timeouts/) describes separate timers for navigation and post-navigation actions. Therefore the caller's 30-second deadline is **not** evidence of a 30-second provider session or billing cap. Do not add the two configured timers and present the result as a verified total-runtime bound either.
- Official [Guardrails](https://developers.cloudflare.com/browser-run/features/guardrails/) applies hostname policies to Puppeteer/Playwright/CDP sessions, not Quick Actions. Changing a flag on the current Quick Action cannot supply that guarantee. Hostname filtering alone is not proof of socket IP pinning.
- Official [binding API](https://developers.cloudflare.com/browser-run/reference/browser-binding-api/) documents session management; DELTA's current Quick Action does not expose a session cancellation handle to this implementation. No new session-based capture engine is introduced for this approval pack.
- [Authenticated production readback](cloudflare-readonly-20261104.md) establishes private R2 settings and verifies nine existing raw-artifact hashes without exporting their contents. This storage boundary is verified at observation time; it does not establish browser egress safety.

## Remaining evidence, exact scope

| Question | Current result | Evidence necessary to close |
|---|---|---|
| Private-destination prevention after DNS changes and during subresource loads | UNVERIFIED | Provider-supported enforcement for the **actual Quick Action API**, plus an authorized isolated qualification. A successful top-level DoH check is insufficient. |
| Intermediate redirect destination enforcement | UNVERIFIED at provider socket boundary | An owned test redirect chain and provider-side request observations; the service's final-URL validation must not be represented as blocking an already completed intermediate request. |
| Cancellation / resource and charge ceiling | App limits established; provider ceiling UNVERIFIED | Provider timing/termination records for configured timeout, oversized-page and client-disconnect cases; recorded browser milliseconds and a billable-usage source. |
| Per-request actual expense | UNKNOWN without source/allocation | Provider usage identity and invoice rate/allocation matching, separately from the estimated cost already recorded in proofs. |

## Prepared bounded qualification (not authorized or run)

1. Use an isolated, separately approved Worker/account resource and test-only storage. No production bindings, original customer URLs, real payment signatures or Treasury purchases.
2. Use an owned public test origin and nonce-bearing redirect/subresource fixtures. Specify the allowed destination set and the exact network test scope before execution. Do not probe actual cloud metadata, unrelated private services or third-party systems.
3. Exercise success, navigation timeout, action timeout, delayed subresource, oversized output and caller-disconnect cases. Collect provider session/usage identity, start/stop times, the test origin's request log, returned error and the application's retained order state.
4. Establish the destination-IP enforcement contract with the provider before interpreting a rebinding fixture. A test which never reaches a private address is not by itself proof that every private address is blocked.
5. Maximum approved requests, allowed destination set, spend cap and cleanup scope must be explicit in that later authorization. The current approval pack grants zero provider executions and zero spend.
6. Failed or ambiguous results retain the release HOLD. No mock, HTTP 200, unavailable log or timeout in the caller may become provider assurance.

If the provider cannot support the required boundary, review a constrained-target contract or a separately qualified transport change. Do not silently reduce existing product guarantees, alter formal prices, invalidate paid obligations or claim broad public-capture qualification. This is engineering-owned work; it is not another request for the owner to log in or supply wallet credentials.

## Release interpretation

The Core bytes remain the previously tested artifact. These provider limitations must appear in the single [release decision](../../DELTA_FINAL_GO_NO_GO.md) and approval form. R2 privacy and original-proof integrity are closed read-only checks; unrestricted browser egress and hard provider termination are not. The current decision remains **NO_GO**.
