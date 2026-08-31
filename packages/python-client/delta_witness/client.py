import httpx

class DeltaWitness:
    def __init__(self, base_url: str = "https://delta-witness-api.ruphussten.workers.dev"):
        self.base_url = base_url.rstrip("/")

    def quote(self, product: str = "capture"):
        if product not in {"capture", "preflight"}:
            raise ValueError("product must be capture or preflight")
        r = httpx.get(f"{self.base_url}/v1/quote", params={"product": product}, headers={"x-delta-channel": "pypi"}, timeout=20)
        r.raise_for_status()
        return r.json()

    def demo(self):
        r = httpx.get(f"{self.base_url}/v1/demo", headers={"x-delta-channel": "pypi"}, timeout=20)
        r.raise_for_status()
        return r.json()

    def proof(self, proof_id: str):
        r = httpx.get(f"{self.base_url}/v1/proofs/{proof_id}", headers={"x-delta-channel": "pypi"}, timeout=20)
        r.raise_for_status()
        return r.json()

    def payment_challenge(self, url: str, product: str = "capture", **options):
        if product not in {"capture", "preflight"}:
            raise ValueError("product must be capture or preflight")
        r = httpx.post(f"{self.base_url}/v1/{product}", json={"url": url, **options}, headers={"x-delta-channel": "pypi"}, timeout=20)
        if r.status_code != 402:
            r.raise_for_status()
        return {"status": r.status_code, "headers": dict(r.headers), "body": r.json() if r.content else None}

    def preflight_challenge(self, url: str, **options):
        return self.payment_challenge(url, product="preflight", **options)
