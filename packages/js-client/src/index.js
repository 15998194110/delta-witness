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

async function boundedResponse(fetchImpl, url, init, timeoutMs, observed = () => {}) {
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
            if (size > 1_048_576) { void reader.cancel().catch(() => {}); throw new Error('response_too_large'); }
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
  constructor({ baseUrl = "https://delta-witness-api.ruphussten.workers.dev", fetchImpl = fetch, requestTimeoutMs = 120_000 } = {}) {
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000) throw new TypeError('requestTimeoutMs must be an integer from 1 through 120000');
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }
  async quote(product = "capture") {
    if (!new Set(["capture", "preflight"]).has(product)) throw new TypeError("product must be capture or preflight");
    const r = await boundedResponse(this.fetch, `${this.baseUrl}/v1/quote?product=${product}`, { headers: { "x-delta-channel": "npm" } }, this.requestTimeoutMs);
    if (!r.ok) throw new Error(`DELTA quote failed: ${r.status}`);
    return r.json();
  }
  async demo() {
    const r = await boundedResponse(this.fetch, `${this.baseUrl}/v1/demo`, { headers: { "x-delta-channel": "npm" } }, this.requestTimeoutMs);
    if (!r.ok) throw new Error(`DELTA demo failed: ${r.status}`);
    return r.json();
  }
  async proof(id) {
    const r = await boundedResponse(this.fetch, `${this.baseUrl}/v1/proofs/${encodeURIComponent(id)}`, { headers: { "x-delta-channel": "npm" } }, this.requestTimeoutMs);
    if (!r.ok) throw new Error(`DELTA proof failed: ${r.status}`);
    return r.json();
  }
  async paymentChallenge(url, { product = "capture", ...options } = {}) {
    if (!new Set(["capture", "preflight"]).has(product)) throw new TypeError("product must be capture or preflight");
    const r = await boundedResponse(this.fetch, `${this.baseUrl}/v1/${product}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-delta-channel": "npm" },
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
        headers: { "content-type": "application/json", "x-delta-channel": "npm" },
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
