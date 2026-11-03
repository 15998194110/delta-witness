# P0-2: concrete owner-alert transport and remaining activation gate

`src/operating-alert-resend.ts` implements the real Resend HTTP API behind the existing owner-alert outbox. It does not create an account, register a domain, enable billing, configure a production credential, activate a scheduler, or send an email by importing the module. The existing Watch/customer-webhook contract remains separate.

## Current audit and external status

Repository configuration previously contained only opaque `OPERATIONS_ALERT_DESTINATION_ID` and `OPERATIONS_ALERT_DESTINATION_DIGEST`, plus the private outbox. No approved sender mailbox, verified email provider domain, concrete owner delivery destination or runtime Resend credential was found in the audited source/configuration names. Only relevant environment-variable **names** were inspected; no secret values or credential files were read. The connected ChatGPT/Gmail session is not a transferable Cloudflare runtime credential.

Consequently, **actual external owner delivery has not been exercised or accepted**. P0-2 remains externally blocked on an explicitly approved existing sender/domain and owner destination, a provider-managed credential with both sending and native readback permission, and an actual verified receipt. No address, domain, account or paid subscription is invented to remove that blocker. Credentials belong in provider secret management, never chat, source, Actions logs or test evidence.

## Integration contract

`resendAlertConfigurationDigest({from,to,destination_id})` binds the provider, plain sender mailbox, exact one-recipient mailbox and opaque destination identity. Both `destination_digest` and `approved_configuration_digest` must equal it. `createResendAlertAdapter(env, config)` accepts:

```text
enabled
api_key                    provider secret only
from / to                  explicitly approved plain mailboxes
destination_id
destination_digest
approved_configuration_digest
approval_evidence_ref      private opaque approval reference
```

Disabled configuration returns before any I/O. Approval/configuration alone does not establish current provider access: construction verifies authenticated `GET /emails?limit=1`, then confirms the sender domain is `verified` with sending capability `enabled` using `GET /domains?limit=100`. The adapter must be constructed again after its short-lived permission observation expires. A send-only API key cannot support original-result readback, and is refused. Domain verification, available quota and ultimate mail-server acceptance remain distinct checks; native POST errors are not hidden by successful preflight.

No request-supplied API origin, destination, sender, attachment, HTML, CC or BCC is supported. Network calls are fixed to `https://api.resend.com`, redirects are refused, response streams are capped at128KiB and each HTTP exchange has a two-second deadline. The runtime API key remains in the transport closure only. Private R2 intent records store original notification identity, opaque incident metadata, request/configuration hashes, attempts and provider email ID; they do not store the key or raw mailbox strings.

## Actual bounded queue consumer

`src/operating-alert-delivery.ts` exports `processOwnerAlertQueue(env)`. It requires all of the existing cloud flag, outbox flag and new `OPERATIONS_ALERT_DELIVERY_ENABLED` to be true. It obtains the fixed configuration only from provider-managed runtime bindings: `OPERATIONS_ALERT_RESEND_API_KEY`, `OPERATIONS_ALERT_RESEND_FROM`, `OPERATIONS_ALERT_RESEND_TO`, `OPERATIONS_ALERT_RESEND_APPROVED_CONFIGURATION_DIGEST`, `OPERATIONS_ALERT_RESEND_APPROVAL_EVIDENCE_REF` and the existing opaque destination ID/digest. No configuration is enabled by this source change.

Each invocation verifies native provider access once, reads at most two original episode references, and processes at most two through the existing outbox claim. An unattempted blocked episode can bind the approved exact destination through the existing enqueue function; its notification identity remains unchanged. Delivered/acknowledged entries are skipped; an unacknowledged terminal failure remains counted as failed/degraded on subsequent observations. A persisted opaque R2 pagination cursor rotates through subsequent pages, then wraps. Each episode has a fifteen-second budget with storage and provider cancellation; a stalled first episode cannot start a late send while the next episode is being handled. The whole consumer has a fifty-second fence.

A create-only run observation is independently read back before cursor CAS. A failed reference can advance the bookkeeping cursor only after a separate immutable hole record has been successfully read back under its exact original key. The hole uses the same operational namespace, carries only the validated original reference, run/phase, original identity when independently verified, and hashes of any source bytes/ETag read. It copies no arbitrary source text or exception body. It grants no dispatch, retry, payment, lease takeover or recipient ACK authority and never changes or removes the original episode.

Hole persistence has its own four-second budget inside the existing fifty-second global fence. Lost write ACK triggers only same-key readback. If the hole cannot be confirmed, or storage is generally unavailable, the input cursor is retained. After a confirmed hole, the run remains `degraded`, `page_complete:false`, `inventory_complete:false` with explicit bounded `hole_refs` and unresolved-reference count; a successful pagination checkpoint cannot make the page healthy. Subsequent pages can therefore serve the third and later original episodes even while the first remains unreadable. The same consumer wraps back to the unresolved original reference and can later recover it through its original notification ID. Earlier holes remain immutable historical evidence. No second outbox or separate retry loop is created.

An original provider outcome that is durably known to remain uncertain can also be revisited on a later pass without a new POST or notification identity. No complete historical inventory or human delivery is inferred from scanning. This is a small bounded alert consumer, not an unlimited queue throughput or delivery-time SLA.

## Durable send, unknown outcome and native result

The existing outbox CAS grants one original send. Before HTTP POST, the adapter persists an original transport intent and conditionally claims the exact attempt. Lost or uncertain claim acknowledgment grants no POST. The provider request uses one immutable payload and `Idempotency-Key: delta-alert/<original-notification-id>`.

An acknowledged `POST /emails` with native email ID is **provider accepted**, not delivered. Later `GET /emails/<id>` validates the exact sender, single recipient, subject, plain body, original tags and creation time. `last_event=delivered` means the recipient's **mail server** accepted the message; it does not acknowledge that the human owner read or acted on it. Human ACK remains the existing explicit, authenticated original-episode/payload operation. `opened` or `clicked` does not become human ACK.

When the POST acknowledgment is lost, later processing performs GET only: at most two pages of100 sent-email references are searched for the exact original correlation subject/sender/recipient, then the candidate's native content/tags are retrieved and checked. Multiple matches, mismatched content, truncated/empty search or missing metadata remain unknown. Absence never authorizes another POST, including after Resend's24-hour idempotency retention expires.

One retry is permitted only after a native explicit `rate_limit_exceeded` rejection, original GET readback and bounded backoff under the same body/key. At most two POST attempts occur in that original processing call. Daily/monthly quota rejection never upgrades the account or retries a new purchase. HTTP409 in-progress/conflict, 5xx, timeout, invalid result and missing ACK remain uncertain and are not blindly re-POSTed.

The shared `AlertReceipt` now distinguishes native delivery `failed` from `not_applied`. Bounced/failed/canceled/suppressed native emails are terminal delivery failures; they do not falsely claim the provider never processed a send and do not authorize automatic resend. Existing accepted/delivered/failed state and explicit owner acknowledgment remain independent.

## Evidence and acceptance

`08-p0-resend-target-1` passed50 tests in two files. The follow-up with the actual bounded consumer, `08-p0-resend-target-2`, passed **56 tests in two files** under the reviewed network-denied runner. Provider calls were explicit local transport doubles; no external API call or actual email was used. Scenarios include disabled/unapproved configuration, read/domain permission, accepted versus delivered versus ACK, parallel dispatch, original POST acknowledgment loss, key-expiry ambiguity, exact-content mismatch, native terminal failure, explicit rate rejection/backoff caps, unknown409/5xx, lost CAS acknowledgment, canceled late HTTP response, redirects and payload limits. Consumer tests cover default-off behavior, persistent next-page continuation, temporary native rejection, original-unknown revisits, uncertain observation ACK and stalled-first/healthy-second isolation. The isolated result is local protocol/recovery evidence, not production/native provider acceptance. Root's final unchanged-source combined tests remain required for shared-tree changes.

The bounded fault-isolation follow-up, `08-p0-resend-holes-target-1`, passed **61 tests in two files**, including the retained terminal-failure/degraded contract, a permanently stalled first reference with the third served on the next page, later wrap recovery using the unchanged notification ID, immutable original/hole bytes, same-key hole ACK-loss recovery, absent/unreadable hole evidence retaining the cursor, and the four-second hole timeout rejecting retroactive cursor advancement. `08-p0-resend-holes-check-1` passed the shared TypeScript check. Both actual runs recorded `source_stable:true` with fingerprint `f36e0deef6cfc271b9fa495390e5cb174c01d3875b89cc393648f4624e7cadb7`. These local runs authorize no activation or external send.

Release acceptance still requires a single authorized owner notification through the exact configured provider, durable original notification and native email ID, independently read native delivery status, and separately an explicit owner ACK where requested. Repeating the same event must produce no second email; an unavailable provider/readback must leave a durable unknown/failed state while independent Core, Treasury and other monitor lanes continue.

Official contracts verified during implementation: [send email](https://resend.com/docs/api-reference/emails/send-email), [native retrieve](https://resend.com/docs/api-reference/emails/retrieve-email), [sent-email pagination](https://resend.com/docs/api-reference/emails/list-emails), [24-hour idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), [native error classes](https://resend.com/docs/api-reference/errors), [domain state](https://resend.com/docs/api-reference/domains/list-domains), [API key permission scopes](https://resend.com/docs/api-reference/api-keys/create-api-key), [delivery semantics](https://resend.com/docs/webhooks/event-types). These documents establish protocol behavior, not ownership of any DELTA provider account or current production activation.
