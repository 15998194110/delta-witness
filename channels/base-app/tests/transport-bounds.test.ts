import { afterEach, expect, it, vi } from 'vitest';
import { fetchWithDeadline } from '../src/domain';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('cancels oversized API metadata instead of buffering it without a limit', async () => {
  const cancelled = vi.fn();
  const fetch = vi.fn(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1_048_577)); }, cancel: cancelled,
  })));
  vi.stubGlobal('fetch', fetch);
  await expect(fetchWithDeadline('https://api.test/result', undefined, 1000)).rejects.toThrow('response_too_large');
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('cancels a response that arrives after the deadline without consuming it', async () => {
  const timeout = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
  let resolve!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal('fetch', fetch);
  const pending = fetchWithDeadline('https://api.test/result', undefined, 1000);
  timeout.abort();
  await expect(pending).rejects.toThrow('Request deadline exceeded');
  const cancelled = vi.fn();
  resolve(new Response(new ReadableStream({ start() {}, cancel: cancelled })));
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('preserves API status, headers, and complete metadata within the limit', async () => {
  const metadata = {ok: false, state: 'processing'};
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(metadata, {status: 202, headers: {'retry-after': '5'}})));
  const response = await fetchWithDeadline('https://api.test/result', undefined, 1000);
  expect(response.status).toBe(202);
  expect(response.headers.get('retry-after')).toBe('5');
  expect(await response.json()).toEqual(metadata);
});
