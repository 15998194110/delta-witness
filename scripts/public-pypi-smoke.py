from importlib.metadata import version as installed_version

from delta_witness import DeltaWitness


expected = installed_version("delta-witness-ruphussten")
client = DeltaWitness()
quote = client.quote("preflight")
if quote.get("version") != expected or quote.get("network") != "eip155:8453":
    raise RuntimeError(f"Unexpected public quote: {quote}")
challenge = client.preflight_challenge(
    "https://example.com", expected={"contains": ["Example Domain"]}
)
if challenge.get("status") != 402 or "payment-required" not in challenge.get("headers", {}):
    raise RuntimeError(f"Unexpected public Guard challenge: {challenge}")
print({"ok": True, "version": expected, "quote": quote.get("price"), "challenge": 402})
