import { pathToFileURL } from 'node:url';
import { createRpcClient, NETWORK, quantity, reconcileTreasury, TO_TOPIC, TRANSFER_TOPIC, TREASURY, USDC } from './treasury-reconciliation.mjs';
import { createTreasuryHttpAuthority } from './treasury-custody-http.mjs';
import { continuousCheckpointStore } from './treasury-checkpoint-store.mjs';
import { validateTreasuryReport } from './validate-treasury-report.mjs';

// Read back by two Base providers at 2026-11-06T01:04:14Z. The inclusive
// boundary has zero matching transfers. Earlier history remains unverified.
export const ORIGIN_BLOCK = 53676533;
export const ORIGIN_HASH = '0x51a7a3b334bb9403187f7b75c202572f4ea8adb53eb43cd98b4ea4aac1b3e5dc';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export async function runPulseTreasury({ mode = 'window', writerSecret, baselineDigest, rpc = createRpcClient(), fetchImpl = fetch } = {}) {
  let phase = 'mode';
  let report;
  let passed = false;
  let firstRevisionDigest = null;
  try {
    if (!['window', 'bootstrap', 'remote'].includes(mode)) throw Error();
    const options = { rpc, confirmations: 12, overlapBlocks: 100, scanTimeoutMs: 180000 };
    if (mode !== 'window') {
      phase = 'activation_identity';
      if (typeof writerSecret !== 'string' || writerSecret.length < 32) throw Error();
      const authority = createTreasuryHttpAuthority({ secret: writerSecret, writerOnly: true, fetchImpl });
      const config = await authority.config();
      if (config.origin_block !== ORIGIN_BLOCK) throw Error();
      if (mode === 'bootstrap') {
        if (baselineDigest || !config.allow_bootstrap || config.minimum_revision !== null) throw Error();
      } else if (!/^[0-9a-f]{64}$/.test(baselineDigest ?? '') || config.allow_bootstrap ||
          config.minimum_revision?.version !== 1 || config.minimum_revision.digest !== baselineDigest) throw Error();
      phase = 'origin_header';
      const hex = '0x' + ORIGIN_BLOCK.toString(16);
      const origin = (await rpc('eth_getBlockByNumber', [hex, false])).result;
      if (origin?.number !== hex || origin.hash !== ORIGIN_HASH) throw Error();
      phase = 'custody_inventory';
      const store = continuousCheckpointStore({ authority, originBlock: ORIGIN_BLOCK,
        minimumRevision: config.minimum_revision, allowBootstrap: config.allow_bootstrap });
      if (mode === 'bootstrap') {
        // Bootstrap exactly one demonstrably empty finalized block. Never ingest an
        // old scan window into a new notification cursor or repeat an uncertain POST.
        if ((await store.read()) !== null) throw Error();
        phase = 'baseline_evidence';
        const priorHex = '0x' + (ORIGIN_BLOCK - 1).toString(16);
        const finalized = (await rpc('eth_getBlockByNumber', ['finalized', false])).result;
        const prior = (await rpc('eth_getBlockByNumber', [priorHex, false])).result;
        const logs = (await rpc('eth_getLogs', [{ fromBlock: hex, toBlock: hex, address: USDC, topics: [TRANSFER_TOPIC, null, TO_TOPIC] }])).result;
        const same = (await rpc('eth_getBlockByNumber', [hex, false])).result;
        const head = quantity((await rpc('eth_blockNumber', [])).result);
        if (quantity((await rpc('eth_chainId', [])).result) !== 8453 || quantity(finalized?.number) < ORIGIN_BLOCK ||
          head - ORIGIN_BLOCK < options.confirmations || prior?.number !== priorHex || prior.hash !== origin.parentHash ||
          !Array.isArray(logs) || logs.length !== 0 || same?.hash !== ORIGIN_HASH) throw Error();
        phase = 'baseline_persistence';
        const first = await store.compareAndSwap(null, { schema: 'delta-treasury-checkpoint/v1', network: NETWORK, asset: USDC, treasury: TREASURY,
          origin_block: ORIGIN_BLOCK, checked_through_block: ORIGIN_BLOCK, checked_through_hash: ORIGIN_HASH, reorg_anchor: { number: ORIGIN_BLOCK-1, hash: prior.hash },
          confirmation_depth: options.confirmations, checked_at: new Date().toISOString(), transfers: [], corrections: [] });
        if (first?.version !== 1 || first.previous_digest !== null) throw Error();
        firstRevisionDigest = first.digest;
        report = { origin_block: ORIGIN_BLOCK, start_block: ORIGIN_BLOCK, requested_through_block: ORIGIN_BLOCK, last_scanned_block: ORIGIN_BLOCK,
          checkpoint_revision: 1, checkpoint_after: ORIGIN_BLOCK };
        passed = true;
      } else {
        options.checkpointStore = store;
        options.initialBlock = ORIGIN_BLOCK;
      }
    }
    if (mode !== 'bootstrap') {
      phase = 'reconcile';
      report = await reconcileTreasury(options);
      phase = report.ok ? 'validate_evidence' : 'reconcile';
      passed = validateTreasuryReport(report, { requireContinuity: mode !== 'window' }).ok;
    }
  } catch {
    // Provider bodies, error messages, payment IDs and original evidence stay private.
  }
  return {
    schema: 'delta-public-treasury-range/v1', observed_at: new Date().toISOString(), ok: passed,
    mode: ['window','bootstrap','remote'].includes(mode) ? mode : 'invalid',
    state: passed ? (mode === 'bootstrap' ? 'empty_boundary_persisted' : 'range_verified') : 'unconfirmed', failure_stage: passed ? null : phase,
    origin_block: count(report?.origin_block), start_block: count(report?.start_block), requested_through_block: count(report?.requested_through_block),
    last_scanned_block: count(report?.last_scanned_block), checkpoint_revision: count(report?.checkpoint_revision), checkpoint_after: count(report?.checkpoint_after),
    baseline_digest: firstRevisionDigest, historical_coverage_before_origin: 'UNKNOWN', customer_revenue: 'UNKNOWN', contribution_margin: 'UNKNOWN'
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = await runPulseTreasury({ mode: process.env.DELTA_PULSE_TREASURY_MODE || 'window',
    writerSecret: process.env.DELTA_TREASURY_WRITER_SECRET, baselineDigest: process.env.DELTA_TREASURY_BASELINE_DIGEST });
  console.log(JSON.stringify(summary));
  if (!summary.ok) process.exitCode = 1;
}
