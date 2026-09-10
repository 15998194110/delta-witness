# DELTA Witness MCP

Local stdio MCP server exposing free quote/proof tools and paid Capture + Guard preflight observations backed by the production DELTA core API.

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

Use a separate low-balance buyer wallet funded with Base mainnet USDC. Never use the DELTA Treasury wallet, never commit this value, and never paste a seed phrase or private key into chat. The process restricts payments to exact x402 on Base mainnet, DELTA's published Treasury address, recognized default assets, and the configured per-call USD cap.

The example cap of **1.00 USDC** is a buyer-side safety control chosen to permit the current public Capture price while rejecting the higher-priced public Preflight route. Current public list prices are **$1 Capture / $5 Public Preflight / $10 Guarded-Action Pilot**. The Guarded-Action Pilot is not exposed as a paid MCP tool in this package.

Before enabling a paid Preflight, first call `delta_quote` and inspect the fresh production quote. If the buyer deliberately approves the current public Preflight price, set:

```json
"DELTA_MAX_USD_PER_CALL": "5.00"
```

The internal fallback remains deliberately conservative when no cap is supplied. Do not raise a buyer's cap merely to make a failed payment go through. Re-check the live quote, Base mainnet network, canonical USDC, and DELTA Treasury before authorizing a higher cap. An old quote is not authorization for a later changed price.

Tools: `delta_quote`, `delta_capture`, `delta_preflight`, and `delta_verify_proof`.

`delta_preflight` observes and compares a public page before a consequential action; it is not a security audit and does not authorize the downstream action. A successful DELTA response should remain one input to the caller's own approval policy.
