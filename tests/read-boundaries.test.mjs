import { describe, expect, it, vi } from 'vitest';
import { fetchTextBounded } from '../scripts/bounded-http.mjs';

describe('read-only integration boundaries', () => {
  it('importing reporting and catalog modules never starts network calls', async () => {
    const denied = vi.fn(() => { throw new Error('unexpected_network'); });
    vi.stubGlobal('fetch', denied);
    await import('../scripts/query-funnel.mjs');
    await import('../scripts/query-revenue-candidates.mjs');
    await import('../scripts/register-true402.mjs');
    expect(denied).not.toHaveBeenCalled();
  });
  it('times out a noncooperative fetch without retry', async () => {
    const fetchImpl = vi.fn(() => new Promise(() => {}));
    await expect(fetchTextBounded(fetchImpl, 'https://example.test/', {}, { timeoutMs: 15 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('body cancellation cannot convert timeout to successful EOF', async () => {
    const cancel = vi.fn();
    await expect(fetchTextBounded(async () => new Response(new ReadableStream({ cancel })), 'https://example.test/', {}, { timeoutMs: 15 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(cancel).toHaveBeenCalled();
  });
  it('accepts a bounded normal response, rejects oversized bodies', async () => {
    expect((await fetchTextBounded(async () => new Response('ok'), 'https://example.test/', {})).text).toBe('ok');
    await expect(fetchTextBounded(async () => new Response('123456'), 'https://example.test/', {}, { maxBytes: 5 })).rejects.toThrow('read_size_limit');
  });
});
