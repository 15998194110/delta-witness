export class DeltaWitness {
  constructor({ baseUrl = "https://delta-witness-api.ruphussten.workers.dev", fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
  }
  async quote(product = "capture") {
    if (!new Set(["capture", "preflight"]).has(product)) throw new TypeError("product must be capture or preflight");
    const r = await this.fetch(`${this.baseUrl}/v1/quote?product=${product}`, { headers: { "x-delta-channel": "npm" } });
    if (!r.ok) throw new Error(`DELTA quote failed: ${r.status}`);
    return r.json();
  }
  async demo() {
    const r = await this.fetch(`${this.baseUrl}/v1/demo`, { headers: { "x-delta-channel": "npm" } });
    if (!r.ok) throw new Error(`DELTA demo failed: ${r.status}`);
    return r.json();
  }
  async proof(id) {
    const r = await this.fetch(`${this.baseUrl}/v1/proofs/${encodeURIComponent(id)}`, { headers: { "x-delta-channel": "npm" } });
    if (!r.ok) throw new Error(`DELTA proof failed: ${r.status}`);
    return r.json();
  }
  async paymentChallenge(url, { product = "capture", ...options } = {}) {
    if (!new Set(["capture", "preflight"]).has(product)) throw new TypeError("product must be capture or preflight");
    const r = await this.fetch(`${this.baseUrl}/v1/${product}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-delta-channel": "npm" },
      body: JSON.stringify({ url, ...options })
    });
    if (r.status !== 402) {
      if (r.ok) return { status: r.status, response: await r.json() };
      throw new Error(`Expected 402 challenge, got ${r.status}: ${await r.text()}`);
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
    const r = await paidFetch(`${this.baseUrl}/v1/${product}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-delta-channel": "npm" },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`DELTA ${product} failed: ${r.status} ${await r.text()}`);
    return r.json();
  }
}

export default DeltaWitness;
