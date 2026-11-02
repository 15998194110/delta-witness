import { afterEach, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { MemoryBucket, orderRuntime, orderRequest, mockOrderNetwork } from './helpers/order-runtime';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['get','body'])('bounds stalled scoped enrollment %s before any payment or Browser work', async stage => {
  vi.useFakeTimers();
  const bucket = new MemoryBucket(), env = orderRuntime(bucket), network = mockOrderNetwork();
  vi.stubGlobal('fetch',network);
  let observed = false, release: (()=>void) | undefined;
  const cancel = vi.fn();
  const object = {size:1,etag:'synthetic',body:new ReadableStream<Uint8Array>({cancel}),
    json:async()=>new Promise(()=>{})};
  bucket.get = async key => {
    if (!key.startsWith('orders/')) return null;
    observed = true;
    if (stage === 'get') return new Promise(resolve=>{ release=()=>resolve(object as never); });
    return object as never;
  };
  const pending = app.fetch(orderRequest({unpaid:true}),env);
  await vi.waitFor(()=>expect(observed).toBe(true));
  await vi.advanceTimersByTimeAsync(15_001);
  expect((await pending).status).toBe(503);
  release?.(); await vi.advanceTimersByTimeAsync(1);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(network).not.toHaveBeenCalled(); expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  expect(bucket.values.size).toBe(0);
});

it('rejects misdeclared actual enrollment metadata bytes before JSON parsing or payment', async () => {
  const bucket = new MemoryBucket(), env = orderRuntime(bucket), network = mockOrderNetwork();
  vi.stubGlobal('fetch',network);
  const cancel = vi.fn(), json = vi.fn(async()=>({}));
  bucket.get = async key => key.startsWith('orders/') ? ({size:1,etag:'synthetic',json,
    body:new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(32_001));},cancel})} as never) : null;
  const result = await app.fetch(orderRequest({unpaid:true}),env);
  expect(result.status).toBe(503);
  expect(json).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(1);
  expect(network).not.toHaveBeenCalled(); expect(env.BROWSER.quickAction).not.toHaveBeenCalled();
  expect(bucket.values.size).toBe(0);
});
