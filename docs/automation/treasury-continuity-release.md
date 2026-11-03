# Treasury checkpoint custody candidate — local qualification only

This candidate connects the **existing** Treasury reconciliation algorithm to an explicit storage authority port. It does not deploy an endpoint, select a provider, migrate financial data, create a second receipt ledger, reset the origin, transfer funds, or enable a scheduled task. The production Pulse is not made continuous merely by this file existing.

## Original authority and preserved schemas

`scripts/treasury-reconciliation.mjs` remains the receipt/canonical-block validation authority. Its `reconcileTreasury` function consumes `checkpointStore.read()` and `checkpointStore.compareAndSwap(expectedVersion, state)`. The unchanged `validateTreasuryReport` still decides whether a declared range has verified continuous coverage.

`scripts/treasury-checkpoint-store.mjs` uses the same `delta-treasury-checkpoint/v1` state and `delta-treasury-revision/v1` revision envelope as `treasury-checkpoint.mjs`. Digest calculation is exactly SHA256 of `JSON.stringify(state)`; historical property order and unknown original fields are preserved. Each successful revision links the prior digest. It preserves the fixed Base mainnet/canonical USDC/Treasury identity, original inclusive origin, immutable receipt identities and original corrections. It refuses a regressing cursor.

The exported `checkpointRevisionDigest` and `validateCustodyRevision` use Web Crypto and the original validator, with no Node imports. They can be reused by a separately reviewed Worker transport. This is code portability, **not** proof that a Worker endpoint or remote state is already configured.

## Small transport interface

```js
const checkpointStore = continuousCheckpointStore({
  authority,                      // explicitly reviewed and authenticated transport
  originBlock: approvedOrigin,    // original inclusive origin; never a moving lookback
  minimumRevision: { version: approvedVersion, digest: approvedDigest },
  readTimeoutMs: 15000,
  writeTimeoutMs: 15000,
});
```

The injected `authority` has only three methods:

| Method | Required result and semantics |
| --- | --- |
| `listRevisions({cursor, limit, signal})` | `{versions: number[], cursor: string \| null}`. Complete strongly consistent inventory of this exact approved checkpoint scope. `null` cursor alone means final page; errors cannot be translated into an empty list. |
| `getRevision(version, {signal})` | `{body: ReadableStream<Uint8Array>}` or confirmed absence `null`. Auth/provider failure is an error. A revision listed in the inventory must exist. A `json()`-only shortcut is rejected. |
| `putRevisionIfAbsent(version, bytes, {signal})` | Atomic conditional create of the one immutable revision key; `{created: boolean}`. It must never overwrite an existing revision. All writers must use the same original scope and protocol. |

No HTTP endpoint, provider credentials or storage API shape is invented here. The remote implementation must demonstrate these semantics before activation. An ordinary last-writer-wins object PUT does **not** satisfy this interface.

For an independently audited empty scope only, `minimumRevision: null, allowBootstrap: true` explicitly permits first revision creation with the pinned origin. Omitting both the existing trusted floor and explicit bootstrap fails closed. A 404, missing credential, empty artifact list or a recent rolling-window scan is not bootstrap authorization.

For an existing scope, pass a trusted original revision version/digest from verified history. The bridge checks the full chain and raises its in-memory floor as it observes newer revisions. That in-memory floor is **not durable across process restart**. The transport's immutable/no-delete policy and the externally retained approved floor therefore remain real activation requirements. All existing canonical writers and custody paths must be identified; an uncoordinated writer or unapproved deletion capability invalidates qualification.

## Write uncertainty and recovery

1. Read and validate complete original history before choosing the next version. A stale expected version returns conflict without writing.
2. Send exactly one conditional-create request. No automatic resend is made after a timeout, malformed acknowledgement or connection failure.
3. Read authoritative history again. Exact original candidate digest, previous digest and revision identity must be present before a lost acknowledgement can be treated as persisted state. This establishes persistence, not which caller won an identical candidate race.
4. Missing, unavailable or corrupt readback leaves `pending_write` and `write_state: unknown`. The same bridge refuses further writes. An explicit `read()` performs only authority readback; it resolves the pending candidate when the original revision or a different immutable winner is present. No lock is deleted and no original evidence is overwritten.
5. A late write remains constrained by atomic create-if-absent. It cannot overwrite a revision committed by another writer. A restarted process begins with a full authoritative read and the configured floor, never an assumed empty state or blind retry of a prior write. The transport must preserve this condition even if it cannot cancel a request already accepted by the provider.

`getObservability()` exposes only scope, original origin, version/digest metadata, last confirmed cursor and pending write identity. Revenue/cost/margin are always `null`. It is not a second ledger. Persisting or displaying this observation alone cannot advance the financial checkpoint.

The original reconciler keeps its partial-progress semantics: confirmed chunks retain the original cursor; later RPC failure reports incomplete coverage and unknown totals. Unknown persistence reports `checkpoint_write_status: unknown_readback_required` with no claimed final checkpoint or zero receipts. Receipt candidates still require separate settlement, delivery, owner/test exclusion and cost reconciliation before customer revenue or margin can be recognized.

## Bounds and release conditions

- Maximum 100 inventory pages, 1,000 versions per page, 10,000 revisions total, 16,000,000 actual bytes per revision and 64,000,000 actual bytes per history read. Duplicate versions, cyclic cursors, gaps, malformed UTF-8/JSON and missing listed revisions fail closed. Declared size cannot bypass actual streamed-byte counting.
- A full authority read has a finite timeout. A CAS operation performs at most a pre-read, one bounded write and one bounded readback (defaults: up to 45 seconds of authority waits, plus bounded local validation work). The caller's task budget must reserve this interval. Aborted read continuations cannot start a later write. An accepted remote write may finish late, which is why readback and immutable conditional creation are mandatory.
- Full-history verification deliberately favors correctness over throughput. Repeated CAS calls reread retained history; capacity/latency exhaustion stops the scan. No automatic archive, pruning, checkpoint truncation or origin reset is implemented. A larger custody/compaction strategy requires its own reviewed proof and authorization.
- Before production: identify the exact existing checkpoint authority/history and floor; prove authenticated scope, complete listing, immutable retention and atomic concurrent conditional creation using the selected provider; verify readback/lost-ACK behavior; review least-privilege credentials and privacy. The user's follow-on request includes system deployment, but current Cloudflare OAuth/readback and exact existing-history migration qualification remain outstanding. No secrets belong in a file or report.
- The follow-on local implementation now wires the CLI through `DELTA_TREASURY_STATE_MODE=remote`, a fixed-origin HTTP authority and the private Core router. It rejects simultaneous local state or caller-selected origin and never silently falls back to a rolling scan. The existing Pulse passes the explicit mode and a step-scoped provider secret. These changes are **local integration / remote custody not activated / continuous production coverage unverified**.

## Isolated evidence

`tests/treasury-checkpoint-store.test.mjs` exercises original local revision compatibility, scope/origin/floor validation, complete pagination, chain gaps, concurrent writers, stale CAS, lost acknowledgements, unknown writes, late writes, missing/corrupt/stalled bodies, bounded retained history, and original reconcile interruption/resume with one unique Treasury receipt. All authorities and RPC responses are synthetic; no provider, production storage, paid request or workflow is contacted.

The first targeted run `03-custody-bridge-test-1` passed 55 tests across the new bridge and unchanged continuity/observability suites. `03-custody-bridge-test-2` passed 56 tests after cumulative actual-byte/inventory-limit coverage was added. Final labels and source identity are recorded separately after independent review; these runs are not deployment or provider qualification claims.
