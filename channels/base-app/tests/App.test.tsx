// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { BASE_NETWORK, PAYMENT_ATTEMPT_KEY, TREASURY } from "../src/domain";

const { paidFetch, signFailure, unsignedStatus } = vi.hoisted(() => ({ paidFetch: vi.fn(), signFailure: { current: false }, unsignedStatus: { current: 0 } }));
vi.mock("@x402/fetch", () => ({
  x402Client: class {
    setSpendControls() {}
    registerPolicy() {}
  },
  wrapFetchWithPayment: (transport: typeof fetch) => async (input: RequestInfo | URL, init?: RequestInit) => {
    if (unsignedStatus.current) return Response.json({ error: "unpaid_upstream_failure" }, { status: unsignedStatus.current });
    if (signFailure.current) throw new Error("User rejected signature request");
    const request = new Request(input, init);
    request.headers.set("payment-signature", "synthetic-test-payment-not-a-real-signature");
    request.headers.set("access-control-expose-headers", "PAYMENT-RESPONSE");
    return transport(request);
  },
}));
vi.mock("@x402/evm/exact/client", () => ({ registerExactEvmScheme: vi.fn() }));
vi.mock("viem", () => ({
  createWalletClient: () => ({ signTypedData: vi.fn(() => { throw new Error("Test must not sign a payment"); }) }),
  custom: vi.fn(),
}));
vi.mock("viem/chains", () => ({ base: { id: 8453 } }));

let container: HTMLDivElement;
let root: Root;
let walletRequest: ReturnType<typeof vi.fn>;

async function renderApp() {
  await act(async () => { root.render(<App />); });
}

async function startRequest() {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".primary-action")!.click();
    await vi.dynamicImportSettled();
  });
  // The durable marker hashes the signed request asynchronously. Wait for the
  // outcome rather than assuming completion when SDK imports have settled.
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector(".result-status")!.textContent).not.toBe("READY");
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState(null, "", "/?product=capture&url=https%3A%2F%2Fexample.org%2Fterms");
  paidFetch.mockReset();
  signFailure.current = false;
  unsignedStatus.current = 0;
  window.localStorage.clear();
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: vi.fn(async (_name, _options, callback) => callback({ name: _name })) } });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (input instanceof Request && input.headers.has("payment-signature")) {
      expect(window.localStorage.getItem(PAYMENT_ATTEMPT_KEY)).not.toBeNull();
      return paidFetch(url, { method: input.method, headers: Object.fromEntries(input.headers), body: await input.text() });
    }
    if (!url.includes("/v1/quote?product=")) throw new Error(`Unexpected request: ${url}`);
    return Response.json({ price: url.endsWith("product=preflight") ? "$5" : "$1", network: BASE_NETWORK, asset: "USDC", pay_to: TREASURY, payment_flow: "upfront", economics: { estimatedContributionMarginUsd: 0.9 } });
  }));
  walletRequest = vi.fn(async ({ method }: { method: string }) => {
    if (method === "wallet_switchEthereumChain") return null;
    if (method === "eth_requestAccounts") return ["0x0000000000000000000000000000000000000001"];
    throw new Error(`Unexpected wallet action: ${method}`);
  });
  window.ethereum = { request: walletRequest } as never;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  delete window.ethereum;
  vi.restoreAllMocks();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Base app incomplete paid requests", () => {
  it("starts without a purchasable fixture and explains the metadata-only result", async () => {
    window.history.replaceState(null, "", "/");
    await renderApp();
    expect(container.querySelector<HTMLInputElement>('input[type="url"]')!.value).toBe("");
    expect(container.querySelector<HTMLButtonElement>(".primary-action")!.disabled).toBe(true);
    expect(container.textContent).toContain("Supply your own public source URL");
    expect(container.textContent).toContain("metadata and hashes only");
    expect(container.textContent).toContain("Historical proof example");
    expect(container.querySelector(".sample-proof")!.textContent).toContain("Illustrative example — not a live capture");
    expect(container.querySelector(".sample-proof")!.textContent).toContain("It is not evidence of a capture");
    expect(container.querySelector(".sample-proof a, .sample-proof button")).toBeNull();
    expect(container.querySelectorAll(".use-cases article")).toHaveLength(3);
    expect(container.querySelector(".intro p")!.textContent).toBe("Capture a public page for 1 USDC. Check a condition with Preflight for 5 USDC.");
    expect(container.querySelectorAll<HTMLButtonElement>("[role=radio]")[1].textContent).toContain("Preflight · 5 USDC");
    expect(walletRequest).not.toHaveBeenCalled();
    expect(paidFetch).not.toHaveBeenCalled();
  });

  it.each([[true, "CHECKS MATCHED"], [false, "CHECKS NOT MET"], [null, "NO CRITERIA"]])("labels Preflight safe=%s as deterministic criteria only", async (safe, label) => {
    window.history.replaceState(null, "", "/?product=preflight&url=https%3A%2F%2Fexample.org%2Fterms");
    const id = "7d9d12f7-8f91-5f41-9f0c-5ef257d9ea5d";
    paidFetch.mockResolvedValue(Response.json({ ok: true, product: "preflight", safe, changed: null, proof_id: id, public_proof_url: `https://delta-witness-api.ruphussten.workers.dev/p/${id}`, manifest_url: `https://delta-witness-api.ruphussten.workers.dev/v1/proofs/${id}`, bundle_root: `sha256:${"a".repeat(64)}`, observed_at: "2026-09-30T12:00:00.000Z" }));
    await renderApp();
    expect(container.querySelector<HTMLInputElement>('input[maxlength="200"]')!.value).toBe("");
    await startRequest();
    expect(container.querySelector(".result-status")!.textContent).toBe(label);
  });

  it("renders a validated complete proof without changing its identity", async () => {
    const id = "7d9d12f7-8f91-5f41-9f0c-5ef257d9ea5d";
    const publicUrl = `https://delta-witness-api.ruphussten.workers.dev/p/${id}`;
    paidFetch.mockResolvedValue(Response.json({ ok: true, product: "capture", proof_id: id, public_proof_url: publicUrl, manifest_url: `https://delta-witness-api.ruphussten.workers.dev/v1/proofs/${id}`, bundle_root: `sha256:${"a".repeat(64)}`, observed_at: "2026-09-30T12:00:00.000Z" }));
    await renderApp();
    await startRequest();
    expect(container.querySelector(".result-status")!.textContent).toBe("CAPTURED");
    expect(container.querySelector<HTMLAnchorElement>(".result-rail a")!.href).toBe(publicUrl);
    expect(container.textContent).toContain("2026-09-30 12:00:00 UTC");
    expect(window.localStorage.getItem(PAYMENT_ATTEMPT_KEY)).toBeNull();
    await act(async () => { container.querySelectorAll<HTMLButtonElement>("[role=radio]")[1].click(); });
    expect(container.querySelector(".result-rail .completed-result")).toBeNull();
    expect(container.querySelector(".sample-proof")).not.toBeNull();
    expect(container.querySelector(".result-status")!.textContent).toBe("READY");
  });

  it("blocks duplicate starts and edits while pending, then displays 202 as processing", async () => {
    let resolve!: (value: Response) => void;
    paidFetch.mockReturnValue(new Promise<Response>((done) => { resolve = done; }));
    await renderApp();
    await act(async () => {
      const button = container.querySelector<HTMLButtonElement>(".primary-action")!;
      button.click();
      button.click();
      await vi.dynamicImportSettled();
      await vi.waitFor(() => { expect(paidFetch).toHaveBeenCalledTimes(1); });
    });
    expect(paidFetch).toHaveBeenCalledTimes(1);
    expect(walletRequest).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".sample-proof")).toBeNull();
    for (const control of container.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, [role=radio], .primary-action")) expect(control.disabled).toBe(true);
    const request = paidFetch.mock.calls[0][1];
    expect(request.headers).not.toHaveProperty("x-delta-partner-user");
    expect(JSON.parse(request.body)).toEqual({ url: "https://example.org/terms" });
    await act(async () => { resolve(Response.json({ ok: false, state: "processing", retryable: true }, { status: 202 })); });
    expect(container.querySelector(".result-status")!.textContent).toBe("PROCESSING");
    expect(container.querySelector(".result-rail .completed-result")).toBeNull();
    expect(container.querySelector(".sample-proof")).toBeNull();
    expect(container.textContent).toContain("Do not approve another payment");
    expect(container.querySelector<HTMLButtonElement>(".primary-action")!.disabled).toBe(true);
  });

  it.each([
    [502, { error: "capture_failed", retryable: true }, "NOT DELIVERED"],
    [200, { ok: true, product: "capture" }, "UNCONFIRMED"],
    [200, { ok: false }, "UNCONFIRMED"],
  ])("keeps incomplete HTTP %s responses out of the proof renderer", async (status, body, label) => {
    paidFetch.mockResolvedValue(Response.json(body, { status: status as number }));
    await renderApp();
    await startRequest();
    expect(container.querySelector(".result-status")!.textContent).toBe(label);
    expect(container.querySelector(".result-rail .completed-result")).toBeNull();
    expect(container.querySelector(".sample-proof")).toBeNull();
    expect(container.textContent).toContain("Payment status is not confirmed");
    expect(container.querySelector<HTMLButtonElement>(".primary-action")!.disabled).toBe(true);
  });

  it("preserves payment uncertainty after a transport failure", async () => {
    paidFetch.mockRejectedValue(new Error("network failed"));
    await renderApp();
    await startRequest();
    expect(container.querySelector(".result-status")!.textContent).toBe("UNCONFIRMED");
    expect(container.textContent).not.toContain("No payment was made");
    expect(container.textContent).toContain("Do not approve another payment");
    expect(paidFetch).toHaveBeenCalledTimes(1);
  });

  it("allows a declined signature to be retried because nothing was transmitted", async () => {
    signFailure.current = true;
    await renderApp();
    await startRequest();
    expect(paidFetch).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(PAYMENT_ATTEMPT_KEY)).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".primary-action")!.disabled).toBe(false);
    signFailure.current = false;
    paidFetch.mockResolvedValue(Response.json({ ok: false, state: "processing" }, { status: 202 }));
    await startRequest();
    expect(paidFetch).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(PAYMENT_ATTEMPT_KEY)).not.toBeNull();
  });

  it.each([402, 502])("allows retry after unsigned HTTP %s without persisting a payment marker", async (status) => {
    unsignedStatus.current = status;
    await renderApp();
    await startRequest();
    expect(paidFetch).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(PAYMENT_ATTEMPT_KEY)).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".primary-action")!.disabled).toBe(false);
    expect(container.textContent).toContain("before a signed payment request was sent");
  });

  it("restores an unresolved attempt after remount without paying again", async () => {
    paidFetch.mockResolvedValue(Response.json({ ok: false, state: "processing" }, { status: 202 }));
    await renderApp();
    await startRequest();
    const marker = window.localStorage.getItem(PAYMENT_ATTEMPT_KEY)!;
    expect(marker).not.toContain("example.org");
    expect(marker).not.toContain("synthetic-test-payment");
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await renderApp();
    expect(container.querySelector<HTMLButtonElement>(".primary-action")!.disabled).toBe(true);
    expect(container.textContent).toContain("previous capture attempt");
    expect(container.querySelector(".sample-proof")).toBeNull();
    expect(container.textContent).toContain("Reference:");
    expect(paidFetch).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(PAYMENT_ATTEMPT_KEY)).toBe(marker);
  });

  it("blocks a second tab via storage events and does not queue behind a held lock", async () => {
    await renderApp();
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: vi.fn(async (_name, options, callback) => {
      expect(options.ifAvailable).toBe(true);
      return callback(null);
    }) } });
    await startRequest();
    expect(walletRequest).not.toHaveBeenCalled();
    expect(paidFetch).not.toHaveBeenCalled();
    const marker = JSON.stringify({ version: 1, product: "capture", startedAt: "2026-09-30T12:00:00Z", attemptId: `sha256:${"a".repeat(64)}`, phase: "signed_request" });
    await act(async () => {
      window.localStorage.setItem(PAYMENT_ATTEMPT_KEY, marker);
      window.dispatchEvent(new StorageEvent("storage", { key: PAYMENT_ATTEMPT_KEY, newValue: marker }));
    });
    expect(container.querySelector<HTMLButtonElement>(".primary-action")!.disabled).toBe(true);
    expect(container.textContent).toContain("previous capture attempt");
    expect(container.querySelector(".sample-proof")).toBeNull();
  });

  it("fails closed before wallet access when storage reads work but writes are unavailable", async () => {
    await renderApp();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    await startRequest();
    expect(walletRequest).not.toHaveBeenCalled();
    expect(paidFetch).not.toHaveBeenCalled();
    expect(container.textContent).toContain("No wallet authorization or signed request was started");
    expect(container.querySelector<HTMLButtonElement>(".primary-action")!.disabled).toBe(true);
  });

  it("fails closed before wallet access when Web Locks are unavailable", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    await renderApp();
    await startRequest();
    expect(walletRequest).not.toHaveBeenCalled();
    expect(paidFetch).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>(".primary-action")!.disabled).toBe(true);
  });

  it("fails closed when recovery storage cannot be read on mount", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage disabled"); });
    await renderApp();
    expect(container.querySelector<HTMLButtonElement>(".primary-action")!.disabled).toBe(true);
    expect(container.textContent).toContain("storage is unavailable or unreadable");
    expect(walletRequest).not.toHaveBeenCalled();
    expect(paidFetch).not.toHaveBeenCalled();
  });

  it.each([[202, "PROCESSING"], [502, "NOT DELIVERED"], [200, "UNCONFIRMED"]])("handles non-JSON HTTP %s without claiming a proof", async (status, label) => {
    paidFetch.mockResolvedValue(new Response("Unexpected upstream content", { status: status as number }));
    await renderApp();
    await startRequest();
    expect(container.querySelector(".result-status")!.textContent).toBe(label);
    expect(container.querySelector(".result-rail .completed-result")).toBeNull();
    expect(container.querySelector(".sample-proof")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".primary-action")!.disabled).toBe(true);
  });

  it("ignores a stale Capture quote after the buyer switches to Preflight", async () => {
    const resolveQuotes: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveQuotes.push(resolve); })));
    await renderApp();
    await act(async () => { container.querySelectorAll<HTMLButtonElement>("[role=radio]")[1].click(); });
    expect(resolveQuotes).toHaveLength(2);
    const quote = { network: BASE_NETWORK, asset: "USDC", pay_to: TREASURY, payment_flow: "upfront", economics: { estimatedContributionMarginUsd: 0.9 } };
    await act(async () => { resolveQuotes[1](Response.json({ ...quote, price: "$5" })); });
    await act(async () => { resolveQuotes[0](Response.json({ ...quote, price: "$1" })); });
    expect(container.querySelector(".quote")!.textContent).toContain("$5 USDC");
    expect(container.querySelector<HTMLButtonElement>(".primary-action")!.textContent).toContain("Preflight");
    expect(paidFetch).not.toHaveBeenCalled();
  });
});
