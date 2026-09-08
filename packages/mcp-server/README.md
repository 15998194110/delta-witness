# DELTA Witness MCP

Local stdio MCP server exposing free quote/proof tools and paid Capture + Guard preflight observations backed by the production DELTA core API.

```json
{
  "mcpServers": {
    "delta-witness": {
      "command": "npx",
      "args": ["-y", "delta-witness-mcp@0.6.1"],
      "env": {
        "EVM_PRIVATE_KEY": "stored locally by your MCP host",
        "DELTA_MAX_USD_PER_CALL": "0.10"
      }
    }
  }
}
```

Use a separate low-balance buyer wallet funded with Base mainnet USDC. Never use the DELTA Treasury wallet, never commit this value, and never paste a seed phrase or private key into chat. The process restricts payments to exact x402 on Base mainnet, DELTA's published Treasury address, recognized default assets, and the configured per-call USD cap.

`DELTA_MAX_USD_PER_CALL` is an operator-controlled spend ceiling, not a product price. Keep a conservative cap unless you deliberately intend to buy a higher-priced route. During the owner-approved public Preflight price experiment, Capture is 0.03 USDC and public Preflight is 1 USDC. The conservative `0.10` example above therefore permits Capture but intentionally blocks public Preflight. To allow a Preflight purchase, first call `delta_quote`, review the live terms, then explicitly raise the local cap to at least `1.00` only if that spend is authorized. The production 402 challenge remains the pricing authority; existing authenticated partner Preflight and Watch pricing are separate from this public MCP path.

Tools: `delta_quote`, `delta_capture`, `delta_preflight`, and `delta_verify_proof`.
