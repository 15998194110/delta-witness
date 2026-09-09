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
        "DELTA_MAX_USD_PER_CALL": "0.10"
      }
    }
  }
}
```

Use a separate low-balance buyer wallet funded with Base mainnet USDC. Never use the DELTA Treasury wallet, never commit this value, and never paste a seed phrase or private key into chat. The process restricts payments to exact x402 on Base mainnet, DELTA's published Treasury address, recognized default assets, and the configured per-call USD cap.

The example cap of **0.10 USDC is intentionally conservative**. It permits the current public Capture price (0.03 USDC) but will reject the current public Preflight price (1 USDC). This is a buyer-side safety control, not a DELTA pricing error.

Before enabling a paid Preflight, first call `delta_quote` and inspect the fresh production quote. If the buyer deliberately approves the current 1 USDC public Preflight experiment, set:

```json
"DELTA_MAX_USD_PER_CALL": "1.00"
```

Do not raise the cap merely to make a failed payment go through. The buyer should re-check the live quote, Base mainnet network, canonical USDC, and DELTA Treasury before authorizing a higher cap. An old quote is not authorization for a later changed price.

Tools: `delta_quote`, `delta_capture`, `delta_preflight`, and `delta_verify_proof`.

`delta_preflight` observes and compares a public page before a consequential action; it is not a security audit and does not authorize the downstream action. A successful DELTA response should remain one input to the caller's own approval policy.
