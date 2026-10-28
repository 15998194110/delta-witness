import { pathToFileURL } from 'node:url';
import { fetchTextBounded } from './bounded-http.mjs';

const REGISTRY = 'https://true402.dev/api/v1/services';
const ORIGIN = 'https://delta-witness-api.ruphussten.workers.dev';
const TREASURY = '0x1990e21bc219696ff7fbc26527dbaed335ac6367';
const PRICES = new Map([
  [`${ORIGIN}/v1/capture`, '1.00'],
  [`${ORIGIN}/v1/preflight`, '5.00'],
  [`${ORIGIN}/v1/guarded-action-pilot`, '10.00'],
]);

// Keep the existing scheduler entrypoint, but retire automatic registration.
// docs/channel-status/true402-products-2026-09-08-turn9.json preserves the three
// existing service identities. The retired registration workflow also records a
// later HTTP 201 with visibility pending. A missing readback never permits replay.
// This command only reads; a future reviewed update must reconcile the historical
// identity and any unknown write outcome before implementing a write.
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failure = (classification, message, extra = {}) => Object.assign(new Error(message), { classification, ...extra });

function diagnostic(error) {
  // Do not dump response bodies, arbitrary exception messages, headers, URLs,
  // customer fields, or registry objects into public CI logs.
  return {
    classification: error.classification ?? 'unknown',
    message: error.classification ? error.message : 'Unclassified read failure; untrusted error detail omitted',
    ...(Number.isInteger(error.status) ? { status: error.status } : {}),
    ...(error.networkCode ? { network_code: error.networkCode } : {}),
  };
}

function transportFailure(error) {
  if (error?.classification) return error;
  if (['TimeoutError', 'AbortError'].includes(error?.name)) return failure('network_timeout', 'Registry read timed out', { retryable: true });
  const code = error?.cause?.code ?? error?.code;
  if (['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) {
    return failure('network_failure', 'Registry network read failed', { networkCode: code, retryable: true });
  }
  return failure('unknown', 'Unclassified read failure; untrusted error detail omitted');
}

function explicitSafetyDenial(body, responseOk) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (responseOk && body.ok !== false && !(body.error && typeof body.error === 'object')) return false;
  const error = body.error && typeof body.error === 'object' ? body.error : {};
  const detail = [body.code, body.message, typeof body.error === 'string' ? body.error : '', error.code, error.message]
    .filter((value) => typeof value === 'string').join(' ');
  return /\b(?:safety_denied|safety_refusal|safety_blocked|policy_violation)\b|\b(?:platform\s+)?safety\s+(?:policy\s+)?(?:blocked|denied|refusal)/i.test(detail);
}

async function getJson(url, { fetchImpl, sleep, log, attempts, timeoutMs }) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { response, text } = await fetchTextBounded(fetchImpl, url, { method: 'GET', redirect: 'error' }, { timeoutMs, maxBytes: 2_000_000 });
      let body;
      try { body = JSON.parse(text); } catch { /* Preserve an HTTP error classification if no JSON body exists. */ }
      if (explicitSafetyDenial(body, response.ok)) throw failure('platform_safety_denied', 'Registry explicitly refused the read on safety grounds', { status: response.status });
      if (!response.ok) {
        const status = response.status;
        const classification = status === 401 ? 'authentication_required' : status === 403 ? 'http_forbidden'
          : status === 429 || status >= 500 ? 'http_transient' : 'http_permanent';
        throw failure(classification, `Registry read returned HTTP ${status}`, { status, retryable: classification === 'http_transient' });
      }
      if (body === undefined) throw failure('malformed_response', 'Registry returned invalid JSON');
      return body;
    } catch (cause) {
      const error = transportFailure(cause);
      log({ event: 'true402_read_failed', attempt, ...diagnostic(error) });
      if (!error.retryable || attempt === attempts) throw error;
      await sleep(700 * attempt);
    }
  }
}

function pageFrom(json) {
  if (Array.isArray(json)) return { rows: json, metadata: {} };
  if (!json || typeof json !== 'object') throw failure('malformed_response', 'Unrecognized registry response shape');
  const keys = ['services', 'data', 'items', 'results'].filter((key) => Array.isArray(json[key]));
  if (keys.length !== 1) throw failure('malformed_response', 'Unrecognized or ambiguous registry response shape');
  return { rows: json[keys[0]], metadata: json };
}

function pagination(metadata) {
  const hasMore = metadata.has_more ?? metadata.hasMore;
  if (hasMore !== undefined && typeof hasMore !== 'boolean') throw failure('malformed_pagination', 'Registry continuation flag is not boolean');
  if (metadata.has_more !== undefined && metadata.hasMore !== undefined && metadata.has_more !== metadata.hasMore) throw failure('malformed_pagination', 'Registry continuation flags disagree');
  const total = metadata.total;
  if (total !== undefined && (!Number.isSafeInteger(total) || total < 0)) throw failure('malformed_pagination', 'Registry total is not a nonnegative integer');
  // Cursor contracts cannot be silently treated as offset pagination. `count`
  // alone may mean page size; it is deliberately not interpreted as total.
  if (metadata.next_cursor || metadata.nextCursor || metadata.next || metadata.pagination) throw failure('malformed_pagination', 'Registry returned unsupported pagination metadata');
  return { hasMore, total };
}

function normalizedEndpoint(row) {
  const endpoint = row.manifest?.endpoint ?? row.endpoint ?? row.url;
  if (typeof endpoint !== 'string') return null;
  try {
    const url = new URL(endpoint);
    if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  } catch { return null; }
}

function isDelta(row) {
  return normalizedEndpoint(row) !== null
    || row.manifest?.payment?.address?.toLowerCase?.() === TREASURY
    || /delta[ -]witness/i.test(String(row.manifest?.name ?? row.name ?? ''));
}

function safeMatch(row) {
  const endpoint = normalizedEndpoint(row);
  const expected = PRICES.get(endpoint);
  const pricing = row.manifest?.pricing ?? row.pricing;
  const raw = pricing?.base;
  const validPrice = (typeof raw === 'string' && /^\d+(?:\.\d{1,6})?$/.test(raw)) || (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0);
  const knownPrice = expected !== undefined && validPrice && pricing?.currency === 'USDC';
  // Presence/name/price is not proof of a usable paid route. We have not
  // verified today's registry schema. Absent contract fields remain unknown.
  const manifest = row.manifest ?? row;
  const payment = manifest.payment;
  const method = manifest.method ?? row.method;
  const requestSchema = manifest.inputSchema ?? manifest.input_schema;
  const exactContract = PRICES.has(endpoint) && method === 'POST' &&
    payment?.address?.toLowerCase?.() === TREASURY && payment?.network === 'eip155:8453' &&
    payment?.asset?.toLowerCase?.() === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' &&
    requestSchema?.type === 'object' && Array.isArray(requestSchema.required) &&
    requestSchema.required.includes(endpoint?.endsWith('/guarded-action-pilot') ? 'urls' : 'url');
  return {
    id: typeof row.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(row.id) ? row.id : null,
    endpoint: PRICES.has(endpoint) ? endpoint : null,
    expected_price_usdc: expected ?? null,
    price_status: !knownPrice ? 'unknown' : Number(raw) === Number(expected) ? 'current' : 'catalog_refresh_pending',
    contract_status: exactContract ? 'declared_compatible' : 'unverified_or_mismatched',
    callable_verified: false,
  };
}

export async function runTrue402(options = {}) {
  const config = {
    fetchImpl: options.fetchImpl ?? fetch,
    sleep: options.sleep ?? wait,
    log: options.log ?? ((entry) => console.error(JSON.stringify(entry))),
    attempts: options.attempts ?? 3,
    timeoutMs: options.timeoutMs ?? 20000,
  };
  const maxPages = options.maxPages ?? 100;
  for (const [key, value, maximum] of [['attempts', config.attempts, 3], ['maxPages', maxPages, 1000], ['timeoutMs', config.timeoutMs, 60000]]) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${key}`);
  }
  const result = {
    channel: 'true402', mode: 'read_only', listing_status: 'historical_identity_unverified',
    discovery_status: 'unknown', historical_identity: 'present_in_repository',
    historical_identity_evidence: 'docs/channel-status/true402-products-2026-09-08-turn9.json',
    duplicate_avoided: true, submission_attempts: 0,
    write_outcome: options.priorWriteUnknown ? 'pending_verification' : 'no_write_attempted',
    scan_complete: false, pages_scanned: 0, rows_scanned: 0, matches: [],
    duplicate_entries: 0, stale_price_entries: 0, unknown_price_entries: 0, unverified_contract_entries: 0,
    catalog_refresh_pending: false, evidence_quality: 'A_official_registry_API',
  };
  const pageSignatures = new Set();
  let offset = 0;
  let expectedTotal;
  try {
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const json = await getJson(`${REGISTRY}?limit=100&offset=${offset}`, config);
      const { rows, metadata } = pageFrom(json);
      if (rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) throw failure('malformed_response', 'Registry rows must be objects');
      const { hasMore, total } = pagination(metadata);
      if (total !== undefined && expectedTotal !== undefined && total !== expectedTotal) throw failure('scan_incomplete', 'Registry total changed during pagination');
      expectedTotal ??= total;
      const end = offset + rows.length;
      if ((total !== undefined && end > total) || (hasMore === true && (rows.length === 0 || end === total))
        || (hasMore === false && total !== undefined && end < total) || (rows.length === 0 && total !== undefined && end < total)) {
        throw failure('malformed_pagination', 'Registry pagination metadata is inconsistent');
      }
      const signature = JSON.stringify(rows);
      if (rows.length && pageSignatures.has(signature)) throw failure('scan_incomplete', 'Registry repeated a page without pagination progress');
      pageSignatures.add(signature);
      result.pages_scanned += 1;
      result.rows_scanned += rows.length;
      result.matches.push(...rows.filter(isDelta).map(safeMatch));
      if (hasMore === false || (total !== undefined && end === total) || rows.length === 0) {
        result.scan_complete = true;
        break;
      }
      // The server may cap a requested limit. Advance by actual rows returned,
      // and never infer completion from a short, nonempty page.
      offset = end;
    }
    if (!result.scan_complete) throw failure('scan_incomplete', 'Registry page budget exhausted before a terminal page');
  } catch (error) {
    result.error = diagnostic(transportFailure(error));
  }
  const identities = new Set();
  const endpoints = new Map();
  for (const match of result.matches) {
    if (match.contract_status !== 'declared_compatible') result.unverified_contract_entries += 1;
    if (match.price_status === 'catalog_refresh_pending') result.stale_price_entries += 1;
    if (match.price_status === 'unknown') result.unknown_price_entries += 1;
    // A repeated identity observed on overlapping pages is not a second listing.
    if (match.id && identities.has(match.id)) continue;
    if (match.id) identities.add(match.id);
    if (match.endpoint) endpoints.set(match.endpoint, (endpoints.get(match.endpoint) ?? 0) + 1);
  }
  result.duplicate_entries = [...endpoints.values()].reduce((count, value) => count + Math.max(0, value - 1), 0);
  result.catalog_refresh_pending = result.stale_price_entries > 0;
  if (result.matches.length) {
    result.discovery_status = 'present';
    result.listing_status = !result.scan_complete ? 'catalog_verification_incomplete'
      : result.duplicate_entries || result.stale_price_entries || result.unknown_price_entries || result.unverified_contract_entries ? 'catalog_review_required' : 'already_listed';
  } else if (result.scan_complete) {
    result.discovery_status = 'not_observed_in_completed_scan';
  }
  // Even a visible listing cannot prove which unknown write succeeded. Only an
  // independently reconciled write identity can clear this state.
  if (options.priorWriteUnknown) result.listing_status = 'write_outcome_unknown';
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runTrue402();
  console.log(`TRUE402_RESULT ${JSON.stringify(result)}`);
  if (!result.scan_complete) process.exitCode = 1;
}
