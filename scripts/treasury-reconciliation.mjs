// Receipt observation only. This module never authorizes payments or recognizes revenue.
export const TREASURY = '0x1990e21bc219696ff7fbc26527dbaed335ac6367';
export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const NETWORK = 'eip155:8453';
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const TO_TOPIC = `0x${TREASURY.slice(2).padStart(64, '0')}`;
export const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.llamarpc.com'];
const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const EXCLUDED_PAYERS = new Map([
  ['0x54e163e9b8edda194d83f46add921bfa5fc5f4e0', 'nohumans_platform_verification'],
  ['0x7e6b6556322c4e26c567a867964ac793f5ee2b1c', 'payapi_platform_verification'],
]);

export function failure(category, retryable = false) {
  // Do not include upstream bodies, environment values or arbitrary exception text.
  return Object.assign(new Error(category), { category, retryable });
}
export function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value))) throw failure(`invalid_${name}`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw failure(`invalid_${name}`);
  return n;
}
export function quantity(value) {
  if (typeof value !== 'string' || value.length > 16 || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw failure('invalid_rpc_quantity');
  return integer(Number(BigInt(value)), 'rpc_quantity');
}
export function evidenceInteger(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number') throw failure(`invalid_${name}`);
  return integer(value, name, min, max);
}
export function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw failure('invalid_evidence_timestamp');
  return value;
}
const hex = n => `0x${n.toString(16)}`;
export function decimalUsdc(raw) {
  const n = BigInt(raw);
  return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6, '0')}`;
}
export function legacyDisplay(raw) { return BigInt(raw) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) / 1e6 : null; }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function header(value, requested) {
  if (!value || !HASH.test(value.hash || '') || !HASH.test(value.parentHash || '') || quantity(value.number) !== requested) throw failure('invalid_block_header');
  return { number: requested, hash: value.hash.toLowerCase(), parent_hash: value.parentHash.toLowerCase() };
}
export function normalizeLogs(result, from, through, maxLogs = 1000) {
  if (!Array.isArray(result)) throw failure('invalid_log_array');
  // eth_getLogs has no pagination field. A known/suspected size cap is not a complete response.
  if (result.length >= maxLogs) throw failure('log_limit_requires_smaller_range');
  const unique = new Map();
  for (const log of result) {
    if (!log || typeof log !== 'object' || log.removed !== false ||
        typeof log.address !== 'string' || log.address.toLowerCase() !== USDC ||
        !HASH.test(log.transactionHash || '') || !HASH.test(log.blockHash || '') || !HASH.test(log.data || '') ||
        !Array.isArray(log.topics) || log.topics.length !== 3 || log.topics.some(t => !HASH.test(t || '')) ||
        log.topics[0].toLowerCase() !== TRANSFER_TOPIC || log.topics[2].toLowerCase() !== TO_TOPIC ||
        !/^0x0{24}[0-9a-f]{40}$/i.test(log.topics[1])) throw failure('invalid_transfer_log');
    const blockNumber = quantity(log.blockNumber);
    const logIndex = quantity(log.logIndex);
    if (blockNumber < from || blockNumber > through) throw failure('log_outside_requested_range');
    const fromAddress = `0x${log.topics[1].slice(-40)}`.toLowerCase();
    const classification = EXCLUDED_PAYERS.get(fromAddress) || 'unclassified';
    const value = {
      receipt_id: `${NETWORK}:${USDC}:${log.transactionHash.toLowerCase()}:${logIndex}`,
      tx_hash: log.transactionHash.toLowerCase(), block_hash: log.blockHash.toLowerCase(),
      block_number: blockNumber, log_index: logIndex, from: fromAddress, to: TREASURY,
      raw_amount: BigInt(log.data).toString(), usdc_decimal: decimalUsdc(BigInt(log.data)),
      usdc: legacyDisplay(BigInt(log.data)), treasury_received: true,
      payer_classification: classification, customer_revenue: classification === 'unclassified' ? 'unclassified' : false,
    };
    if (unique.has(value.receipt_id) && !same(unique.get(value.receipt_id), value)) throw failure('conflicting_transfer_identity');
    unique.set(value.receipt_id, value);
  }
  return [...unique.values()].sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index);
}

export function validateTransfers(transfers, originBlock, throughBlock) {
  if (!Array.isArray(transfers) || transfers.length > 50000) throw failure('checkpoint_size_invalid');
  const ids = new Set();
  for (const t of transfers) {
    if (!t || !HASH.test(t.tx_hash || '') || !HASH.test(t.block_hash || '') || !ADDRESS.test(t.from || '') || t.to !== TREASURY ||
        typeof t.raw_amount !== 'string' || t.raw_amount.length > 78 || !/^(?:0|[1-9][0-9]*)$/.test(t.raw_amount) || BigInt(t.raw_amount) >= 2n ** 256n ||
        t.receipt_id !== `${NETWORK}:${USDC}:${t.tx_hash}:${t.log_index}` || ids.has(t.receipt_id)) throw failure('checkpoint_receipt_invalid');
    evidenceInteger(t.block_number, 'checkpoint_receipt_block', originBlock, throughBlock);
    evidenceInteger(t.log_index, 'checkpoint_log_index');
    if (t.tx_hash !== t.tx_hash.toLowerCase() || t.block_hash !== t.block_hash.toLowerCase() || t.from !== t.from.toLowerCase() ||
        t.usdc_decimal !== decimalUsdc(t.raw_amount) || t.usdc !== legacyDisplay(t.raw_amount)) throw failure('checkpoint_receipt_invalid');
    const classification = EXCLUDED_PAYERS.get(t.from) || 'unclassified';
    if (t.treasury_received !== true || t.payer_classification !== classification || t.customer_revenue !== (classification === 'unclassified' ? 'unclassified' : false)) throw failure('checkpoint_classification_invalid');
    ids.add(t.receipt_id);
  }
  return transfers;
}
export function validateCheckpoint(state) {
  if (!state || state.schema !== 'delta-treasury-checkpoint/v1' || state.network !== NETWORK || state.asset !== USDC || state.treasury !== TREASURY) throw failure('checkpoint_scope_mismatch');
  evidenceInteger(state.origin_block, 'checkpoint_origin');
  evidenceInteger(state.checked_through_block, 'checkpoint_tip', state.origin_block);
  evidenceInteger(state.confirmation_depth, 'checkpoint_confirmations', 1, 10000);
  timestamp(state.checked_at);
  if (!HASH.test(state.checked_through_hash || '') || !state.reorg_anchor || !HASH.test(state.reorg_anchor.hash || '')) throw failure('checkpoint_hash_missing');
  evidenceInteger(state.reorg_anchor.number, 'checkpoint_anchor', Math.max(0, state.origin_block - 1), Math.max(0, state.checked_through_block - 1));
  if (!Array.isArray(state.corrections) || state.corrections.length > 10000) throw failure('checkpoint_size_invalid');
  validateTransfers(state.transfers, state.origin_block, state.checked_through_block);
  for (const correction of state.corrections) {
    if (!correction || !['removed', 'replaced'].includes(correction.kind) || correction.receipt_id !== correction.previous?.receipt_id) throw failure('checkpoint_correction_invalid');
    timestamp(correction.observed_at);
    validateTransfers([correction.previous], state.origin_block, state.checked_through_block);
    if (correction.kind === 'removed') {
      if (correction.replacement !== null) throw failure('checkpoint_correction_invalid');
    } else {
      validateTransfers([correction.replacement], state.origin_block, state.checked_through_block);
      if (correction.receipt_id !== correction.replacement.receipt_id) throw failure('checkpoint_correction_invalid');
    }
  }
  return state;
}

async function withDeadline(operation, milliseconds, controller) {
  let timer;
  try {
    return await Promise.race([
      operation(), new Promise((_, reject) => {
        timer = setTimeout(() => {
          // Cancellation may resolve a stalled reader as EOF. Settle failure first.
          reject(failure('rpc_timeout', true));
          try { controller?.abort(); } catch { /* Cancellation cannot hide timeout. */ }
        }, milliseconds);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
async function readBounded(response, maxBytes, signal) {
  if (!response.body) throw failure('empty_rpc_body');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  const cancel = () => { void reader.cancel('rpc_timeout').catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) { cancel(); throw failure('rpc_timeout', true); }
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw failure('rpc_timeout', true);
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { void reader.cancel().catch(() => {}); throw failure('rpc_body_limit'); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw failure('invalid_rpc_json'); }
}

export function createRpcClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const urls = options.urls ?? RPCS;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const requestTimeoutMs = integer(options.requestTimeoutMs ?? 12000, 'request_timeout', 1, 120000);
  const scanTimeoutMs = integer(options.scanTimeoutMs ?? 180000, 'scan_timeout', 1, 900000);
  const maxRequests = integer(options.maxRequests ?? 500, 'max_requests', 1, 10000);
  const maxBytes = integer(options.maxResponseBytes ?? 2000000, 'response_bytes', 1, 16000000);
  const attempts = integer(options.attempts ?? 2, 'attempts', 1, 3);
  const started = now();
  const chainChecked = new Set();
  let preferred = null;
  let count = 0;
  async function request(url, method, params) {
    if (++count > maxRequests || now() - started >= scanTimeoutMs) throw failure('rpc_scan_budget_exhausted');
    const controller = new AbortController();
    return withDeadline(async () => {
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: controller.signal });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw failure('rpc_timeout', true);
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw failure(response.status === 403 ? 'http_forbidden' : response.status === 401 ? 'authentication_required' : response.status === 429 ? 'rate_limited' : 'rpc_http_error', response.status === 429 || response.status >= 500);
      }
      const json = await readBounded(response, maxBytes, controller.signal);
      if (!json || json.jsonrpc !== '2.0' || json.id !== 1 || json.error || !Object.hasOwn(json, 'result')) throw failure('invalid_rpc_envelope');
      return json.result;
    }, Math.min(requestTimeoutMs, Math.max(1, scanTimeoutMs - (now() - started))), controller);
  }
  return async function rpc(method, params) {
    let last = failure('rpc_unavailable');
    for (const url of preferred ? [preferred, ...urls.filter(u => u !== preferred)] : urls) {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          if (!chainChecked.has(url) && method !== 'eth_chainId') {
            if (quantity(await request(url, 'eth_chainId', [])) !== 8453) throw failure('wrong_chain');
            chainChecked.add(url);
          }
          const result = await request(url, method, params);
          if (method === 'eth_chainId') {
            if (quantity(result) !== 8453) throw failure('wrong_chain');
            chainChecked.add(url);
          }
          preferred = url; // Retain the healthy-fallback optimization from the current master.
          return { result, url };
        } catch (error) {
          last = error?.category ? error : error instanceof TypeError ? failure('network_failure', true) : failure('unknown');
          log({ event: 'treasury_rpc_degraded', method, provider: urls.indexOf(url), attempt, category: last.category });
          // Do not use another endpoint to bypass a denial or malformed chain evidence.
          if (!last.retryable) throw last;
          if (attempt < attempts) {
            if (now() - started + 700 * attempt >= scanTimeoutMs) throw failure('rpc_scan_budget_exhausted');
            await sleep(700 * attempt);
          }
        }
      }
    }
    throw last;
  };
}

export async function reconcileTreasury(options) {
  const rpc = options.rpc;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const started = now();
  let origin = null, start = null, target = null, latest = null, scanned = null, saved = null, loaded = null;
  let checkpointBefore = null, mode = options.checkpointStore ? 'continuous' : 'window';
  let corrections = [];
  let committedChunks = 0;
  let checkpointWritePending = false;
  const base = () => ({
    schema: 'delta-treasury-report/v2', checked_at: new Date(now()).toISOString(), network: NETWORK, asset: USDC, treasury: TREASURY,
    scan_mode: mode, start_block: start, latest_block: latest, requested_through_block: target, last_scanned_block: scanned,
    origin_block: origin, checkpoint_before: checkpointBefore, checkpoint_after: checkpointWritePending ? null : saved?.state.checked_through_block ?? checkpointBefore,
    checkpoint_revision: saved?.version ?? loaded?.version ?? null, checkpoint_advanced: checkpointWritePending ? null : committedChunks > 0,
    checkpoint_write_status: checkpointWritePending ? 'unknown_readback_required' : 'last_confirmed_snapshot',
    all_time_reconciled: false, finality_verified: false,
    recognized_customer_revenue_usdc: null, actual_variable_cost_usdc: null, actual_contribution_margin_usdc: null,
    scope: 'Canonical receipt candidates in the declared range; independent customer, settlement and delivery reconciliation is separate. No all-time claim.',
  });
  try {
    const chunkSize = integer(options.chunkBlocks ?? 1900, 'chunk_blocks', 1, 1900);
    const maxChunks = integer(options.maxChunks ?? 100, 'max_chunks', 1, 10000);
    const maxLogs = integer(options.maxLogsPerChunk ?? 1000, 'max_logs', 2, 10000);
    const overlap = integer(options.overlapBlocks ?? 100, 'overlap_blocks', 1, 10000);
    const confirmations = integer(options.confirmations ?? 12, 'confirmations', 1, 10000);
    const scanMs = integer(options.scanTimeoutMs ?? 180000, 'scan_timeout', 1, 900000);
    const lookback = integer(options.lookbackBlocks ?? 50000, 'lookback_blocks', 1);
    const budget = () => { if (now() - started >= scanMs) throw failure('scan_budget_exhausted'); };
    const call = async (method, params) => { budget(); const answer = await rpc(method, params); budget(); return answer.result; };
    const block = async n => header(await call('eth_getBlockByNumber', [hex(n), false]), n);
    if (quantity(await call('eth_chainId', [])) !== 8453) throw failure('wrong_chain');
    latest = quantity(await call('eth_blockNumber', []));
    if (latest < confirmations) throw failure('insufficient_confirmations');
    target = latest - confirmations;
    loaded = options.checkpointStore ? await options.checkpointStore.read() : null;
    const prior = loaded ? validateCheckpoint(loaded.state) : null;
    checkpointBefore = prior?.checked_through_block ?? null;
    if (prior) {
      if (options.initialBlock !== undefined && integer(options.initialBlock, 'initial_block') !== prior.origin_block) throw failure('checkpoint_origin_conflict');
      if (prior.checked_through_block > target) throw failure('checkpoint_ahead_of_confirmed_head');
      origin = prior.origin_block;
      const anchor = await block(prior.reorg_anchor.number);
      if (anchor.hash !== prior.reorg_anchor.hash) throw failure('reorg_beyond_retained_anchor');
      start = Math.max(origin, anchor.number + 1);
    } else {
      if (options.checkpointStore && options.initialBlock === undefined) throw failure('initial_block_required');
      origin = options.initialBlock === undefined ? Math.max(0, target - lookback + 1) : integer(options.initialBlock, 'initial_block');
      start = origin;
      if (start > target) throw failure('initial_block_after_confirmed_head');
    }
    let receipts = prior ? structuredClone(prior.transfers) : [];
    const priorReceiptIds = new Set(receipts.map(t => t.receipt_id));
    let history = prior ? structuredClone(prior.corrections) : [];
    let preceding = start > 0 ? await block(start - 1) : null;
    let chunks = 0;
    let expectedVersion = loaded?.version ?? null;
    for (let from = start; from <= target; from += chunkSize) {
      budget();
      if (++chunks > maxChunks) throw failure('chunk_budget_exhausted');
      const through = Math.min(target, from + chunkSize - 1);
      if (preceding && (await block(from - 1)).hash !== preceding.hash) throw failure('chain_changed_during_scan');
      const before = await block(through);
      const filter = { address: USDC, fromBlock: hex(from), toBlock: hex(through), topics: [TRANSFER_TOPIC, null, TO_TOPIC] };
      const observed = normalizeLogs(await call('eth_getLogs', [filter]), from, through, maxLogs);
      const headers = new Map([[through, before]]);
      for (const t of observed) {
        if (!headers.has(t.block_number)) headers.set(t.block_number, await block(t.block_number));
        if (headers.get(t.block_number).hash !== t.block_hash) throw failure('receipt_block_hash_mismatch');
      }
      if ((await block(through)).hash !== before.hash) throw failure('chain_changed_during_scan');
      // An unchanged committed tip fixes its entire canonical prefix. A newly
      // appearing receipt in that prefix contradicts a previously complete scan;
      // do not silently turn inconsistent RPC history into certified revenue.
      if (prior && observed.some(t => t.block_number <= prior.checked_through_block && !priorReceiptIds.has(t.receipt_id)) &&
          (await block(prior.checked_through_block)).hash === prior.checked_through_hash) throw failure('inconsistent_receipt_readback');
      const byId = new Map(observed.map(t => [t.receipt_id, t]));
      for (const old of receipts.filter(t => t.block_number >= from && t.block_number <= through)) {
        const replacement = byId.get(old.receipt_id);
        if (!replacement || !same(old, replacement)) {
          if (!headers.has(old.block_number)) headers.set(old.block_number, await block(old.block_number));
          // A receipt cannot vanish/change inside an unchanged canonical block.
          // An empty/truncated RPC result must not erase already verified evidence.
          if (headers.get(old.block_number).hash === old.block_hash) throw failure('inconsistent_receipt_readback');
          corrections.push({ kind: replacement ? 'replaced' : 'removed', receipt_id: old.receipt_id, previous: old, replacement: replacement ?? null, observed_at: new Date(now()).toISOString() });
        }
      }
      receipts = [...receipts.filter(t => t.block_number < from || t.block_number > through), ...observed];
      if (new Set(receipts.map(t => t.receipt_id)).size !== receipts.length) throw failure('conflicting_transfer_identity');
      if (receipts.length > 50000 || history.length + corrections.length > 10000) throw failure('checkpoint_capacity_reached');
      receipts.sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index);
      scanned = through;
      preceding = before;
      // Do not lower a committed cursor while rechecking an overlap/reorg. A crash
      // before reaching its prior tip leaves the old snapshot, marked unverified.
      if (options.checkpointStore && through >= (checkpointBefore ?? origin)) {
        const anchorNumber = Math.max(Math.max(0, origin - 1), through - overlap);
        const anchor = await block(anchorNumber);
        const state = {
          schema: 'delta-treasury-checkpoint/v1', network: NETWORK, asset: USDC, treasury: TREASURY,
          origin_block: origin, checked_through_block: through, checked_through_hash: before.hash,
          reorg_anchor: { number: anchorNumber, hash: anchor.hash }, confirmation_depth: confirmations,
          checked_at: new Date(now()).toISOString(), transfers: structuredClone(receipts), corrections: [...history, ...corrections],
        };
        validateCheckpoint(state);
        checkpointWritePending = true;
        const published = await options.checkpointStore.compareAndSwap(expectedVersion, state);
        checkpointWritePending = false;
        if (!published) throw failure('checkpoint_write_conflict');
        saved = published;
        expectedVersion = published.version;
        committedChunks++;
      }
      log({ event: 'treasury_chunk_ok', from_block: from, to_block: through, logs: observed.length, checkpoint_committed: saved?.state.checked_through_block === through });
    }
    const total = receipts.reduce((n, t) => n + BigInt(t.raw_amount), 0n);
    const excluded = receipts.filter(t => t.customer_revenue === false).reduce((n, t) => n + BigInt(t.raw_amount), 0n);
    return {
      ...base(), ok: true, scan_complete: true, coverage_status: mode === 'continuous' ? 'continuous_complete' : 'window_complete',
      continuity_verified: mode === 'continuous', persistence_rollout_required: mode !== 'continuous', coverage_gap: null,
      confirmation_depth: confirmations, confirmation_policy_verified: true, historical_coverage_before_origin: 'not_verified_by_this_scan',
      treasury_received_candidates: receipts.length, total_raw: total.toString(), total_usdc_decimal: decimalUsdc(total), total_usdc: legacyDisplay(total),
      known_non_customer_raw: excluded.toString(), known_non_customer_usdc_decimal: decimalUsdc(excluded), known_non_customer_usdc: legacyDisplay(excluded),
      unclassified_raw: (total - excluded).toString(), unclassified_usdc_decimal: decimalUsdc(total - excluded), unclassified_usdc: legacyDisplay(total - excluded),
      revenue_classification: 'Known test/platform payers excluded; other receipts unclassified until independently matched to settlement, delivery and buyer evidence.',
      evidence_quality: 'canonical_USDC_logs_with_confirmed_block_hashes', transfers: receipts, corrections,
    };
  } catch (error) {
    return {
      ...base(), ok: false, scan_complete: false, coverage_status: 'unknown', continuity_verified: false,
      coverage_gap: target === null ? null : { from_block: Math.min(target, Math.max(start ?? 0, (scanned ?? ((start ?? 0) - 1)) + 1)), through_block: target },
      treasury_received_candidates: null, total_raw: null, total_usdc: null, total_usdc_decimal: null,
      category: error?.category ?? 'reconciliation_failed', error: 'The declared range is unverified; do not infer zero receipts or revenue.',
      corrections: [],
    };
  }
}
