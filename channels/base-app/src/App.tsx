import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address, EIP1193Provider, Hex } from "viem";
import {
  API_ORIGIN,
  BASE_NETWORK,
  MAX_PAYMENT_USD,
  compactProof,
  paymentPolicy,
  requestBody,
  validateQuote,
  type Delivery,
  type Product,
  type Quote,
} from "./domain";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

type RunState = "idle" | "connecting" | "paying" | "complete" | "error";

function asJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("DELTA returned a non-JSON response");
  }
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/rejected|denied|4001/i.test(message)) return "Wallet request was declined. No payment was made.";
  if (/insufficient/i.test(message)) return "The connected wallet needs enough Base USDC to pay the displayed quote.";
  return message.replace(/^Error:\s*/i, "").slice(0, 240);
}

export default function App() {
  const [product, setProduct] = useState<Product>("preflight");
  const [url, setUrl] = useState("https://example.com/terms");
  const [mustContain, setMustContain] = useState("30-day refund");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [runState, setRunState] = useState<RunState>("idle");
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [error, setError] = useState("");
  const [walletAddress, setWalletAddress] = useState<Address | null>(null);

  const productName = product === "preflight" ? "Guard" : "Capture";

  const loadQuote = useCallback(async () => {
    setQuoteError("");
    try {
      const response = await fetch(`${API_ORIGIN}/v1/quote?product=${product}`, {
        headers: { "x-delta-channel": "base-app" },
      });
      const body = asJson<Quote & { error?: string }>(await response.text());
      if (!response.ok) throw new Error(body.error || `Quote failed with HTTP ${response.status}`);
      validateQuote(body, product);
      setQuote(body);
    } catch (quoteFailure) {
      setQuote(null);
      setQuoteError(friendlyError(quoteFailure));
    }
  }, [product]);

  useEffect(() => {
    void loadQuote();
  }, [loadQuote]);

  const run = async () => {
    setError("");
    setDelivery(null);
    try {
      const target = new URL(url);
      if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("Enter a public HTTP or HTTPS URL");
      if (!quote) throw new Error("A valid live quote is required before payment");
      validateQuote(quote, product);
      const provider = window.ethereum;
      if (!provider) throw new Error("Install or open a Base-compatible wallet to continue. DELTA never receives your private key.");

      setRunState("connecting");
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] });
      const accounts = await provider.request({ method: "eth_requestAccounts" }) as Address[];
      const address = accounts[0];
      if (!address) throw new Error("The wallet did not return an account");
      setWalletAddress(address);

      const [fetchSdk, evmSdk, viem, chains] = await Promise.all([
        import("@x402/fetch"),
        import("@x402/evm/exact/client"),
        import("viem"),
        import("viem/chains"),
      ]);
      const { x402Client, wrapFetchWithPayment } = fetchSdk;
      const { registerExactEvmScheme } = evmSdk;
      const { createWalletClient, custom } = viem;
      const { base } = chains;
      const wallet = createWalletClient({ account: address, chain: base, transport: custom(provider) });
      const signer = {
        address,
        signTypedData: (message: {
          domain: Record<string, unknown>;
          types: Record<string, unknown>;
          primaryType: string;
          message: Record<string, unknown>;
        }) => wallet.signTypedData({ ...message, account: address } as never) as Promise<Hex>,
      };
      const client = new x402Client();
      client.setSpendControls({ maxAmountPerPayment: `$${MAX_PAYMENT_USD}` });
      client.registerPolicy(paymentPolicy());
      registerExactEvmScheme(client, { signer, networks: [BASE_NETWORK] });

      setRunState("paying");
      const paidFetch = wrapFetchWithPayment(fetch, client);
      const response = await paidFetch(`${API_ORIGIN}/v1/${product === "preflight" ? "preflight" : "capture"}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-delta-channel": "base-app",
          "x-delta-partner-user": address,
        },
        body: JSON.stringify(requestBody(product, target.toString(), mustContain)),
      });
      const body = asJson<Delivery & { error?: string }>(await response.text());
      if (!response.ok) throw new Error(body.error || `DELTA failed with HTTP ${response.status}`);
      setDelivery(body);
      setRunState("complete");
    } catch (runError) {
      setRunState("error");
      setError(friendlyError(runError));
    }
  };

  const resultStatus = useMemo(() => {
    if (!delivery) return { label: runState === "error" ? "NOT RUN" : "READY", className: "neutral" };
    if (delivery.product === "preflight") {
      if (delivery.safe === true) return { label: "SAFE", className: "safe" };
      if (delivery.safe === false) return { label: "CHANGED", className: "changed" };
    }
    return { label: "CAPTURED", className: "safe" };
  }, [delivery, runState]);

  const busy = runState === "connecting" || runState === "paying";
  const actionLabel = runState === "connecting"
    ? "Connecting wallet…"
    : runState === "paying"
      ? `Approve ${quote?.price ?? "payment"} & run ${productName}…`
      : `Connect wallet & run ${productName}`;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="DELTA Witness home">
          <span className="brand-mark">[#]</span>
          <span>DELTA Witness</span>
        </a>
        <nav aria-label="Primary">
          <a href={`${API_ORIGIN}/openapi.json`}>API</a>
          <a href={`${API_ORIGIN}/docs`}>Docs</a>
          <a href={`${API_ORIGIN}/v1/demo`}>Proof verifier</a>
        </nav>
      </header>

      <main>
        <section className="intro" aria-labelledby="page-title">
          <h1 id="page-title">Verify the source before you act.</h1>
          <p>Guard checks whether a public source still matches what you expect.<br />Capture preserves what it says now.</p>
        </section>

        <div className="workspace">
          <section className="form-region" aria-label="DELTA request">
            <div className="mode-switch" role="radiogroup" aria-label="Product">
              <button className={product === "preflight" ? "selected" : ""} role="radio" aria-checked={product === "preflight"} onClick={() => setProduct("preflight")}>
                <span className="radio-dot" aria-hidden="true" /> Guard
              </button>
              <button className={product === "capture" ? "selected" : ""} role="radio" aria-checked={product === "capture"} onClick={() => setProduct("capture")}>
                <span className="radio-dot" aria-hidden="true" /> Capture
              </button>
            </div>

            <label>
              <span>Public URL</span>
              <input type="url" inputMode="url" value={url} onChange={(event) => setUrl(event.target.value)} autoComplete="url" />
            </label>

            {product === "preflight" && (
              <label>
                <span>Must contain</span>
                <input value={mustContain} onChange={(event) => setMustContain(event.target.value)} maxLength={200} />
              </label>
            )}

            <dl className="quote" aria-label="Live quote">
              <div><dt>Network</dt><dd>Base</dd></div>
              <div><dt>Price</dt><dd>{quote ? `${quote.price} USDC` : "—"}</dd></div>
              <div><dt>Estimated margin</dt><dd>{quote ? `$${quote.economics.estimatedContributionMarginUsd.toFixed(3)}` : "—"}</dd></div>
            </dl>

            {quoteError && <p className="inline-error" role="alert">Quote unavailable: {quoteError} <button onClick={() => void loadQuote()}>Retry</button></p>}
            {error && <p className="inline-error" role="alert">{error}</p>}

            <button className="primary-action" onClick={() => void run()} disabled={busy || !quote}>
              {actionLabel}
            </button>
            {walletAddress && <p className="wallet-address">Connected: {walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}</p>}
          </section>

          <aside className="result-rail" aria-live="polite" aria-label="Result">
            <div className={`result-status ${resultStatus.className}`}>{resultStatus.label}</div>
            {delivery ? (
              <dl>
                <div><dt>Observed</dt><dd>{new Date(delivery.observed_at).toISOString().replace("T", " ").replace(".000Z", " UTC")}</dd></div>
                <div><dt>Proof</dt><dd><a href={delivery.public_proof_url}>{compactProof(delivery.proof_id)}</a></dd></div>
                <div><dt>Reason</dt><dd className="reason">{delivery.reason ?? "OBSERVATION_RECORDED"}</dd></div>
              </dl>
            ) : (
              <div className="empty-result">
                <p>Your result will appear here after settlement and observation complete.</p>
                <span>No capture work starts before payment is verified.</span>
              </div>
            )}
          </aside>
        </div>

        <p className="safety-note">Public pages only. DELTA proves observation and change — not truth.</p>
      </main>

      <footer>Base mainnet <span>·</span> x402 v2 <span>·</span> No custody</footer>
    </div>
  );
}
