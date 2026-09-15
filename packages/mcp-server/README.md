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

Tools: `delta_quote`, `delta_capture`, `delta_preflight`, and `delta_verify_proof`.

`delta_preflight` observes and compares a public page before a consequential action; it is not a security audit and does not authorize the downstream action. A successful DELTA response should remain one input to the caller's own approval policy.

## Publication status

This README describes the current repository source. A source commit does not modify an immutable published npm version. Verify the installed package version and its contents independently; do not describe a source correction as published or production-verified until that version has been published and read back. No real-wallet payment is part of the repository's offline tests.
