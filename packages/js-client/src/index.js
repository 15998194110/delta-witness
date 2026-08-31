export class DeltaWitness {
  constructor({ baseUrl = "https://delta-witness-api.ruphussten.workers.dev", fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
  }
  async quote() {
    const r = await this.fetch(`${this.baseUrl}/v1/quote`);
    if (!r.ok) throw new Error(`DELTA quote failed: ${r.status}`);
    return r.json();
  }
  async demo() {
    const r = await this.fetch(`${this.baseUrl}/v1/demo`);
    if (!r.ok) throw new Error(`DELTA demo failed: ${r.status}`);
    return r.json();
  }
  async proof(id) {
    const r = await this.fetch(`${this.baseUrl}/v1/proofs/${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error(`DELTA proof failed: ${r.status}`);
    return r.json();
  }
  async paymentChallenge(url) {
    const r = await this.fetch(`${this.baseUrl}/v1/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url })
    });
    if (r.status !== 402) {
      if (r.ok) return { status: r.status, response: await r.json() };
      throw new Error(`Expected 402 challenge, got ${r.status}: ${await r.text()}`);
    }
    return { status: 402, headers: Object.fromEntries(r.headers), body: await r.json().catch(() => null) };
  }
  async captureWithPaidFetch(url, paidFetch) {
    if (typeof paidFetch !== "function") throw new TypeError("paidFetch must be an x402-capable fetch function");
    const r = await paidFetch(`${this.baseUrl}/v1/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url })
    });
    if (!r.ok) throw new Error(`DELTA capture failed: ${r.status} ${await r.text()}`);
    return r.json();
  }
}

export default DeltaWitness;
