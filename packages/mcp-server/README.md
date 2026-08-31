# DELTA Witness MCP

Local stdio MCP server exposing free quote/proof tools and paid Capture + Guard tools backed by the production DELTA core API.

```json
{
  "mcpServers": {
    "delta-witness": {
      "command": "npx",
      "args": ["-y", "delta-witness-mcp@0.6.0"],
      "env": {
        "EVM_PRIVATE_KEY": "stored locally by your MCP host",
        "DELTA_MAX_USD_PER_CALL": "0.10"
      }
    }
  }
}
```

Use a separate low-balance buyer wallet funded with Base mainnet USDC. Never use the DELTA Treasury wallet, never commit this value, and never paste a seed phrase or private key into chat. The process restricts payments to exact x402 on Base mainnet, DELTA's published Treasury address, recognized default assets, and the configured per-call USD cap.

Tools: `delta_quote`, `delta_capture`, `delta_preflight`, and `delta_verify_proof`.
