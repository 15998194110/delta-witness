import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const signing = vi.hoisted(() => ({
  sign: vi.fn(async () => '0xfixture-not-a-signature'),
  signer: null as null | { signTypedData: (input: never) => Promise<string> },
  mode: 'none' as 'none' | 'twice' | 'after_fetch',
}));
vi.mock('@x402/fetch', () => ({
  x402Client: class { setSpendControls() {} registerPolicy() {} },
  wrapFetchWithPayment: (fetchImpl: typeof fetch) => async (input: RequestInfo | URL, init?: RequestInit) => {
    if (signing.mode === 'twice') await signing.signer!.signTypedData({} as never);
    const response = await fetchImpl(input, init);
    if (signing.mode !== 'none') await signing.signer!.signTypedData({} as never);
    return response;
  },
}));
vi.mock('@x402/evm/exact/client', () => ({ registerExactEvmScheme: vi.fn((_client, config) => { signing.signer = config.signer; }) }));
vi.mock('viem/accounts', () => ({ privateKeyToAccount: vi.fn(() => ({ address: 'fixture-no-signing', signTypedData: signing.sign })) }));
import { createServer } from '../src/index.js';

const origin = 'https://delta-witness-api.ruphussten.workers.dev';
const proofId = '56347db8-1aa5-447f-a0e4-3bb052d7aa89';
const delivery = (product = 'capture') => ({
  ok: true, product, proof_id: proofId,
  manifest_url: `${origin}/v1/proofs/${proofId}`, public_proof_url: `${origin}/p/${proofId}`,
  bundle_root: `sha256:${'a'.repeat(64)}`, observed_at: '2026-10-03T10:00:00Z',
  ...(product === 'preflight' ? { safe: false, changed: true } : {}),
});

async function call(name: string, args: Record<string, unknown> = { url: 'https://example.com' }) {
  const server = createServer();
  const client = new Client({ name: 'offline-regression', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  } finally {
    await client.close();
    await server.close();
  }
}

beforeEach(() => {
  // These are fixture values. Both account derivation and payment signing are
  // module mocks; the SDK communicates only through in-memory transport.
  vi.stubEnv('EVM_PRIVATE_KEY', `0x${'1'.repeat(64)}`);
  vi.stubEnv('DELTA_MAX_USD_PER_CALL', '5.00');
  vi.stubEnv('DELTA_BASE_URL', origin);
  signing.mode = 'none';
  signing.signer = null;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('real MCP paid tool callbacks require completed delivery', () => {
  it('refuses a second SDK authorization for the same call', async () => {
    signing.mode = 'twice';
    const transport = vi.fn(async () => Response.json(delivery()));
    vi.stubGlobal('fetch', transport);
    const result = await call('delta_capture');
    expect(result.structuredContent).toMatchObject({ error: 'payment_outcome_unconfirmed', retryable: false });
    expect(signing.sign).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });
  it('ends a noncooperative transport wait and forbids late signing', async () => {
    vi.useFakeTimers();
    signing.mode = 'after_fetch';
    let resolveLate!: (response: Response) => void;
    const transport = vi.fn(() => new Promise<Response>(resolve => { resolveLate = resolve; }));
    vi.stubGlobal('fetch', transport);
    const pending = call('delta_capture');
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(120001);
    expect((await pending).structuredContent).toMatchObject({ error: 'payment_outcome_unconfirmed' });
    resolveLate(Response.json(delivery()));
    await vi.advanceTimersByTimeAsync(1);
    expect(signing.sign).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledOnce();
  });
  it('cancels a stalled paid response body and preserves uncertainty', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const transport = vi.fn(async () => new Response(new ReadableStream({ start() {}, cancel })));
    vi.stubGlobal('fetch', transport);
    const pending = call('delta_capture');
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(120001);
    expect((await pending).structuredContent).toMatchObject({ error: 'payment_outcome_unconfirmed', status: 200 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });
  it('bounds unpaid reads independently of the payment deadline', async () => {
    vi.useFakeTimers();
    const transport = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', transport);
    const pending = call('delta_quote', { product: 'capture' });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(20001);
    expect((await pending).structuredContent).toMatchObject({ error: 'read_failed' });
    expect(signing.sign).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledOnce();
  });
  it('rejects oversized paid metadata without repeating the request', async () => {
    const transport = vi.fn(async () => new Response('x'.repeat(1_048_577)));
    vi.stubGlobal('fetch', transport);
    expect((await call('delta_capture')).structuredContent).toMatchObject({ error: 'payment_outcome_unconfirmed' });
    expect(transport).toHaveBeenCalledOnce();
  });
  it('accepts a legitimate 35-second paid response without wrapping or submitting twice', async () => {
    vi.useFakeTimers();
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    try {
      const transport = vi.fn(async (_input, init) => new Promise<Response>((resolve, reject) => {
        setTimeout(() => resolve(Response.json(delivery())), 35000);
        init?.signal?.addEventListener('abort', () => reject(new Error('simulated timeout')), {once: true});
      }));
      vi.stubGlobal('fetch', transport);
      const pending = call('delta_capture');
      await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(35000);
      expect((await pending).isError).not.toBe(true);
      expect(transport).toHaveBeenCalledTimes(1);
    } finally { deadline.mockRestore(); vi.useRealTimers(); }
  });
  it.each(['capture', 'preflight'])('accepts a complete %s delivery, including a negative preflight finding', async (product) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(delivery(product))));
    const result = await call(`delta_${product}`);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject(delivery(product));
  });

  it.each([
    ['pending 202', 202, { ok: true, state: 'pending' }],
    ['empty object 200', 200, {}],
    ['wrong product 200', 200, delivery('preflight')],
    ['foreign manifest 200', 200, { ...delivery(), manifest_url: 'https://foreign.test/proof' }],
    ['error object 200', 200, { error: 'fixture-secret-123' }],
    ['unauthenticated 401', 401, { error: 'fixture-secret-123' }],
    ['forbidden 403', 403, { error: 'fixture-secret-123' }],
    ['retryable 503', 503, { error: 'fixture-secret-123' }],
  ])('%s is an unconfirmed outcome with no automatic new payment', async (_label, status, body) => {
    const fetchImpl = vi.fn(async () => Response.json(body, { status: Number(status) }));
    vi.stubGlobal('fetch', fetchImpl);
    const result = await call('delta_capture');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: 'payment_outcome_unconfirmed', retryable: false });
    expect(JSON.stringify(result)).toMatch(/do not approve another payment/i);
    expect(JSON.stringify(result)).not.toContain('fixture-secret-123');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a missing preflight evaluation is not a completed preflight', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...delivery(), product: 'preflight' })));
    expect((await call('delta_preflight')).isError).toBe(true);
  });

  it.each(['malformed', 'network'])('%s paid failure does not expose untrusted content or request another payment', async (kind) => {
    const fetchImpl = vi.fn(async () => {
      if (kind === 'network') throw new Error('Bearer fixture-secret-123 signed payment body');
      return new Response('fixture-secret-123', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const result = await call('delta_capture');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: 'payment_outcome_unconfirmed', retryable: false });
    expect(JSON.stringify(result)).not.toContain('fixture-secret-123');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['delta_quote', 'delta_verify_proof'])('%s read failure does not expose provider or transport secrets', async (tool) => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Bearer fixture-secret-123'); }));
    const result = await call(tool, tool === 'delta_quote' ? { product: 'capture' } : { proof_id: proofId });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('fixture-secret-123');
  });
});
