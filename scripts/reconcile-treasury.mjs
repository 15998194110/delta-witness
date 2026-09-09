const TREASURY = '0x1990e21bc219696ff7fbc26527dbaed335ac6367'.toLowerCase();
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'.toLowerCase();
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TO_TOPIC = `0x${TREASURY.slice(2).padStart(64, '0')}`;
const LOOKBACK_BLOCKS = Number(process.env.DELTA_TREASURY_LOOKBACK_BLOCKS || 50000);
const CHUNK_BLOCKS = Math.max(1, Math.min(Number(process.env.DELTA_TREASURY_CHUNK_BLOCKS || 1900), 1900));
const RPCS = [
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
];

// These addresses have positive first-party/platform evidence tying them to
// verification probes rather than independent customer purchases. Receipts
// remain canonical treasury_received events, but must never be recognized as
// customer revenue unless contrary evidence is established and this map is
// deliberately revised.
const KNOWN_NON_CUSTOMER_PAYERS = new Map([
  ['0x54e163e9b8edda194d83f46add921bfa5fc5f4e0', 'nohumans_platform_verification'],
  ['0x7e6b6556322c4e26c567a867964ac793f5ee2b1c', 'payapi_platform_verification'],
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc(method, params) {
  let lastError;
  for (const url of RPCS) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(12000),
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`${url} HTTP ${response.status}: ${text.slice(0, 200)}`);
        const json = JSON.parse(text);
        if (json.error) throw new Error(`${url} RPC ${JSON.stringify(json.error)}`);
        return { url, result: json.result };
      } catch (error) {
        lastError = error;
        console.error(JSON.stringify({
          event: 'treasury_rpc_degraded',
          method,
          url,
          attempt,
          error: String(error),
        }));
        await sleep(700 * attempt);
      }
    }
  }
  throw lastError || new Error('all Base RPC providers failed');
}

const latestResponse = await rpc('eth_blockNumber', []);
const latestBlock = parseInt(latestResponse.result, 16);
const startBlock = Math.max(0, latestBlock - LOOKBACK_BLOCKS + 1);
const logs = [];

for (let fromBlock = startBlock; fromBlock <= latestBlock; fromBlock += CHUNK_BLOCKS) {
  const toBlock = Math.min(fromBlock + CHUNK_BLOCKS - 1, latestBlock);
  const filter = {
    address: USDC,
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: `0x${toBlock.toString(16)}`,
    topics: [TRANSFER_TOPIC, null, TO_TOPIC],
  };
  const response = await rpc('eth_getLogs', [filter]);
  console.error(JSON.stringify({
    event: 'treasury_chunk_ok',
    from_block: fromBlock,
    to_block: toBlock,
    rpc: response.url,
    logs: response.result.length,
  }));
  logs.push(...response.result);
}

const unique = [...new Map(logs.map((log) => [`${log.transactionHash}:${log.logIndex}`, log])).values()];
const transfers = unique.map((log) => {
  const from = `0x${log.topics[1].slice(-40)}`.toLowerCase();
  const payerClassification = KNOWN_NON_CUSTOMER_PAYERS.get(from) || 'unclassified';
  return {
    tx_hash: log.transactionHash,
    block_number: parseInt(log.blockNumber, 16),
    log_index: parseInt(log.logIndex, 16),
    from,
    to: `0x${log.topics[2].slice(-40)}`.toLowerCase(),
    raw_amount: BigInt(log.data).toString(),
    usdc: Number(BigInt(log.data)) / 1e6,
    treasury_received: true,
    payer_classification: payerClassification,
    customer_revenue: payerClassification === 'unclassified' ? 'unclassified' : false,
  };
}).sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index);

const totalRaw = transfers.reduce((sum, transfer) => sum + BigInt(transfer.raw_amount), 0n);
const knownNonCustomerRaw = transfers
  .filter((transfer) => transfer.customer_revenue === false)
  .reduce((sum, transfer) => sum + BigInt(transfer.raw_amount), 0n);
const unclassifiedRaw = transfers
  .filter((transfer) => transfer.customer_revenue === 'unclassified')
  .reduce((sum, transfer) => sum + BigInt(transfer.raw_amount), 0n);

console.log(JSON.stringify({
  ok: true,
  checked_at: new Date().toISOString(),
  network: 'eip155:8453',
  asset: USDC,
  treasury: TREASURY,
  start_block: startBlock,
  latest_block: latestBlock,
  lookback_blocks: LOOKBACK_BLOCKS,
  latest_rpc: latestResponse.url,
  treasury_received_candidates: transfers.length,
  total_raw: totalRaw.toString(),
  total_usdc: Number(totalRaw) / 1e6,
  known_non_customer_raw: knownNonCustomerRaw.toString(),
  known_non_customer_usdc: Number(knownNonCustomerRaw) / 1e6,
  unclassified_raw: unclassifiedRaw.toString(),
  unclassified_usdc: Number(unclassifiedRaw) / 1e6,
  revenue_classification: 'known platform/test payers are explicitly excluded; remaining receipts stay unclassified until non-project payer and DELTA proof/telemetry are reconciled',
  evidence_quality: 'A_direct_canonical_USDC_log',
  transfers,
}, null, 2));
