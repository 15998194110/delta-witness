import { pathToFileURL } from 'node:url';
import { createRpcClient, reconcileTreasury, failure } from './treasury-reconciliation.mjs';
import { fileCheckpointStore } from './treasury-checkpoint.mjs';

// Importing this CLI is inert. State is opt-in and is never inferred from a
// marketing handoff, credential file, or a previously green workflow.
export async function runTreasuryCli(env = process.env, dependencies = {}) {
  const log = dependencies.log ?? (entry => console.error(JSON.stringify(entry)));
  const options = {
    lookbackBlocks: env.DELTA_TREASURY_LOOKBACK_BLOCKS || 50000,
    chunkBlocks: env.DELTA_TREASURY_CHUNK_BLOCKS || 1900,
    confirmations: env.DELTA_TREASURY_CONFIRMATIONS || 12,
    overlapBlocks: env.DELTA_TREASURY_OVERLAP_BLOCKS || 100,
    maxChunks: env.DELTA_TREASURY_MAX_CHUNKS || 100,
    scanTimeoutMs: env.DELTA_TREASURY_SCAN_TIMEOUT_MS || 180000,
    log,
  };
  if (env.DELTA_TREASURY_START_BLOCK && env.DELTA_TREASURY_CHECKPOINT_BLOCK) throw failure('ambiguous_initial_block');
  const initial = env.DELTA_TREASURY_START_BLOCK || env.DELTA_TREASURY_CHECKPOINT_BLOCK;
  if (initial !== undefined && initial !== '') options.initialBlock = initial;
  // CHECKPOINT_BLOCK compatibility means an explicit inclusive scan boundary,
  // not a fabricated persisted/block-hash-verified checkpoint.
  if (env.DELTA_TREASURY_STATE_DIRECTORY) options.checkpointStore = dependencies.checkpointStore ?? fileCheckpointStore(env.DELTA_TREASURY_STATE_DIRECTORY);
  options.rpc = dependencies.rpc ?? createRpcClient({ ...dependencies, scanTimeoutMs: options.scanTimeoutMs, log });
  return reconcileTreasury(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await runTreasuryCli();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, scan_complete: false, treasury_received_candidates: null, total_raw: null, recognized_customer_revenue_usdc: null, actual_variable_cost_usdc: null, actual_contribution_margin_usdc: null, category: error?.category ?? 'unknown' }));
    process.exitCode = 1;
  }
}
