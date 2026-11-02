# delta-witness-ruphussten

Python client for the same DELTA Core Capture/Preflight order contract. Quote, demo, proof and unsigned `payment_challenge`/`preflight_challenge` require no wallet. This source is a local release candidate; an existing PyPI version is not changed by these edits.

```python
from delta_witness import DeltaWitness, SQLiteOrderStore

# An absolute PRIVATE local path outside your checkout; restrict its OS ACL.
store = SQLiteOrderStore(private_database_path)
client = DeltaWitness(order_store=store)
quote = client.quote("capture")
order = client.prepare_order("capture", {"url": "https://example.com"},
    order_id=persisted_business_uuid,
    # Supply only when Core quote declares an accepted policy:
    retention_policy_hash=accepted_policy_hash)
result = client.execute_order(order["order_id"], buyer_authorized_transport)
```

The caller preserves its UUIDv4 before calling prepare. The SQLite store atomically saves identity/request/capability, then `signing_started` before the first payment callback. It uses parameterized SQL, `BEGIN IMMEDIATE` and FULL synchronous commits; separate local processes share CAS. Keep the database, including interrupted transactions, across restarts. Recovery tokens are bearer credentials; never print, commit, upload or send the database to support. SQLite journal files inherit the containing directory protection; Windows ACL configuration is the owner's responsibility. Network filesystem/crash-power-loss guarantees are not qualified here.

After any uncertain outcome, recreate the client against that same store and call `recover_order(order_id)` or `execute_order` with the **same** ID. Recovery performs authenticated Core GET and at most one recovery POST; it never invokes a payment transport. Unknown/missing/expired orders stay unconfirmed, not unpaid. A completed cache is also rechecked at Core. Original negative Preflight results remain negative. A deliberate new purchase uses a new caller business ID; changing body/origin/accepted policy on the old ID is rejected.

`export_artifact(order_id, "html" | "markdown" | "screenshot" | "manifest")` returns bounded hash-checked bytes and a safe filename without rendering/executing content or exposing the capability. Core enforces entitlement/expiry. A checksum verifies transport integrity, not independent authenticity or truth. Private exports are not put in public proof URLs.

To update an export-only credential, keep the original capability in the same private store and preserve a new caller operation UUIDv4. Call `prepare_export_authorization(order_id, operation_id=operation_uuid, ttl_seconds=300)` and then `execute_export_authorization(order_id)`. Preparation reads the current Core generation and durably saves the new random token and expected generation before the one unsigned update POST. The public result contains metadata only. After a lost response or restart, `recover_export_authorization(order_id)` only reads back that operation; repeating execute also performs readback once its attempted marker exists. Pending operations cannot be overwritten with a new operation. Expired/revoked original capabilities cannot authorize updates, and a child credential cannot extend original access or retention.

`export_artifact(order_id, "html", use_export_authorization=True)` explicitly uses the confirmed child credential and never falls back to the original after a rejection. Defaults preserve the existing original-capability export. A deliberate later rotation needs a new operation UUID; the previous child credential then fails at Core. The technical requested lifetime is 60–3600 seconds, further capped by original access and artifact retention. Updating authorization never calls the payment transport or changes the original order phase. Older client versions do not understand this optional private-record field; preserve the current client/store together for this feature. This feature does not recover a lost original identity or make a production availability promise.

The SDK intentionally has no wallet custody or built-in signing dependency. `buyer_authorized_transport` must implement:

```python
def transport(method, url, *, headers, body, timeout, active):
    # Buyer-owned x402 client must enforce owner policy, exact product price,
    # Base eip155:8453, canonical USDC, Treasury and bound resource/request.
    # Disable redirects, bound headers + body by timeout, and check active()
    # immediately before signing/sending. Never internally re-sign/retry.
    return http_status, response_headers, response_bytes
```

Current seller prices remain Capture 1 / Preflight 5 USDC. They do not authorize spending. Existing buyer preauthorization can fund automatic execution; this client does not require per-order human approval. The SDK invokes the paid transport once per prepared order and never adds retry/backoff. An opaque callback that ignores `active()` or internally signs twice is outside this guarantee. Deadline expiry returns uncertainty; Python cannot forcibly terminate arbitrary callback code. At most eight outstanding callbacks per process are allowed, so hung callbacks do not grow threads without bound. If all eight remain hung, new transport calls fail closed until callbacks return or the process restarts; the original private order database must be preserved on restart. Default unsigned httpx transport has streaming byte/time checks and redirects disabled.

Pure fixture tests plus installed httpx MockTransport tests are in `tests/test_orders.py`. `scripts/verify_build.py` builds local wheel/sdist without network, compares archive bytes to source, and imports the wheel for a mocked httpx smoke. No test pays, signs, contacts production or publishes. Python private records use `delta-python-client-order/v1`; wire API matches JS/MCP but local database formats are not interchangeable. Legacy Python discovery calls remain available; returning 200 to an unpaid challenge is now rejected as an invalid challenge rather than mislabeled success.
