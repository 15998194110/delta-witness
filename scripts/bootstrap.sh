#!/usr/bin/env bash
set -euo pipefail
npx wrangler r2 bucket create delta-witness-proofs || true
npx wrangler types
echo "DELTA resources prepared. Next: npm run deploy"
