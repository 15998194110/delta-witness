# DELTA security and dependency audit

Reviewed 2026-11-04 against the candidate descended from `b20f1b1`. This is a code/isolated-test assessment, not a penetration test of production. Final candidate identity and release-scope decisions belong to [GO/NO-GO](DELTA_FINAL_GO_NO_GO.md). No secret export, live purchase, wallet signature, provider write or customer outreach was used.

## Changes and evidence

| Boundary | Finding, fix and evidence |
|---|---|
| Public URL / IPv6 | Prefix-only checks missed hexadecimal IPv4-mapped addresses such as `::ffff:7f00:1`, expanded loopback and encoded transition addresses. [security.ts](src/security.ts) now uses numeric canonical IPv6 words and a conservative global-unicast policy excluding special/transition/documentation ranges. Ordinary public IPv6 remains supported. [security tests](tests/security.test.ts) cover the bypass forms and DNS answers. |
| Complete DNS view | A successful A answer previously permitted unavailable AAAA checks. Both queries must now succeed with a well-formed status and typed answers; any private result rejects the destination. No DNS result is silently treated as permission after malformed/failed resolution. |
| Browser URL filters | Private/special literals, credential URLs and nested localhost/local labels have stronger rejection patterns. The bounded redirect preflight validates every observed top-level hop. These are defense in depth, not IP pinning. |
| External demand JSON | [Scanner](scripts/scan-external-funded-demand.mjs) previously buffered arbitrary JSON and recursively traversed it. Reads now cap time/body, reject redirects, use bounded iterative traversal and isolate malformed/deep/oversized sources. Partial channel failure leaves aggregate counts UNKNOWN, not false zero; [boundary tests](tests/funded-demand-boundaries.test.mjs). |
| Economics | [Financial view](src/financial-evidence.ts) exposes a digest-bound, read-only expansion HOLD/negative-margin block. It cannot stop already-paid recovery, modify prices or authorize purchases. [Tests](tests/financial-evidence.test.ts) cover unknown/synthetic/negative costs and no side effects. |

The numeric IPv6 policy was checked against the [IANA special-purpose registry](https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml). DELTA deliberately rejects some special ranges that have narrower exceptions; this is a conservative public-web service policy, not a claim to implement every IANA reachability exception.

## Existing controls retained

| Threat | Code and qualification |
|---|---|
| Unpaid resource amplification | [Payment/fulfillment boundary](src/fulfillment.ts), [settlement](src/settlement.ts), [orders](src/orders.ts), [gate tests](tests/payment-gate.test.ts). No unpaid request may start capture; retries use the original payment identity. [Payment audit](DELTA_PAYMENT_AND_FULFILLMENT_AUDIT.md) covers ambiguous settlement and liabilities. |
| Large body/header/response | [security.ts](src/security.ts): URL 2,048 characters; Capture/Guard/Partner bodies 4,096/8,192/12,288 bytes; payment header 32,768 bytes; bounded stream readers and deadlines. |
| Browser/resource exhaustion | [capture.ts](src/capture.ts): navigation timeout 20s, action timeout 25s, caller deadline 30s, HTML/Markdown/PNG 2MB/1MB/6MB, total artifacts 9MB, response 17MB; media/websocket resources rejected. These are application limits, not proof of provider-internal cancellation or hard dollar spend. |
| Proof overwrite / tampering | [Order storage](src/order-storage.ts), [capture](src/capture.ts), [export verification](src/export-verification.ts) retain original manifests and validate original sizes/hashes. Unknown writes remain unknown; the same payment cannot create a second business order. |
| Private raw artifacts | [Core routes](src/index.ts), [order export authorization](src/order-export-authorization.ts), [retention](src/retention.ts) separate public metadata from gated original artifacts. Public bucket settings still require readback in the real account; code cannot prove them. |
| Auth / receipts | [Partner gateway](channels/partner-gateway/src/index.ts), [notification outbox](src/operating-alert-outbox.ts), [signed receipt](src/operating-alert-webhook.ts), [Resend](src/operating-alert-resend.ts). Secret/version/transport validation and receipt replay protections are tested locally; actual provider configuration is separate. |
| Logs and financial privacy | [Failures](src/failures.ts), [telemetry](src/telemetry.ts), [Treasury scanner](scripts/treasury-reconciliation.mjs), [financial sources](src/financial-evidence.ts) use bounded safe fields rather than provider error text/credential URLs. No secret-value scan output was printed. |
| Untrusted page/Agent content | Content is observation data, not executable agent instructions. Existing deterministic Guard expectations do not authorize wallet spend or execute page instructions. This does not certify page truth. |
| CI supply chain | Candidate release workflows use scoped authorization and pinned actions; [runbook](DELTA_PRODUCTION_RELEASE_RUNBOOK.md) separates approved artifacts from arbitrary branch/Scope requests. Exact dependency lock integrity is retained; no install lifecycle scripts ran during this repair. |

## Browser egress and hard resource guarantee: external prerequisite

The official [Browser Run Guardrails](https://developers.cloudflare.com/browser-run/features/guardrails/) documentation says hostname allowlists apply to Puppeteer, Playwright and CDP sessions and are **unavailable for Quick Actions**. DELTA currently uses `BROWSER.quickAction("snapshot", ...)`. [Outbound Workers](https://developers.cloudflare.com/browser-run/features/outbound-workers/) describes optional host routing, including private-service access; DELTA does not configure that routing. The [FAQ](https://developers.cloudflare.com/browser-run/faq/) describes provider infrastructure and resource limitations but does not establish a universal DNS-rebinding/private-destination guarantee.

Therefore the audit does **not** claim that top-level DoH checks pin browser sockets, that post-observation redirect validation prevents every intermediate fetch, or that subresources cannot rebind after validation. URL-pattern blocks do not inspect destination IPs. Provider socket/subresource private-network enforcement remains unverified and must be qualified before public expansion. No attempt to reach live metadata/private endpoints was performed.

The Quick Action binding also has no caller cancellation handle in this implementation. The 30s deadline discards late output and prevents a second observation; it cannot demonstrate immediate termination of provider work. Actual browser milliseconds are used only when provider data exists; otherwise the cost model remains estimated. Required external evidence is a provider-supported egress guarantee plus an isolated, explicitly authorized probe and provider timeout/usage readback. If unavailable, the release decision must retain this limitation or narrow approved targets under a separately reviewed contract; do not silently claim full network isolation or replace the Core architecture merely to make a checkbox green.

## Dependencies: exact bounded updates, no forced major downgrade

Read-only npm advisories were collected before and after updating each existing lock. Changes preserve product version, formal prices and adapter identity. Package installs used `--ignore-scripts --no-audit --no-fund`; registry requests were bounded. No `npm audit fix --force` was used.

| Existing package scope | Before | Candidate result | Selected updates |
|---|---:|---:|---|
| Core | 12 high / 3 moderate | 0 findings | x402 2.29.0; Hono 4.13.16; Vitest 4.1.12; Wrangler 4.157.0; compatible transitive patches |
| MCP | 1 critical / 9 high / 6 moderate | 0 findings | MCP SDK 1.32.2; x402 2.29.0; Zod 4.6.7; Vitest 4.1.12; compatible HTTP/transitive patches |
| Partner gateway | 6 high / 3 moderate | 0 findings | Hono 4.13.16; Vitest 4.1.12; Wrangler 4.157.0; compatible transitive patches |
| Base App | 10 high / 2 moderate | 0 findings | x402 2.29.0; Vite 7.3.7 (same major); Vitest 4.1.12; Wrangler 4.157.0; compatible transitive patches |
| Apify | 8 high / 5 moderate | **5 high / 4 moderate; RELEASE HOLD** | Compatible adm-zip / brace-expansion / redirect / IP patches only; unresolved SDK transitive major constraints retained |

Official advisory checks included [fast-uri canonicalization](https://github.com/fastify/fast-uri/security/advisories/GHSA-wjr9-j795-jxcr), [Vitest Windows traversal](https://github.com/vitest-dev/vitest/security/advisories/GHSA-xp26-3454-mjgp), [MCP input validation](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-46jr-4wx8-v453) and [proxy-addr trust subnet](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h). The MCP HTTP advisory explicitly excludes stdio-only servers; DELTA uses stdio. The proxy-addr finding requires a vulnerable HTTP trust configuration, not present in DELTA's stdio path. Updates remove the dependencies' vulnerable versions without inventing evidence of exploitation.

Apify 3.7.2/Crawlee retains `basic-ftp` 5.x, `minimatch` 9.x and `stream-json` 1.x constraints; fixing the recorded advisories requires unsupported cross-major overrides or a different upstream SDK graph. Do not downgrade the Actor to the npm audit suggestion `apify@2.3.2`: charging and persistence contracts would change. Keep this optional channel outside the approved release scope until its SDK/CLI graph, platform charging and actual net fees are qualified. `apify-cli@1.11.0` exists in npm with Node >=22, but merely pinning a global CLI top-level version does not supply a transitive lock/integrity review. Its global unpinned install is not an approved artifact.

No-findings means the registry returned no advisories for those exact locks at observation time; it is not proof of absence of vulnerabilities. Re-audit at release. Python/client packages without npm dependency locks were not represented as npm-audited.

## Recorded validation

All paths below are private local audit artifacts, not public customer data. Evidence directory: `../DELTA-production-readiness-20261104/`; runner records: `../DELTA-cloud-operations-20261103/`.

- `FINAL-npm-audit-core-{1,2}.json`; post-update SHA256 `195ac82b26866d14f1bec96e1be5dd6d735fc3d25d87cc1175c92258133c327d`.
- `FINAL-npm-audit-{packages-mcp-server,channels-partner-gateway,channels-base-app,channels-apify}-{1,2}.json` preserve all before/after findings including the unresolved Apify ones.
- `FINAL-finance-security-2.json`: 223 passing cases / 9 suites, source stable; log SHA256 `1f833f7c05b4e182f3afedfa7a5acbddd45ea2ba790f9da42c81d71f22ee2c60`. This test snapshot predates the later adapter lock refresh; final integrated evidence is the release authority.
- `FINAL-deps-packages-mcp-server-test-1.json`: 50 pass; `FINAL-deps-channels-partner-gateway-test-1.json`: 16 pass; `FINAL-deps-channels-base-app-test-1.json`: 90 pass. All three source stable and offline.
- Corresponding `FINAL-deps-*-check-2.json`: typecheck pass for MCP/gateway/Base App and syntax-only pass for Apify. Initial silent checks produced no stdout; the external runner failed to create its log. Those `*-check-1-source.json` records are retained, not promoted to completed evidence; reruns via reviewed npm check scripts produced proper logs.

The decisive remaining external checks are provider egress/time limits, production secret/access/R2 configuration, genuine notification delivery, immutable actual bill/source qualification and approved deployment/soak evidence. [Owner actions](DELTA_OWNER_ACTIONS.md) is the single consolidated handoff; nothing here authorizes new spend or release.
