import httpx

class DeltaWitness:
    def __init__(self, base_url: str = "https://delta-witness-api.ruphussten.workers.dev"):
        self.base_url = base_url.rstrip("/")

    def quote(self):
        r = httpx.get(f"{self.base_url}/v1/quote", timeout=20)
        r.raise_for_status()
        return r.json()

    def demo(self):
        r = httpx.get(f"{self.base_url}/v1/demo", timeout=20)
        r.raise_for_status()
        return r.json()

    def proof(self, proof_id: str):
        r = httpx.get(f"{self.base_url}/v1/proofs/{proof_id}", timeout=20)
        r.raise_for_status()
        return r.json()

    def payment_challenge(self, url: str):
        r = httpx.post(f"{self.base_url}/v1/capture", json={"url": url}, timeout=20)
        if r.status_code != 402:
            r.raise_for_status()
        return {"status": r.status_code, "headers": dict(r.headers), "body": r.json() if r.content else None}
