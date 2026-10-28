// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { API_ORIGIN, BASE_NETWORK, PAYMENT_ATTEMPT_KEY, TREASURY } from '../src/domain';

const state = vi.hoisted(() => ({
  signer: null as null | { signTypedData: (message: never) => Promise<string> },
  sign: vi.fn(), secondSign: false, beforeSign: null as null | (() => void),
}));
vi.mock('@x402/fetch', () => ({
  x402Client: class { setSpendControls() {} registerPolicy() {} },
  wrapFetchWithPayment: (transport: typeof fetch) => async (input: RequestInfo | URL, init?: RequestInit) => {
    state.beforeSign?.();
    await state.signer!.signTypedData({} as never);
    const request = new Request(input, init);
    request.headers.set('payment-signature', 'fixture-signed-header');
    const response = await transport(request);
    if (state.secondSign) await state.signer!.signTypedData({} as never);
    return response;
  },
}));
vi.mock('@x402/evm/exact/client', () => ({ registerExactEvmScheme: (_client: unknown, config: { signer: typeof state.signer }) => { state.signer = config.signer; } }));
vi.mock('viem', () => ({ createWalletClient: () => ({ signTypedData: state.sign }), custom: vi.fn() }));
vi.mock('viem/chains', () => ({ base: { id: 8453 } }));

const account = '0x0000000000000000000000000000000000000001';
const quote = { price: '$1', network: BASE_NETWORK, asset: 'USDC', pay_to: TREASURY, payment_flow: 'upfront', economics: { estimatedContributionMarginUsd: 0.9 } };
const id = '7d9d12f7-8f91-5f41-9f0c-5ef257d9ea5d';
const delivery = { ok: true, product: 'capture', proof_id: id, public_proof_url: `${API_ORIGIN}/p/${id}`, manifest_url: `${API_ORIGIN}/v1/proofs/${id}`, bundle_root: `sha256:${'a'.repeat(64)}`, observed_at: '2026-10-04T00:00:00Z' };
let root: Root;
let container: HTMLDivElement;
let walletRequest: ReturnType<typeof vi.fn>;
let chain: string;
let accounts: string[];
let paid: ReturnType<typeof vi.fn>;
let allFetch: ReturnType<typeof vi.fn>;

async function render() { await act(async () => { root.render(<App />); }); }
async function click() {
  await act(async () => { container.querySelector<HTMLButtonElement>('.primary-action')!.click(); await vi.dynamicImportSettled(); });
}
async function finished() {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('.result-status')!.textContent).not.toBe('READY');
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState(null, '', '/?product=capture&url=https%3A%2F%2Fexample.org%2Fterms');
  window.localStorage.clear();
  state.signer = null; state.secondSign = false; state.beforeSign = null;
  state.sign.mockReset().mockResolvedValue('0xfixture-not-a-real-signature');
  chain = '0x2105'; accounts = [account];
  walletRequest = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'wallet_switchEthereumChain') return null;
    if (method === 'eth_requestAccounts') return [account];
    if (method === 'eth_accounts') return accounts;
    if (method === 'eth_chainId') return chain;
    throw new Error('Unexpected wallet action');
  });
  window.ethereum = { request: walletRequest } as never;
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name, _options, callback) => callback({ name: _name })) } });
  paid = vi.fn(async () => Response.json(delivery));
  allFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (input instanceof Request && input.headers.has('payment-signature')) return paid(input, init);
    return Response.json(quote);
  });
  vi.stubGlobal('fetch', allFetch);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); container.remove();
  delete window.ethereum; vi.restoreAllMocks(); window.localStorage.clear(); vi.unstubAllGlobals();
});

describe('buyer assurance at the wallet and request boundary', () => {
  it('retains a normal single-authorization completed purchase', async () => {
    await render(); await click(); await finished();
    expect(state.sign).toHaveBeenCalledTimes(1); expect(paid).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.result-status')!.textContent).toBe('CAPTURED');
    expect(window.localStorage.getItem(PAYMENT_ATTEMPT_KEY)).toBeNull();
  });

  it.each(['account', 'chain', 'provider'])('blocks a %s change between connection and signing', async (kind) => {
    state.beforeSign = () => {
      if (kind === 'account') accounts = ['0x0000000000000000000000000000000000000002'];
      if (kind === 'chain') chain = '0x1';
      if (kind === 'provider') window.ethereum = { request: walletRequest } as never;
    };
    await render(); await click(); await finished();
    expect(state.sign).not.toHaveBeenCalled(); expect(paid).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/wallet.*changed/i);
    expect(window.localStorage.getItem(PAYMENT_ATTEMPT_KEY)).toBeNull();
  });

  it('does not authorize a second payload if a transport recovery asks the signer again', async () => {
    state.secondSign = true;
    paid.mockResolvedValue(Response.json({ state: 'processing' }, { status: 202 }));
    await render(); await click(); await finished();
    expect(state.sign).toHaveBeenCalledTimes(1); expect(paid).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLButtonElement>('.primary-action')!.disabled).toBe(true);
    expect(container.textContent).toContain('Do not approve another payment');
  });

  it('never displays an untrusted quote error or calls it a wallet decline', async () => {
    allFetch.mockResolvedValue(Response.json({ error: 'provider denied Bearer fixture-private-value' }, { status: 403 }));
    await render();
    expect(container.textContent).not.toContain('fixture-private-value');
    expect(container.textContent).not.toContain('Wallet request was declined');
    expect(container.textContent).toContain('HTTP 403');
    expect(state.sign).not.toHaveBeenCalled();
  });

  it('never displays untrusted wallet transport error details', async () => {
    walletRequest.mockRejectedValue(new Error('RPC failure https://wallet.test/?token=fixture-private-value'));
    await render(); await click(); await finished();
    expect(container.textContent).not.toContain('fixture-private-value');
    expect(state.sign).not.toHaveBeenCalled(); expect(paid).not.toHaveBeenCalled();
  });

  it('classifies an explicit numeric wallet rejection without exposing provider prose', async () => {
    walletRequest.mockRejectedValue({ code: 4001, message: 'fixture-private-value' });
    await render(); await click(); await finished();
    expect(container.textContent).toContain('Wallet request was declined');
    expect(container.textContent).not.toContain('fixture-private-value');
    expect(state.sign).not.toHaveBeenCalled(); expect(paid).not.toHaveBeenCalled();
  });

  it('bounds quote requests so an unanswered GET becomes a retryable quote error', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    allFetch.mockImplementation(async (_input, init) => {
      const signal = _input instanceof Request ? _input.signal : init?.signal;
      if (!signal) return new Promise<Response>(() => {});
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('fixture timeout', 'TimeoutError')), { once: true }));
    });
    await render();
    await act(async () => { controller.abort(); });
    await vi.waitFor(() => expect(container.textContent).toContain('Quote unavailable'));
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(container.querySelector<HTMLButtonElement>('.primary-action')!.disabled).toBe(true);
    expect(state.sign).not.toHaveBeenCalled();
  });

  it('bounds signed request waiting and retains the marker without a new authorization', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    paid.mockImplementation(async (request: Request) => new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new DOMException('fixture timeout', 'TimeoutError')), { once: true });
    }));
    await render(); await click();
    await vi.waitFor(() => expect(paid).toHaveBeenCalledTimes(1));
    await act(async () => { controller.abort(); });
    await finished();
    expect(container.querySelector('.result-status')!.textContent).toBe('UNCONFIRMED');
    expect(timeout).toHaveBeenCalledWith(120_000);
    expect(window.localStorage.getItem(PAYMENT_ATTEMPT_KEY)).not.toBeNull();
    expect(state.sign).toHaveBeenCalledTimes(1);
  });

  it('ignores an aborted transport that resolves late instead of declaring a completed proof', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let resolveLate!: (value: Response) => void;
    paid.mockImplementation(async () => new Promise<Response>((resolve) => { resolveLate = resolve; }));
    await render(); await click();
    await vi.waitFor(() => expect(paid).toHaveBeenCalledTimes(1));
    await act(async () => { controller.abort(); });
    await finished();
    const marker = window.localStorage.getItem(PAYMENT_ATTEMPT_KEY);
    await act(async () => { resolveLate(Response.json(delivery)); });
    expect(container.querySelector('.result-status')!.textContent).toBe('UNCONFIRMED');
    expect(container.querySelector('.completed-result')).toBeNull();
    expect(window.localStorage.getItem(PAYMENT_ATTEMPT_KEY)).toBe(marker);
    await click();
    expect(state.sign).toHaveBeenCalledTimes(1); expect(paid).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Reference:');
    expect(container.querySelector<HTMLAnchorElement>('a[href^="mailto:"]')!.href).toContain('ruphussten@163.com');
  });

  it('bounds a stalled response body as well as the initial HTTP response', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ start() {}, cancel: cancelled }));
    paid.mockResolvedValue(response);
    await render(); await click();
    await vi.waitFor(() => expect(paid).toHaveBeenCalledTimes(1));
    await act(async () => { controller.abort(); });
    await finished();
    expect(container.querySelector('.result-status')!.textContent).toBe('UNCONFIRMED');
    expect(window.localStorage.getItem(PAYMENT_ATTEMPT_KEY)).not.toBeNull();
    expect(state.sign).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('keeps the purchase locked while an uncancellable wallet prompt is waiting', async () => {
    let resolveSignature!: (signature: string) => void;
    state.sign.mockImplementation(() => new Promise<string>((resolve) => { resolveSignature = resolve; }));
    await render(); await click();
    await vi.waitFor(() => expect(state.sign).toHaveBeenCalledTimes(1));
    expect(container.querySelector<HTMLButtonElement>('.primary-action')!.disabled).toBe(true);
    expect(paid).not.toHaveBeenCalled();
    await click();
    expect(state.sign).toHaveBeenCalledTimes(1);
    await act(async () => { resolveSignature('0xfixture-late-signature'); });
    await finished();
    expect(paid).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.result-status')!.textContent).toBe('CAPTURED');
  });
});
