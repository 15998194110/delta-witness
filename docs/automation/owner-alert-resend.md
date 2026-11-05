# P0-2: concrete owner-alert transport and remaining activation gate

### Sending-only credential and signed receipts (candidate)

The default mode is `native_read` and retains native GET readback. For an explicitly isolated sending credential set `OPERATIONS_ALERT_RESEND_MODE=sending_only`. Select `sending_access` and restrict the key to the verified sending subdomain in the provider dashboard. Subscribe the signed endpoint to `email.delivered`, `email.bounced`, `email.failed` and `email.suppressed`. The webhook must be enabled with a valid signing-secret binding. [Resend API key permissions](https://resend.com/docs/api-reference/api-keys/create-api-key) and [signed delivered-event fields](https://resend.com/docs/webhooks/emails/delivered).

The operator retains the provider's observed domain verification, sending capability and key-domain assignment as private release evidence. Write the following JSON snapshot to private R2 only after verifying those facts. Compute `digest = sha256(stableJson(snapshot))` using DELTA’s existing prefixed SHA-256 and sorted-key serializer. Set `OPERATIONS_ALERT_RESEND_DOMAIN_EVIDENCE_DIGEST` to that digest and store the snapshot at `operations/alerts/resend-domain-approvals/<digest without sha256:>.json`. The application checks the snapshot against the digest on every adapter initialization and signed event. The reference also has to match the operator's existing configuration approval reference. The snapshot attests to a past provider observation. Key revocation or a current rejection still surfaces independently at send time.

```json
{
  "schema": "delta-resend-sending-domain/v1",
  "domain": "<exact sender subdomain>",
  "domain_id": "<actual provider domain UUID>",
  "status": "verified",
  "sending": "enabled",
  "key_permission": "sending_access",
  "key_domain_id": "<same provider domain UUID from key restriction>",
  "configuration_digest": "<DELTA sender, recipient and destination digest>",
  "verified_at": "<actual observation time in ISO UTC including milliseconds>",
  "evidence_ref": "<private immutable release evidence reference>"
}
```

The scoped transport issues only the original POST. An acknowledged POST stores its provider ID as accepted. A Svix-verified terminal event with that exact ID, sender, recipient, subject and tags first saves immutable receipt custody, then conditionally updates the original transport. The next outbox pass reads that durable state. Replaying the same callback can finish an interrupted transition. Provider delivery and recipient acknowledgment remain separate. A lost POST response without an original ID remains unconfirmed and requires provider-side investigation. Do not repost it. If the provider stops retrying before custody/transport convergence, replay the original signed event through provider controls. Opposing terminal outcomes preserve the first transport result and both signed event records for investigation. No domain, key, secret, runtime flag or production evidence is created by the candidate.

`src/operating-alert-resend.ts` implements the real Resend HTTP API behind the existing owner-alert outbox. It does not create an account, register a domain, enable billing, configure a production credential, activate a scheduler, or send an email by importing the module. The existing Watch/customer-webhook contract remains separate.

## Current audit and external status

**Current follow-up, 2026-11-04:** the owner has explicitly confirmed receiver `ruphussten85@gmail.com`. One authorized interactive Gmail message, `DELTA 通知通道验证 DW-NOTIFY-20261104-01`, was sent at `2026-11-04T12:41:39Z`; message/thread ID `1a1a6944db78aee7`. Independent native message/thread readbacks observed `SENT`, `INBOX` and `UNREAD` in that same connected mailbox. [Recorded connector evidence](../../../DELTA-release-approval-20261104/DELIVERY-CLOSURE-20261104/owner-mail-evidence.json) is a summary of authenticated observations, not a signed provider delivery receipt. This is an interactive self-message inbox verification only: human ACK, Resend-native delivery, Cloudflare Cron → Outbox → provider delivery and independent deadman delivery remain unverified. The new runtime is not deployed; flags remain default-off and production remains NO_GO. See the [current monitoring follow-up](../../DELTA_MONITORING_AND_ALERTING.md).

The historical repository audit found only opaque `OPERATIONS_ALERT_DESTINATION_ID` and `OPERATIONS_ALERT_DESTINATION_DIGEST`, plus the private outbox; it had not yet established the concrete receiver now confirmed above. An approved Resend sender/domain and runtime credential still have not been verified. Only relevant environment-variable **names** were inspected; no secret values or credential files were read. The connected ChatGPT/Gmail session is not a transferable Cloudflare runtime credential.

Consequently, **the autonomous Core/Resend owner-delivery path has not been exercised or accepted externally**. P0-2 remains blocked on an explicitly approved existing sender/domain, provider-managed credential with sending and native readback/domain permission, exact destination configuration digest, and verified original-provider receipt plus separate owner ACK. No domain, account or paid subscription is invented to remove that blocker. Credentials belong in provider secret management, never chat, source, Actions logs or test evidence.

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

The current local candidate fixes the historical two-reference total quota: delivered/acknowledged history previously consumed the same capacity as active delivery. Each invocation now walks two-reference pages with hard caps of **32 references scanned, 8 active sends/original readbacks combined, 48 provider requests, 160 original R2 metadata reads and 2,000,000 aggregate metadata bytes**. Native provider access is checked once per invocation. Each active episode has at most fifteen seconds, further bounded by the remaining **35-second work budget**; the whole consumer retains a **50-second fence**. Terminal history does not consume active capacity. The normal Treasury producer remains at four selected events per invocation; no new loop or provider is introduced.

An unattempted blocked episode can bind the approved exact destination through the existing enqueue function; its notification identity remains unchanged. Delivered/acknowledged entries are skipped; an unacknowledged terminal failure remains counted as failed/degraded on subsequent observations. The existing v1 opaque R2 cursor/CAS rotates through complete pages and wraps; a partly processed page retains its input continuation. Cancellation prevents a stalled source/provider response from starting a late send. Limits may be reached after an original send becomes uncertain: that remains `unknown` and requires original-operation readback, not a replacement POST or a promise of automatic delivery recovery.

Run observations explicitly label `counts_scope=this_run_observations_not_cumulative`, separate newly observed delivery from already-terminal delivery/ACK, and expose remaining inventory and oldest pending observed time. Signed webhook custody is still separate from native Outbox promotion. Do not sum repeated observations or treat a later native `opened`/`clicked` event as owner ACK or a substitute for historical delivered custody. [Current audit](../../../DELIVERY-CLOSURE-20261104/monitor-2057/audit.md), [source/log hashes](../../../DELIVERY-CLOSURE-20261104/monitor-2057/manifest.json) and [73-test offline result](../../../DELIVERY-CLOSURE-20261104/monitor-2057/tests.log) document these local corrections; the historical test runs below remain historical evidence.

A create-only run observation is independently read back before cursor CAS. A failed reference can advance the bookkeeping cursor only after a separate immutable hole record has been successfully read back under its exact original key. The hole uses the same operational namespace, carries only the validated original reference, run/phase, original identity when independently verified, and hashes of any source bytes/ETag read. It copies no arbitrary source text or exception body. It grants no dispatch, retry, payment, lease takeover or recipient ACK authority and never changes or removes the original episode.

Hole persistence has its own four-second budget inside the existing fifty-second global fence. Lost write ACK triggers only same-key readback. If the hole cannot be confirmed, or storage is generally unavailable, the input cursor is retained. After a confirmed hole, the run remains `degraded`, `page_complete:false`, `inventory_complete:false` with explicit bounded `hole_refs` and unresolved-reference count; a successful pagination checkpoint cannot make the page healthy. Subsequent pages can therefore serve the third and later original episodes even while the first remains unreadable. The same consumer wraps back to the unresolved original reference and can later recover it through its original notification ID. Earlier holes remain immutable historical evidence. No second outbox or separate retry loop is created.

An original provider outcome that is durably known to remain uncertain can also be revisited on a later pass without a new POST or notification identity. No complete historical inventory or human delivery is inferred from scanning. Historical inventory growth still increases sweep latency, and eight active operations can be consumed by one send plus one later readback for four new events. This is a bounded consumer, not an unlimited queue throughput or fixed delivery-time SLA; measure backlog, provider quota and actual latency before expansion.

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
