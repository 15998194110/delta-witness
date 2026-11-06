import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { NETWORK, USDC, TREASURY, decimalUsdc, evidenceInteger, legacyDisplay, timestamp, validateTransfers } from './treasury-reconciliation.mjs';

export function validateTreasuryReport(report, { requireContinuity = false } = {}) {
  const errors = [];
  const check = (condition, reason) => { if (!condition) errors.push(reason); };
  check(report && typeof report === 'object' && !Array.isArray(report), 'report_object_required');
  if (!report || errors.length) return { ok: false, errors, continuity: 'unknown' };
  check(report.schema === 'delta-treasury-report/v2', 'unsupported_report_schema');
  check(report.ok === true && report.scan_complete === true, 'scan_not_complete');
  check(report.network === NETWORK && report.asset === USDC && report.treasury === TREASURY, 'wrong_receipt_scope');
  check(report.coverage_gap === null, 'coverage_gap');
  check(report.confirmation_policy_verified === true && Number.isInteger(report.confirmation_depth) && report.confirmation_depth > 0, 'confirmation_policy_unverified');
  check(report.all_time_reconciled === false && report.finality_verified === false, 'unsupported_history_or_finality_claim');
  check(report.checkpoint_write_status === 'last_confirmed_snapshot', 'checkpoint_write_unknown');
  try {
    timestamp(report.checked_at);
    evidenceInteger(report.origin_block, 'report_origin');
    evidenceInteger(report.start_block, 'report_start', report.origin_block);
    evidenceInteger(report.requested_through_block, 'report_target', report.start_block);
    evidenceInteger(report.latest_block, 'report_head', report.requested_through_block + report.confirmation_depth);
    check(report.latest_block === report.requested_through_block + report.confirmation_depth, 'confirmation_range_mismatch');
    check(report.last_scanned_block === report.requested_through_block, 'range_not_fully_scanned');
  } catch { errors.push('invalid_range'); }
  check(report.recognized_customer_revenue_usdc === null && report.actual_variable_cost_usdc === null && report.actual_contribution_margin_usdc === null, 'receipt_scan_cannot_recognize_revenue');
  const continuous = report.scan_mode === 'continuous' && report.continuity_verified === true && report.coverage_status === 'continuous_complete' && Number.isInteger(report.checkpoint_revision) && report.checkpoint_revision > 0 && report.checkpoint_after === report.requested_through_block;
  const window = report.scan_mode === 'window' && report.continuity_verified === false && report.coverage_status === 'window_complete' && report.persistence_rollout_required === true && report.checkpoint_after === null && report.checkpoint_revision === null && report.checkpoint_advanced === false;
  check(continuous || window, 'invalid_coverage_semantics');
  if (requireContinuity) check(continuous, 'continuous_persistence_not_verified');
  check(Array.isArray(report.transfers), 'transfers_required');
  let transfersValid = false;
  try { validateTransfers(report.transfers, evidenceInteger(report.origin_block, 'origin'), report.requested_through_block); transfersValid = true; }
  catch { errors.push('invalid_receipt_evidence'); }
  if (transfersValid) {
    check(report.treasury_received_candidates === report.transfers.length, 'receipt_count_mismatch');
    const ids = new Set();
    let total = 0n;
    let excluded = 0n;
    for (const receipt of report.transfers) {
      if (!receipt || typeof receipt.raw_amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(receipt.raw_amount) || !receipt.receipt_id || ids.has(receipt.receipt_id)) { errors.push('invalid_or_duplicate_receipt'); continue; }
      ids.add(receipt.receipt_id);
      total += BigInt(receipt.raw_amount);
      if (receipt.customer_revenue === false) excluded += BigInt(receipt.raw_amount);
      check(receipt.to === TREASURY && receipt.treasury_received === true && receipt.customer_revenue !== true, 'invalid_receipt_classification');
    }
    check(report.total_raw === total.toString() && report.total_usdc_decimal === decimalUsdc(total), 'receipt_total_mismatch');
    check(report.known_non_customer_raw === excluded.toString() && report.unclassified_raw === (total - excluded).toString(), 'receipt_classification_total_mismatch');
    check(report.total_usdc === legacyDisplay(total) && report.known_non_customer_usdc === legacyDisplay(excluded) && report.unclassified_usdc === legacyDisplay(total - excluded), 'legacy_display_total_mismatch');
    check(report.known_non_customer_usdc_decimal === decimalUsdc(excluded) && report.unclassified_usdc_decimal === decimalUsdc(total - excluded), 'classification_display_total_mismatch');
  }
  return { ok: errors.length === 0, errors, continuity: continuous ? 'continuous_declared_range' : window ? 'complete_window_only_persistence_rollout_pending' : 'unknown' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try {
    if ((await stat(process.argv[2])).size > 16000000) throw new Error('report_too_large');
    result = validateTreasuryReport(JSON.parse(await readFile(process.argv[2], 'utf8')), { requireContinuity: process.argv.includes('--require-continuity') });
  }
  catch { result = { ok: false, errors: ['missing_or_invalid_report'], continuity: 'unknown' }; }
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
