function unconfirmedPayment(status = null) {
  const error = new Error(`DELTA payment outcome unconfirmed${status === null ? '' : ` (HTTP ${status})`}; do not approve another payment. Reconcile the original attempt before recovery.`);
  error.code = 'payment_outcome_unconfirmed';
  error.status = status;
  error.retryable = false;
  return error;
}

function completedDelivery(body, product, origin) {
  if (!body || body.ok !== true || body.product !== product) return false;
  const id = body.proof_id;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return false;
  if (body.manifest_url !== `${origin}/v1/proofs/${id}` || body.public_proof_url !== `${origin}/p/${id}`) return false;
  if (!/^sha256:[0-9a-f]{64}$/i.test(body.bundle_root) || typeof body.observed_at !== 'string' || !Number.isFinite(Date.parse(body.observed_at))) return false;
  return product !== 'preflight' || ([true, false, null].includes(body.safe) && [true, false, null].includes(body.changed));
}

const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ORDER_PHASES = ['prepared', 'signing_started', 'uncertain', 'complete'];

function orderError(code, orderId = null, status = null) {
  // Never attach provider errors, the private record, request headers or token.
  const error = new Error(`DELTA order ${code}; retain the original order and do not authorize another payment for it.`);
  error.code = code;
  error.status = status;
  error.retryable = false;
  if (orderId) error.order_id = orderId;
  return error;
}

function orderId(value) {
  if (typeof value !== 'string' || !ORDER_ID.test(value.toLowerCase())) throw orderError('invalid_order_id');
  return value.toLowerCase();
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw orderError('invalid_order_input');
}

function orderBody(product, input) {
  try {
    if (!['capture', 'preflight'].includes(product) || !input || Object.getPrototypeOf(input) !== Object.prototype || typeof input.url !== 'string') throw new Error();
    const allowed = product === 'capture' ? ['url'] : ['url', 'expected', 'prior_proof_id', 'freshness_seconds'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error();
    const url = new URL(input.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    const body = canonicalJson({ ...input, url: url.toString() });
    if (new TextEncoder().encode(body).byteLength > 12_288) throw new Error();
    return body;
  } catch { throw orderError('invalid_order_input'); }
}

function validRecoveryToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const bytes = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '=');
    return bytes.length === 32 && btoa(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') === value;
  } catch { return false; }
}

function validPrivateExportAuthorization(value, rootToken) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some(key => !['operation_id', 'token', 'ttl_seconds', 'expected_generation', 'phase', 'generation', 'expires_at'].includes(key)) ||
      typeof value.operation_id !== 'string' || !ORDER_ID.test(value.operation_id) ||
      !validRecoveryToken(value.token) || value.token === rootToken ||
      !Number.isInteger(value.ttl_seconds) || value.ttl_seconds < 60 || value.ttl_seconds > 3600 ||
      !Number.isSafeInteger(value.expected_generation) || value.expected_generation < 0 || value.expected_generation >= Number.MAX_SAFE_INTEGER ||
      !['pending', 'confirmed'].includes(value.phase)) return false;
  if (value.phase === 'pending') return value.generation === undefined && value.expires_at === undefined;
  return value.generation === value.expected_generation + 1 && typeof value.expires_at === 'string' &&
    Number.isFinite(Date.parse(value.expires_at)) && new Date(value.expires_at).toISOString() === value.expires_at;
}

function exportAuthorizationEnvelope(body, id) {
  if (!body || Object.getPrototypeOf(body) !== Object.prototype || body.ok !== true || body.order_id !== id ||
      Object.keys(body).some(key => !['ok', 'order_id', 'authorization'].includes(key))) throw new Error();
  const value = body.authorization;
  if (value === null) return { ok: true, order_id: id, authorization: null };
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some(key => !['operation_id', 'generation', 'expires_at', 'scope', 'state'].includes(key)) ||
      typeof value.operation_id !== 'string' || !ORDER_ID.test(value.operation_id) ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 ||
      typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at)) || new Date(value.expires_at).toISOString() !== value.expires_at ||
      !Array.isArray(value.scope) || value.scope.length !== 1 || value.scope[0] !== 'export' ||
      !['active', 'expired'].includes(value.state)) throw new Error();
  return { ok: true, order_id: id, authorization: { operation_id: value.operation_id, generation: value.generation,
    expires_at: value.expires_at, scope: ['export'], state: value.state } };
}

async function requestDigest(origin, product, requestJson) {
  const bytes = new TextEncoder().encode(`delta-client-order/v1\n${origin}\n${product}\n${requestJson}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function publicOrder(record, delivery) {
  return { order_id: record.order_id, product: record.product, state: delivery ? 'complete' : record.phase,
    ...(delivery ? { delivery } : {}) };
}

function orderDelivery(body, record) {
  if (!completedDelivery(body, record.product, record.origin) ||
      (body.reason !== undefined && typeof body.reason !== 'string') ||
      (body.idempotent_replay !== undefined && typeof body.idempotent_replay !== 'boolean')) throw new Error();
  // A faulty upstream must not reflect the recovery capability back to callers.
  const delivery = Object.fromEntries(['ok', 'product', 'proof_id', 'manifest_url', 'public_proof_url', 'bundle_root',
    'observed_at', 'safe', 'changed', 'reason', 'diff', 'idempotent_replay']
    .filter(key => body[key] !== undefined).map(key => [key, body[key]]));
  if (JSON.stringify(delivery).includes(record.recovery_token) ||
      record.export_authorization && JSON.stringify(delivery).includes(record.export_authorization.token)) throw new Error();
  return delivery;
}

function validOrderEnvelope(body, record, status) {
  if (!body || body.ok !== true || body.order_id !== record.order_id || body.product !== record.product ||
      !['settlement_unknown', 'settlement_confirmed', 'settlement_rejected'].includes(body.payment?.state) ||
      body.payment.treasury_received !== null ||
      !['not_started', 'processing', 'retryable_failure', 'blocked_failure', 'complete', 'recovery_available'].includes(body.fulfillment?.state) ||
      typeof body.recovery?.can_recover !== 'boolean' || typeof body.recovery.expires_at !== 'string' || !Number.isFinite(Date.parse(body.recovery.expires_at))) return false;
  if (status === 200) return body.state === 'complete' && body.fulfillment.state === 'complete' &&
    body.payment.state === 'settlement_confirmed' && body.recovery.can_recover === false && completedDelivery(body.delivery, record.product, record.origin);
  return status === 202 && body.reconciliation_required === true && body.delivery === undefined &&
    body.state === (body.fulfillment.state === 'not_started' ? body.payment.state : body.fulfillment.state) &&
    body.fulfillment.state !== 'complete' &&
    (body.recovery.can_recover === (body.fulfillment.state === 'recovery_available')) &&
    (!body.recovery.can_recover || body.payment.state === 'settlement_confirmed');
}

async function boundedResponse(fetchImpl, url, init, timeoutMs, observed = () => {}, maxBytes = 1_048_576) {
  const controller = new AbortController();
  let timer;
  let reader;
  try {
    return await Promise.race([
      new Promise((_, reject) => { timer = setTimeout(() => {
        reject(new Error('request_deadline_exceeded'));
        controller.abort();
        void reader?.cancel().catch(() => {});
      }, timeoutMs); }),
      (async () => {
        const response = await fetchImpl(url, { ...init, signal: controller.signal });
        if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error('request_deadline_exceeded'); }
        observed(response);
        reader = response.body?.getReader();
        if (!reader) return response;
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (controller.signal.aborted) throw new Error('request_deadline_exceeded');
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) { void reader.cancel().catch(() => {}); throw new Error('response_too_large'); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return new Response(bytes, { status: response.status, headers: response.headers });
      })(),
    ]);
  } finally { clearTimeout(timer); }
}

export class DeltaWitness {
  #orderStore;
  constructor({ baseUrl = "https://delta-witness-api.ruphussten.workers.dev", fetchImpl = fetch, requestTimeoutMs = 120_000, orderStore, channel = "npm" } = {}) {
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000) throw new TypeError('requestTimeoutMs must be an integer from 1 through 120000');
    if (typeof channel !== "string" || !/^[a-z0-9_-]{1,40}$/.test(channel)) throw new TypeError("invalid attribution channel");
    this.channel = channel;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.#orderStore = orderStore;
  }

  #orderOrigin() {
    try {
      const url = new URL(this.baseUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.origin !== this.baseUrl) throw new Error();
      return url.origin;
    } catch { throw orderError('invalid_order_origin'); }
  }

  #store() {
    if (!this.#orderStore || typeof this.#orderStore.load !== 'function' || typeof this.#orderStore.compareAndSet !== 'function') throw orderError('order_store_required');
    return this.#orderStore;
  }

  async #readOrder(id, allowMissing = false) {
    const store = this.#store();
    let saved;
    try { saved = await store.load(id); } catch { throw orderError('order_store_unavailable', id); }
    if (saved === null) {
      if (allowMissing) return null;
      throw orderError('order_not_prepared', id);
    }
    const identityError = orderError('order_identity_conflict', id);
    try {
      // Take a JSON-only copy so a store cannot mutate the active request after a read.
      const record = JSON.parse(canonicalJson(saved));
      if (Object.keys(record).some(key => !['schema', 'revision', 'order_id', 'origin', 'product', 'request_json', 'request_digest', 'recovery_token', 'phase', 'retention_policy_hash', 'export_authorization'].includes(key)) ||
          (record.retention_policy_hash !== undefined && !/^sha256:[0-9a-f]{64}$/.test(record.retention_policy_hash)) ||
          (record.export_authorization !== undefined && (record.phase !== 'complete' || !validPrivateExportAuthorization(record.export_authorization, record.recovery_token))) ||
          record.schema !== 'delta-client-order/v1' || record.order_id !== id || !Number.isSafeInteger(record.revision) || record.revision < 0 ||
          !ORDER_PHASES.includes(record.phase) || !validRecoveryToken(record.recovery_token) ||
          typeof record.request_json !== 'string' || orderBody(record.product, JSON.parse(record.request_json)) !== record.request_json ||
          record.request_digest !== await requestDigest(record.origin, record.product, record.request_json)) throw new Error();
      if (record.origin !== this.#orderOrigin()) throw identityError;
      return record;
    } catch (error) {
      if (error === identityError) throw identityError;
      throw orderError('order_store_invalid', id);
    }
  }

  async #compareAndSet(record, previousRevision) {
    let saved;
    try { saved = await this.#store().compareAndSet(record.order_id, previousRevision, JSON.parse(JSON.stringify(record))); }
    catch { throw orderError('order_store_unavailable', record.order_id); }
    if (saved !== true && saved !== false) throw orderError('order_store_invalid', record.order_id);
    return saved;
  }

  async #markOutcome(record, phase) {
    // The durable signing_started marker already prevents another payment.
    // A failed bookkeeping write must not remove it or overwrite a newer result.
    if (record.phase === phase) return;
    try { await this.#compareAndSet({ ...record, revision: record.revision + 1, phase }, record.revision); } catch { /* Keep original recovery state. */ }
  }

  async prepareOrder(product, input, { orderId: requestedId = crypto.randomUUID(), retentionPolicyHash } = {}) {
    if (retentionPolicyHash !== undefined && (typeof retentionPolicyHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(retentionPolicyHash))) throw orderError('invalid_retention_policy_hash');
    const id = orderId(requestedId), origin = this.#orderOrigin(), requestJson = orderBody(product, input);
    const digest = await requestDigest(origin, product, requestJson);
    const previous = await this.#readOrder(id, true);
    if (previous) {
      if (previous.product !== product || previous.request_digest !== digest || previous.request_json !== requestJson || previous.retention_policy_hash !== retentionPolicyHash) throw orderError('order_identity_conflict', id);
      return publicOrder(previous);
    }
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const record = { schema: 'delta-client-order/v1', revision: 0, order_id: id, origin, product,
      request_json: requestJson, request_digest: digest, recovery_token: token, phase: 'prepared', ...(retentionPolicyHash ? { retention_policy_hash: retentionPolicyHash } : {}) };
    await this.#compareAndSet(record, null);
    const persisted = await this.#readOrder(id);
    if (persisted.product !== product || persisted.request_digest !== digest || persisted.request_json !== requestJson || persisted.retention_policy_hash !== retentionPolicyHash) throw orderError('order_identity_conflict', id);
    return publicOrder(persisted);
  }

  async executeOrder(requestedId, paidFetch) {
    const id = orderId(requestedId), record = await this.#readOrder(id);
    if (record.phase !== 'prepared') return this.recoverOrder(id);
    if (typeof paidFetch !== 'function') throw orderError('paid_fetch_required', id);
    const claimed = { ...record, revision: record.revision + 1, phase: 'signing_started' };
    if (!await this.#compareAndSet(claimed, record.revision)) return this.recoverOrder(id);
    const persisted = await this.#readOrder(id);
    if (canonicalJson(persisted) !== canonicalJson(claimed)) throw orderError('order_store_conflict', id);
    let status = null;
    try {
      const response = await boundedResponse(paidFetch, `${record.origin}/v1/${record.product}`, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-delta-channel': this.channel,
          'x-delta-order-id': id, 'x-delta-recovery-token': record.recovery_token,
          ...(record.retention_policy_hash ? { 'x-delta-retention-policy-hash': record.retention_policy_hash } : {}) },
        body: record.request_json,
      }, this.requestTimeoutMs, response => { status = response.status; });
      const body = await response.json();
      if (status !== 200) throw new Error();
      const delivery = orderDelivery(body, record);
      await this.#markOutcome(claimed, 'complete');
      return publicOrder(record, delivery);
    } catch {
      await this.#markOutcome(claimed, 'uncertain');
      throw orderError('payment_outcome_unconfirmed', id, status);
    }
  }

  async recoverOrder(requestedId) {
    const id = orderId(requestedId);
    let record = await this.#readOrder(id);
    if (record.phase === 'prepared') {
      // Choosing recovery must never turn a 404 into permission to sign later.
      await this.#compareAndSet({ ...record, revision: record.revision + 1, phase: 'uncertain' }, record.revision);
      record = await this.#readOrder(id);
      if (record.phase === 'prepared') throw orderError('order_store_conflict', id);
    }
    let status = null;
    try {
      const read = async (recover) => {
        const response = await boundedResponse(this.fetch, `${record.origin}/v1/orders/${id}${recover ? '/recover' : ''}`, {
          method: recover ? 'POST' : 'GET', redirect: 'error',
          headers: { 'x-delta-channel': this.channel, 'x-delta-recovery-token': record.recovery_token },
        }, this.requestTimeoutMs, response => { status = response.status; });
        const envelope = await response.json();
        if (!validOrderEnvelope(envelope, record, response.status)) throw new Error();
        return envelope;
      };
      let envelope = await read(false);
      if (envelope.recovery.can_recover) envelope = await read(true);
      if (status !== 200 || envelope.fulfillment.state !== 'complete') throw new Error();
      const delivery = orderDelivery(envelope.delivery, record);
      await this.#markOutcome(record, 'complete');
      return publicOrder(record, delivery);
    } catch {
      // 404/410/503 and unreadable data never establish that the order was unpaid.
      throw orderError('order_recovery_unconfirmed', id, status);
    }
  }
  async quote(product = "capture") {
    if (!new Set(["capture", "preflight"]).has(product)) throw new TypeError("product must be capture or preflight");
    const r = await boundedResponse(this.fetch, `${this.baseUrl}/v1/quote?product=${product}`, { headers: { "x-delta-channel": this.channel } }, this.requestTimeoutMs);
    if (!r.ok) throw new Error(`DELTA quote failed: ${r.status}`);
    return r.json();
  }

  async #exportAuthorizationRequest(record, body) {
    let status = null;
    try {
      const response = await boundedResponse(this.fetch, `${record.origin}/v1/orders/${record.order_id}/export-authorization`, {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { 'x-delta-channel': this.channel, 'x-delta-recovery-token': record.recovery_token,
          ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }, this.requestTimeoutMs, response => { status = response.status; }, 16_384);
      if (body ? ![200, 201].includes(status) : status !== 200) throw new Error();
      return exportAuthorizationEnvelope(await response.json(), record.order_id);
    } catch { throw orderError('order_export_authorization_unconfirmed', record.order_id, status); }
  }

  async #confirmExportAuthorization(record, envelope) {
    const local = record.export_authorization, remote = envelope.authorization;
    if (!local) return envelope; // Metadata only; no local child token is invented.
    if (!remote || remote.operation_id !== local.operation_id || remote.generation !== local.expected_generation + 1 ||
        local.phase === 'confirmed' && (local.generation !== remote.generation || local.expires_at !== remote.expires_at)) {
      throw orderError('order_export_authorization_unconfirmed', record.order_id);
    }
    if (local.phase === 'pending') {
      const confirmed = { ...record, revision: record.revision + 1, export_authorization: { ...local, phase: 'confirmed',
        generation: remote.generation, expires_at: remote.expires_at } };
      if (!await this.#compareAndSet(confirmed, record.revision)) throw orderError('order_store_conflict', record.order_id);
      if (canonicalJson(await this.#readOrder(record.order_id)) !== canonicalJson(confirmed)) throw orderError('order_store_conflict', record.order_id);
    }
    return envelope;
  }

  async recoverExportAuthorization(requestedId) {
    const id = orderId(requestedId), record = await this.#readOrder(id);
    // This method never posts, signs, creates another operation or overwrites a
    // different generation. A missing/mismatched readback leaves pending intact.
    return this.#confirmExportAuthorization(record, await this.#exportAuthorizationRequest(record));
  }

  async renewExportAuthorization(requestedId, { ttlSeconds = 900 } = {}) {
    const id = orderId(requestedId), record = await this.#readOrder(id);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) throw orderError('invalid_export_authorization_ttl', id);
    if (record.phase !== 'complete') throw orderError('order_delivery_required', id);
    // Even a crash before sending may have crossed the remote write boundary.
    // Re-entry reconciles the persisted operation with GET, never a second POST.
    if (record.export_authorization?.phase === 'pending') return this.recoverExportAuthorization(id);
    const remote = (await this.#exportAuthorizationRequest(record)).authorization;
    const generation = remote?.generation ?? 0;
    if (generation >= Number.MAX_SAFE_INTEGER || record.export_authorization && generation < record.export_authorization.generation) {
      throw orderError('order_export_authorization_unconfirmed', id);
    }
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    if (token === record.recovery_token) throw orderError('order_export_authorization_unconfirmed', id);
    const local = { operation_id: crypto.randomUUID(), token, ttl_seconds: ttlSeconds, expected_generation: generation, phase: 'pending' };
    const claimed = { ...record, revision: record.revision + 1, export_authorization: local };
    if (!await this.#compareAndSet(claimed, record.revision)) throw orderError('order_store_conflict', id);
    if (canonicalJson(await this.#readOrder(id)) !== canonicalJson(claimed)) throw orderError('order_store_conflict', id);
    const envelope = await this.#exportAuthorizationRequest(record, { operation_id: local.operation_id, token: local.token,
      ttl_seconds: local.ttl_seconds, expected_generation: local.expected_generation });
    return this.#confirmExportAuthorization(claimed, envelope);
  }

  async exportArtifact(requestedId, artifact, { authorization = 'original' } = {}) {
    const limits = { html: 2_000_000, markdown: 1_000_000, screenshot: 6_000_000, manifest: 1_048_576 };
    if (!Object.hasOwn(limits, artifact)) throw orderError('invalid_order_artifact');
    if (!['original', 'derived'].includes(authorization)) throw orderError('invalid_export_authorization');
    const id = orderId(requestedId);
    let record = await this.#readOrder(id), token = record.recovery_token;
    if (authorization === 'derived') {
      if (!record.export_authorization) throw orderError('order_export_authorization_unconfirmed', id);
      const current = (await this.recoverExportAuthorization(id)).authorization;
      record = await this.#readOrder(id);
      if (!current || current.state !== 'active' || Date.parse(current.expires_at) <= Date.now() ||
          record.export_authorization?.phase !== 'confirmed' || record.export_authorization.operation_id !== current.operation_id ||
          record.export_authorization.generation !== current.generation || record.export_authorization.expires_at !== current.expires_at) {
        throw orderError('order_export_authorization_unconfirmed', id);
      }
      token = record.export_authorization.token;
    }
    let status = null;
    try {
      const response = await boundedResponse(this.fetch, `${record.origin}/v1/orders/${id}/artifacts/${artifact}`, {
        method: 'GET', redirect: 'error', headers: { 'x-delta-channel': this.channel, 'x-delta-recovery-token': token },
      }, this.requestTimeoutMs, response => { status = response.status; }, limits[artifact]);
      if (status !== 200 || !response.headers.get('content-disposition')?.startsWith('attachment;')) throw new Error();
      const bytes = new Uint8Array(await response.arrayBuffer());
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hash = `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
      if (response.headers.get('x-delta-content-sha256') !== hash || response.headers.get('content-length') !== String(bytes.length)) throw new Error();
      return { order_id: id, artifact, bytes, content_sha256: hash,
        filename: `delta-${id}-${{ html: 'page.html', markdown: 'page.md', screenshot: 'screenshot.png', manifest: 'manifest.json' }[artifact]}`,
        // Download all raw files as opaque data; never execute captured HTML in
        // the application's origin. The server remains entitlement authority.
        content_type: 'application/octet-stream' };
    } catch { throw orderError('order_export_unconfirmed', id, status); }
  }
  async demo() {
    const r = await boundedResponse(this.fetch, `${this.baseUrl}/v1/demo`, { headers: { "x-delta-channel": this.channel } }, this.requestTimeoutMs);
    if (!r.ok) throw new Error(`DELTA demo failed: ${r.status}`);
    return r.json();
  }
  async proof(id) {
    const r = await boundedResponse(this.fetch, `${this.baseUrl}/v1/proofs/${encodeURIComponent(id)}`, { headers: { "x-delta-channel": this.channel } }, this.requestTimeoutMs);
    if (!r.ok) throw new Error(`DELTA proof failed: ${r.status}`);
    return r.json();
  }
  async paymentChallenge(url, { product = "capture", ...options } = {}) {
    if (!new Set(["capture", "preflight"]).has(product)) throw new TypeError("product must be capture or preflight");
    const r = await boundedResponse(this.fetch, `${this.baseUrl}/v1/${product}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-delta-channel": this.channel },
      body: JSON.stringify({ url, ...options })
    }, this.requestTimeoutMs);
    if (r.status !== 402) {
      if (r.ok) return { status: r.status, response: await r.json() };
      throw new Error(`Expected 402 challenge, got HTTP ${r.status}`);
    }
    return { status: 402, headers: Object.fromEntries(r.headers), body: await r.json().catch(() => null) };
  }
  async captureWithPaidFetch(url, paidFetch) {
    return this.#paid("capture", { url }, paidFetch);
  }
  async preflightChallenge(input) {
    if (!input || typeof input !== "object" || !input.url) throw new TypeError("preflight input with url is required");
    const { url, ...options } = input;
    return this.paymentChallenge(url, { product: "preflight", ...options });
  }
  async preflightWithPaidFetch(input, paidFetch) {
    if (!input || typeof input !== "object" || !input.url) throw new TypeError("preflight input with url is required");
    return this.#paid("preflight", input, paidFetch);
  }
  async #paid(product, body, paidFetch) {
    if (typeof paidFetch !== "function") throw new TypeError("paidFetch must be an x402-capable fetch function");
    let status = null;
    try {
      const r = await boundedResponse(paidFetch, `${this.baseUrl}/v1/${product}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-delta-channel": this.channel },
        body: JSON.stringify(body),
      }, this.requestTimeoutMs, response => { status = response.status; });
      const result = await r.json();
      if (status !== 200 || !completedDelivery(result, product, this.baseUrl)) throw unconfirmedPayment(status);
      return result;
    } catch {
      // A failed transport or partial response does not establish non-payment.
      // Never expose upstream bodies/signatures or automatically call paidFetch again.
      throw unconfirmedPayment(status);
    }
  }
}

export default DeltaWitness;
