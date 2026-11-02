# D06 export authorization update: local contract and evidence

Status: **locally repaired and isolated tests passed; not published or production-accepted**. This is an additive follow-up to the sole v1.1 repair baseline. It does not replace earlier evidence or expand authorization to production.

The v1.1 D06-T03 requirement is “到期/撤销/超范围凭据失败；更新授权不会重复收费。” The implemented update uses the still-valid original order capability to issue and rotate a short-lived export-only credential. It does not attempt account recovery after all original authority is lost, require a new identity provider, re-sign payment, extend the purchased retention policy, or approve each purchase manually.

## Authority and storage

- The original order binding, payment fingerprint, settlement journal and fulfillment/proof evidence remain authoritative. Root `token_digest`, scopes, creation/expiry times and `orderAuthorityDigest` are unchanged.
- The original order index gains one optional `export_authorization` child record. It is a mutable authorization subrecord, not a second order, payment, delivery ledger or new financial truth.
- The Core stores only the child token digest. The caller generates and durably stores its child token and operation identity before issuing the single POST. Server responses expose only allowlisted metadata; no token or digest is returned.
- The root capability must remain valid, unrevoked and export-scoped. Only the root can manage the child grant. A child can download original artifacts only; it cannot read status, recover fulfillment, issue another grant, enroll an order or authorize a purchase.
- Rotating the child invalidates the previous child. The original root remains usable. Child generation is a safe integer and the caller supplies an expected generation; an older operation cannot roll a later grant back.

## HTTP wire

Both routes use `x-delta-recovery-token` with the original root token:

```text
GET  /v1/orders/:id/export-authorization
POST /v1/orders/:id/export-authorization
```

POST accepts exactly these JSON fields:

```json
{
  "operation_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "token": "<caller-generated canonical base64url encoding of 32 bytes>",
  "ttl_seconds": 900,
  "expected_generation": 0
}
```

The operation ID is UUIDv4. TTL is an integer from 60 through 3600 seconds; expected generation is a nonnegative safe integer below `Number.MAX_SAFE_INTEGER`. The new token must differ from both root and previous child. Payment headers, query parameters, untrusted browser origins, unexpected fields and oversized/malformed input are rejected.

GET before the first grant returns HTTP 200 with `{ "ok": true, "order_id": "…", "authorization": null }`. The implicit generation is zero. An existing grant returns:

```json
{
  "ok": true,
  "order_id": "11111111-1111-4111-8111-111111111111",
  "authorization": {
    "operation_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "generation": 1,
    "expires_at": "2026-11-02T15:01:00.000Z",
    "scope": ["export"],
    "state": "active"
  }
}
```

`state` is `active` or `expired` based on the child credential clock only. It is **not** an assurance that artifacts are still retained or exportable. Artifact delivery independently rechecks original settlement, complete fulfillment, purchased retention, manifest integrity and exact stored bytes.

New conditional-write success returns 201. The exact same operation/input returns 200 without another write or expiry extension, including after child expiry while root authority remains valid. A conflicting operation/generation returns 409. A storage/deadline outcome that cannot be confirmed returns a controlled 503. The client retains the same operation and queries GET; it does not infer permission to POST again from uncertainty or remote absence.

## Bounds and failure recovery

- One 15-second deadline covers authorization, request-body streaming, entitlement reads, conditional mutation and readback. Actual body limit is 2048 bytes; a stalled/unconsumed body is cancelled on deadline.
- Child expiry is the minimum of requested TTL, original root expiry and known original raw-artifact expiry. The one-hour technical ceiling never extends any business entitlement. Unknown historical retention is not turned into a new retention promise.
- A new grant requires an already complete, settlement-confirmed original delivery. A valid negative Guard result remains a completed delivery and can be exported; it is not reclassified as failure or charged again.
- Core uses the current original order ETag for one conditional write, then authenticates again before responding. There is no automatic write retry after lost acknowledgement. A provider may commit an already-dispatched write late; the same original operation is then discoverable through GET, with no subsequent capture/settlement continuation.
- Artifact export authenticates again after loading bounded, verified bytes. A grant rotation during a slow read prevents the old child from receiving those bytes.

The JavaScript SDK methods are `renewExportAuthorization(id, { ttlSeconds })`, `recoverExportAuthorization(id)` and explicit `exportArtifact(id, kind, { authorization: 'derived' })`. The default artifact path keeps original root authorization. Pending child operations are preserved in the existing private order store before POST. Restart and repeated renewal calls for an ambiguous pending operation use GET only; a missing or different readback is unresolved rather than authorization to rewrite.

## Actual local verification

Commands were reviewed before execution: installed `npm test` invokes only `vitest run`; `npm run check` invokes only `tsc --noEmit`. They ran through `Run-LocalCheck.ps1 -Offline`, with the outbound network guard and no real credentials, provider registration, signing or payments. In-memory R2, synthetic payment data, mocked facilitator and mocked Browser responses were used.

Evidence directory: `C:\Users\10122\Documents\ChatGPT\DELTA-repair-evidence-20261028`.

| Evidence label | Actual result | Scope |
| --- | --- | --- |
| `02-b6-export-authorization-test-3` | 117 passed, 3 files; source stable | 36 new authorization tests plus 81 existing order export/recovery tests |
| `02-b6-export-authorization-check-3` | TypeScript passed; source stable | Current primary typecheck |

The three actual SDK-to-Core cases run both Capture and negative Guard through one synthetic original payment, renew/expire/rotate the child, restart and download the exact original artifact, and prove the original authority/proofs remain unchanged. The lost-response case commits through the actual Core route, leaves the SDK operation pending, then confirms it after restart with GET only. All cases assert one original payment callback and no subsequent facilitator/network or Browser work.

The other new cases cover authentication isolation, revoked/expired/root scope failure, immutable same-operation readback, competing writers, stale-generation conflict, root/raw expiry clamps, unknown settlement, malformed/over-limit input, hanging reads/body/writes, late conditional commits, lost write acknowledgements and rotation during export.

Earlier observations remain preserved: `check-1` found the TypeScript decoder options mismatch; `test-1` found that a request body could remain uncancelled when the deadline expired before acquiring its reader. Both were fixed before the passing final runs. These earlier logs are not passing acceptance evidence.

The final targeted run and typecheck both recorded HEAD `90010302948a13f7ffa01824000a2ebba65b87a1` plus worktree fingerprint `9cdb24080ccaab6c300e8aa67591337319f69413d65c79c59b114c58cfb486a9`. Their log SHA256 values are respectively `2ead8be50fc6c1e715a81b4cc2cb2a2cb1b1ae560aaebf8fb443d528c784897a` and `59d90a2f4773d7879c77860734fe4731521d3a40c59b0197d38d490d2863743c`.

Independent read-only Core review by the accounting agent found no blocking defect in root/child separation, immutable payment authority, CAS/readback, deadline cancellation and final export reauthentication. The SDK/Core wire and canonical ISO dates were also read back; the actual integration tests provide runtime evidence beyond that review.

## Compatibility and remaining limits

Older Core versions do not implement this child authorization API and do not recognize child credentials. The exact `0dbf2b3963ff56641b96e95b8f358591514cb3c4` binary was exercised in two additional Capture/Guard cases: after current Core issues a child, fallback still permits original-root status/download, rejects child status/download, and returning current Core permits the same child's original bytes. All original storage objects remain unchanged across those reads, with zero new settlement/Browser calls. `02-b6-frozen-compatibility-1` passed 77 cases with 1 explicit internal-helper skip, including these two new cases. This is narrow downgrade/resume qualification; old Core does not support child management, and no production rollback was executed. Unsupported clients/servers must fail closed and preserve the original order rather than purchase again.

This local evidence does not prove production release, real-provider ETag/latency behavior, actual wallet authorization, monetary settlement, treasury receipt, customer usage or revenue. Loss of the original root capability remains unresolved and requires a separately authorized identity-recovery contract; it is not silently solved by this export-only update.
