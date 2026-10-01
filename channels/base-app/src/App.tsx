import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address, EIP1193Provider, Hex } from "viem";
import {
  API_ORIGIN,
  assertPaymentStorageAvailable,
  BASE_NETWORK,
  clearPaymentAttempt,
  compactProof,
  isHttpSourceUrl,
  markSignedPaymentRequest,
  maxPaymentUsd,
  PAYMENT_ATTEMPT_KEY,
  PAYMENT_LOCK_NAME,
  PAYMENT_RECOVERY_WARNING,
  parsePurchaseParams,
  paymentNeedsRecovery,
  paymentPolicy,
  prepareBrowserPaymentRequest,
  purchaseOutcome,
  requestBody,
  readPaymentAttempt,
  updatePurchaseSearch,
  validateQuote,
  writePaymentAttempt,
  type Delivery,
  type PaymentAttempt,
  type Product,
  type Quote,
} from "./domain";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

type RunState = "idle" | "connecting" | "paying" | "processing" | "retryable_failure" | "uncertain" | "complete" | "error";

function asJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("DELTA returned a non-JSON response");
  }
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/rejected|denied|4001/i.test(message)) return "Wallet request was declined. If a payment request was already submitted, verify its settlement status before retrying.";
  if (/insufficient/i.test(message)) return "The connected wallet needs enough Base USDC to pay the displayed quote.";
  return message.replace(/^Error:\s*/i, "").slice(0, 240);
}

export default function App() {
  const initialPurchase = useMemo(() => parsePurchaseParams(window.location.search), []);
  const [product, setProduct] = useState<Product>(initialPurchase.product);
  const [url, setUrl] = useState(initialPurchase.url);
  const [mustContain, setMustContain] = useState(initialPurchase.mustContain);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [runState, setRunState] = useState<RunState>("idle");
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [error, setError] = useState("");
  const [walletAddress, setWalletAddress] = useState<Address | null>(null);
  const [savedAttempt, setSavedAttempt] = useState<PaymentAttempt | null>(null);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const runInFlight = useRef(false);
  const recoveryRequired = useRef(false);
  const quoteRequest = useRef(0);

  const productName = product === "preflight" ? "Preflight" : "Capture";

  const clearPreviousResult = () => {
    setDelivery(null);
    if (!recoveryRequired.current) {
      setRunState("idle");
      setError("");
    }
  };

  useEffect(() => {
    const refresh = () => {
      try {
        const attempt = readPaymentAttempt(window.localStorage);
        if (attempt) {
          setSavedAttempt(attempt);
          setRecoveryBlocked(true);
          recoveryRequired.current = true;
          if (!runInFlight.current) {
            setRunState("uncertain");
            setError(`A previous ${attempt.product} attempt needs review. ${PAYMENT_RECOVERY_WARNING}`);
          }
        }
      } catch {
        setRecoveryBlocked(true);
        recoveryRequired.current = true;
        setError("Browser recovery storage is unavailable or unreadable. New paid requests are disabled to avoid duplicate payment.");
      }
    };
    refresh();
    const onStorage = (event: StorageEvent) => {
      if (event.key === PAYMENT_ATTEMPT_KEY || event.key === null) refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const loadQuote = useCallback(async () => {
    const requestId = ++quoteRequest.current;
    setQuoteError("");
    setQuote(null);
    try {
      const response = await fetch(`${API_ORIGIN}/v1/quote?product=${product}`, {
        headers: { "x-delta-channel": "base-app" },
      });
      const body = asJson<Quote & { error?: string }>(await response.text());
      if (!response.ok) throw new Error(body.error || `Quote failed with HTTP ${response.status}`);
      validateQuote(body, product);
      if (requestId === quoteRequest.current) setQuote(body);
    } catch (quoteFailure) {
      if (requestId === quoteRequest.current) {
        setQuote(null);
        setQuoteError(friendlyError(quoteFailure));
      }
    }
  }, [product]);

  useEffect(() => {
    void loadQuote();
    return () => { quoteRequest.current += 1; };
  }, [loadQuote]);

  useEffect(() => {
    const search = updatePurchaseSearch(window.location.search, { product, url, mustContain });
    const next = `${window.location.pathname}${search}${window.location.hash}`;
    window.history.replaceState(null, "", next);
  }, [product, url, mustContain]);

  const run = async () => {
    if (runInFlight.current || recoveryRequired.current) return;
    runInFlight.current = true;
    let paymentAttempted = false;
    let attempt: PaymentAttempt | null = null;
    setError("");
    setDelivery(null);
    try {
      if (!navigator.locks) {
        setRecoveryBlocked(true);
        recoveryRequired.current = true;
        throw new Error("This browser cannot safely coordinate payments across tabs. No new signed request will be sent.");
      }
      await navigator.locks.request(PAYMENT_LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error("Another DELTA tab is handling a payment. Wait for that attempt to finish; this tab did not start a payment.");
        try {
          const previous = readPaymentAttempt(window.localStorage);
          if (previous) {
            setSavedAttempt(previous);
            setRecoveryBlocked(true);
            recoveryRequired.current = true;
            throw new Error(`A previous attempt needs review. ${PAYMENT_RECOVERY_WARNING}`);
          }
          assertPaymentStorageAvailable(window.localStorage);
        } catch (storageError) {
          setRecoveryBlocked(true);
          recoveryRequired.current = true;
          throw storageError;
        }
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
        client.setSpendControls({ maxAmountPerPayment: `$${maxPaymentUsd(product).toFixed(2)}` });
        client.registerPolicy(paymentPolicy(product));
        registerExactEvmScheme(client, { signer, networks: [BASE_NETWORK] });

        setRunState("paying");
        const paidFetch = wrapFetchWithPayment(async (input, init) => {
          const request = prepareBrowserPaymentRequest(input, init);
          if (request.headers.has("payment-signature") || request.headers.has("x-payment")) {
            try {
              attempt = await markSignedPaymentRequest(request, window.localStorage, product);
            } catch {
              setRecoveryBlocked(true);
              recoveryRequired.current = true;
              throw new Error("The recovery marker could not be saved. This signed request was not sent; new payments are disabled until browser storage is available.");
            }
            if (attempt) {
              setSavedAttempt(attempt);
              setRecoveryBlocked(true);
              recoveryRequired.current = true;
              paymentAttempted = true;
            }
          }
          return fetch(request);
        }, client);
        const response = await paidFetch(`${API_ORIGIN}/v1/${product === "preflight" ? "preflight" : "capture"}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-delta-channel": "base-app",
          },
          body: JSON.stringify(requestBody(product, target.toString(), mustContain)),
        });
        const responseText = await response.text();
        let responseBody: unknown = null;
        try {
          responseBody = JSON.parse(responseText);
        } catch {
          // Preserve HTTP 202/502 recovery semantics even if an intermediary sent non-JSON.
        }
        const outcome = purchaseOutcome(response.status, responseBody, product);
        if (outcome.state !== "complete" && !paymentAttempted) {
          setRunState("error");
          setError(`DELTA returned HTTP ${response.status} before a signed payment request was sent. You can try again.`);
          return;
        }
        setRunState(outcome.state);
        if (outcome.state === "complete") {
          setDelivery(outcome.delivery);
          try {
            if (attempt) clearPaymentAttempt(window.localStorage, attempt.attemptId);
            setSavedAttempt(null);
            setRecoveryBlocked(false);
            recoveryRequired.current = false;
          } catch {
            setError("The proof was delivered, but the local recovery marker could not be cleared. Contact DELTA before making another payment.");
          }
        } else {
          recoveryRequired.current = true;
          setRecoveryBlocked(true);
          if (attempt) {
            const pending = { ...attempt, phase: outcome.state };
            try { writePaymentAttempt(window.localStorage, pending); setSavedAttempt(pending); } catch { /* Keep the original signed-request marker. */ }
          }
          setError(outcome.message);
        }
      });
    } catch (runError) {
      if (paymentAttempted) {
        recoveryRequired.current = true;
        setRunState("uncertain");
        setError(`The paid request did not return a confirmed result. ${PAYMENT_RECOVERY_WARNING}`);
      } else {
        setRunState("error");
        setError(friendlyError(runError));
      }
    } finally {
      runInFlight.current = false;
    }
  };

  const resultStatus = useMemo(() => {
    if (runState === "processing") return { label: "PROCESSING", className: "neutral" };
    if (runState === "retryable_failure") return { label: "NOT DELIVERED", className: "neutral" };
    if (runState === "uncertain") return { label: "UNCONFIRMED", className: "neutral" };
    if (!delivery) return { label: runState === "error" ? "NOT RUN" : "READY", className: "neutral" };
    if (delivery.product === "preflight") {
      if (delivery.safe === true) return { label: "CHECKS MATCHED", className: "safe" };
      if (delivery.safe === false) return { label: "CHECKS NOT MET", className: "changed" };
      return { label: "NO CRITERIA", className: "neutral" };
    }
    return { label: "CAPTURED", className: "safe" };
  }, [delivery, runState]);

  const busy = runState === "connecting" || runState === "paying";
  const locked = busy || recoveryBlocked || paymentNeedsRecovery(runState);
  const actionLabel = runState === "connecting"
    ? "Connecting wallet…"
    : runState === "paying"
      ? `Approve ${quote?.price ?? "payment"} & run ${productName}…`
      : recoveryBlocked || paymentNeedsRecovery(runState)
        ? "Check original attempt before paying again"
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
          <a href={`${API_ORIGIN}/v1/demo`}>Historical proof example</a>
        </nav>
      </header>

      <main>
        <section className="intro" aria-labelledby="page-title">
          <h1 id="page-title">Verify the source before you act.</h1>
          <p>Capture a public page for 1 USDC.{" "}<br />Check a condition with Preflight for 5 USDC.</p>
        </section>

        <div className="workspace">
          <section className="form-region" aria-label="DELTA request">
            <div className="mode-switch" role="radiogroup" aria-label="Product">
              <button className={product === "capture" ? "selected" : ""} role="radio" aria-checked={product === "capture"} onClick={() => { clearPreviousResult(); setProduct("capture"); }} disabled={locked}>
                <span className="radio-dot" aria-hidden="true" /> Capture · 1 USDC
              </button>
              <button className={product === "preflight" ? "selected" : ""} role="radio" aria-checked={product === "preflight"} onClick={() => { clearPreviousResult(); setProduct("preflight"); }} disabled={locked}>
                <span className="radio-dot" aria-hidden="true" /> Preflight · 5 USDC
              </button>
            </div>

            <label>
              <span>Public URL</span>
              <input type="url" inputMode="url" value={url} onChange={(event) => { clearPreviousResult(); setUrl(event.target.value); }} placeholder="Paste a public HTTP(S) source URL" autoComplete="url" disabled={locked} />
            </label>
            <p className="wallet-address">Supply your own public source URL that you’re authorized to capture.</p>
            <p className="wallet-address">Your source URL and rule may appear in this page’s URL. Do not paste credentials, session tokens, private links or personal data.</p>

            {product === "preflight" && (
              <label>
                <span>Must contain</span>
                <input value={mustContain} onChange={(event) => { clearPreviousResult(); setMustContain(event.target.value); }} placeholder="Exact text to check (optional)" maxLength={200} disabled={locked} />
              </label>
            )}

            <dl className="quote" aria-label="Live quote">
              <div><dt>Network</dt><dd>Base</dd></div>
              <div><dt>Price</dt><dd>{quote ? `${quote.price} USDC` : "—"}</dd></div>
              <div><dt>Settlement</dt><dd>Before work · x402</dd></div>
            </dl>

            {quoteError && <p className="inline-error" role="alert">Quote unavailable: {quoteError} <button onClick={() => void loadQuote()} disabled={locked}>Retry</button></p>}
            {error && <p className="inline-error" role="alert">{error}</p>}
            {savedAttempt && <p className="wallet-address">Attempt started: {savedAttempt.startedAt}<br />Reference: <code style={{ overflowWrap: "anywhere" }}>{savedAttempt.attemptId}</code></p>}
            {recoveryBlocked && <p className="wallet-address">No automatic recovery is available. <a href="mailto:ruphussten@163.com">Contact DELTA</a> to review the original attempt. Reloading or changing tabs does not resolve a pending payment.</p>}

            <button className="primary-action" onClick={() => void run()} disabled={locked || !quote || !isHttpSourceUrl(url)}>
              {actionLabel}
            </button>
            <p className="wallet-address">Public proofs show metadata and hashes only. Raw HTML, Markdown and screenshots remain private.</p>
            <p className="wallet-address">The current product and target stay in this page URL, so an integration can link directly to a ready-to-pay request.</p>
            {walletAddress && <p className="wallet-address">Connected: {walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}</p>}
          </section>

          <aside className="result-rail" aria-live="polite" aria-label="Result">
            <div className={`result-status ${resultStatus.className}`}>{resultStatus.label}</div>
            {delivery ? (
              <dl className="completed-result">
                <div><dt>Observed</dt><dd>{new Date(delivery.observed_at).toISOString().replace("T", " ").replace(".000Z", " UTC")}</dd></div>
                <div><dt>Proof</dt><dd><a href={delivery.public_proof_url}>{compactProof(delivery.proof_id)}</a></dd></div>
                <div><dt>Reason</dt><dd className="reason">{delivery.reason ?? "OBSERVATION_RECORDED"}</dd></div>
              </dl>
            ) : (
              <div className="empty-result">
                <p>{paymentNeedsRecovery(runState) ? "No completed proof is available for this attempt." : "Your result will appear here after settlement and observation complete."}</p>
                <span>{paymentNeedsRecovery(runState) ? "Do not approve a fresh payment to retry this request." : "No capture work starts before payment is verified."}</span>
                {runState === "idle" && !recoveryBlocked && (
                  <div className="sample-proof" aria-label="Illustrative DELTA record">
                    <strong>Illustrative example — not a live capture</strong>
                    <dl>
                      <div><dt>Source</dt><dd>public.example/terms</dd></div>
                      <div><dt>Observed</dt><dd>2030-01-15 09:30 UTC</dd></div>
                      <div><dt>Proof ref</dt><dd>SAMPLE-RECORD</dd></div>
                      <div><dt>Fingerprint</dt><dd>illustrative-only</dd></div>
                    </dl>
                    <p>This fictional record illustrates observation metadata and hashes only. It is not evidence of a capture and does not certify truth, safety or legal admissibility.</p>
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>

        <section className="use-cases" aria-label="When DELTA can help">
          <article><h2>Before a supplier recommendation</h2><p>Record the public terms that informed a consequential sourcing or procurement decision.</p></article>
          <article><h2>Before citing a public source</h2><p>Attach an observation reference to the public page state you relied on.</p></article>
          <article><h2>Before an enforcement handoff</h2><p>Record an observable public page before it changes or disappears.</p></article>
        </section>
        <p className="safety-note">Public pages only. DELTA records observations and condition checks — not truth, safety, or legal admissibility.</p>
      </main>

      <footer>Base mainnet <span>·</span> x402 v2 <span>·</span> No custody</footer>
    </div>
  );
}
