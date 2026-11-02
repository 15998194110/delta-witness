# DELTA Witness MCP

Local stdio MCP server exposing free quote/proof tools and paid Capture + Public Preflight observations backed by the production DELTA core API.

## Enable Capture at its current 1 USDC price

```json
{
  "mcpServers": {
    "delta-witness": {
      "command": "npx",
      "args": ["-y", "delta-witness-mcp@latest"],
      "env": {
        "EVM_PRIVATE_KEY": "stored locally by your MCP host",
        "DELTA_MAX_USD_PER_CALL": "1.00"
      }
    }
  }
}
```

This is an explicit buyer approval for the current **1 USDC Capture**. Quote and proof tools remain free. Obtain `delta_quote` first, then call `delta_capture` with a public URL when you approve that price. The current source restricts each Capture payment to exactly `1000000` raw canonical Base USDC even when the buyer configures a higher per-call budget.

## Enable Public Preflight at its current 5 USDC price

After inspecting `delta_quote` for `preflight` and deliberately approving the price, configure:

```json
"DELTA_MAX_USD_PER_CALL": "5.00"
```

Then `delta_preflight` pays exactly `5000000` raw canonical Base USDC. Capture remains exactly 1 USDC; raising the approved ceiling does not increase Capture's charge.

Current public list prices are **1 USDC Capture / 5 USDC Public Preflight / 10 USDC Guarded-Action Pilot**. The Guarded-Action Pilot is a separate HTTP product and is not exposed as a paid tool in this MCP package. Authenticated Partner Capture, Partner Preflight and each new Watch check cost 1 USDC in the separate partner flow.

## Buyer approval and payment destination

Use a separate low-balance buyer wallet funded with Base mainnet USDC. Never use the DELTA Treasury wallet, commit the private key, or paste a seed phrase/private key into chat. Store the buyer key only in the local MCP host's protected environment.

The current source has **no implicit numerical spending allowance** when `DELTA_MAX_USD_PER_CALL` is omitted. It reports the selected product's current price and requests explicit buyer approval before constructing a signer or attempting payment. An existing lower buyer-set budget is never silently increased. The example above already provides the explicit approval needed for Capture.

Before signing, the current source requires exact x402, Base `eip155:8453`, canonical USDC `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`, Treasury `0x1990e21bc219696ff7fbc26527dbaed335ac6367`, and the exact amount for the selected product. A fresh changed price requires fresh approval and an updated verified seller policy, not an automatic budget increase.

Legacy tools: `delta_quote`, `delta_capture`, `delta_preflight`, and `delta_verify_proof`.

## Durable original orders (local candidate, requires matching Core release)

Configure `DELTA_ORDER_STORE_DIR` as an absolute private directory outside a checkout. The directory contains bearer recovery capabilities; restrict its Windows ACL or Unix owner permissions, preserve it across process restarts, and never upload it to chat, source control, or shared storage. Mode bits alone do not establish Windows ACLs. The append-only revision store uses create-only files, fsync and CAS; partial/corrupt revisions fail closed. It never deletes a lock or revision to retry payment. Local filesystem atomic creation is required; network shares are not qualified.

An agent operating under the existing approved budget can automate this sequence without new human approval:

1. Persist a UUIDv4 business order ID in the caller's own workflow. Call `delta_prepare_order` with that ID, `product` (`capture` or `preflight`) and URL/expectations. Preparation is free; if quote declares a retention policy, pass its accepted `retention_policy_hash`. A changed request or policy cannot reuse the ID.
2. Call `delta_execute_order` with the same ID. The shared JS client persists `signing_started` before invoking the existing exact-price x402 signer once. Budget and signing-key rules above still apply.
3. Following a timeout, restart, missing response or uncertain status, call `delta_recover_order` with the same ID (or execute that original ID again). Core lookup/recovery never signs, needs no signing key/budget, and a 404/410/503 does not authorize another purchase.
4. Call `delta_export_order_artifact` with the original ID and `html`, `markdown`, `screenshot` or `manifest`. Authenticated, bounded, hash-checked bytes are saved as opaque files under the store's `exports` directory. Output includes path/hash/size, not file contents or recovery credentials. Existing identical exports are reused; conflicting files are preserved and reported.

The caller must preserve its ID before tool invocation: losing all local storage does not establish that payment failed. Legacy `delta_capture`/`delta_preflight` remain compatible single-invocation tools; they do **not** gain restart recovery automatically. Do not retry an uncertain legacy call by generating a new durable order. Migrate new automated workflows to the durable tools; keep historical legacy attempts blocked until independently reconciled. There is no automatic migration or removal date.

The MCP build copies the exact shared JS SDK into `dist/order-client.js`; it does not maintain a second payment/recovery implementation. Repository tests import the same source. All records are local; Core remains authority for settlement/delivery/entitlements. No local cache is proof of Treasury receipt or recognized revenue.

`delta_preflight` observes and compares a public page before a consequential action; it is not a security audit and does not authorize the downstream action. A successful DELTA response should remain one input to the caller's own approval policy.

## Publication status

This README describes the current repository source. A source commit does not modify an immutable published npm version. Verify the installed package version and its contents independently; do not describe a source correction as published or production-verified until that version has been published and read back. No real-wallet payment is part of the repository's offline tests.
