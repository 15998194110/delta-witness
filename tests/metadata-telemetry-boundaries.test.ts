import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { MemoryBucket, orderPayment, orderRequest, orderRuntime } from './helpers/order-runtime';
import { createOrderReadSnapshot, MetadataReadError, readOrderMetadata } from '../src/order-storage';
import { guardedFacilitator, readSettlement } from '../src/settlement';
import { recordEvent } from '../src/telemetry';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';

beforeEach(()=>vi.spyOn(console,'error').mockImplementation(()=>undefined));
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});

function barrier<T>() {
  let enter!:()=>void,release!:(value:T)=>void;
  return {entered:new Promise<void>(resolve=>enter=resolve),pending:new Promise<T>(resolve=>release=resolve),
    enter:()=>enter(),release:(value:T)=>release(value)};
}
const cases=['capture','preflight','guarded-action-pilot'].flatMap(product=>['get','body'].map(stage=>({product,stage})));
describe('critical metadata and diagnostic isolation, no external services',()=>{
  it.each(cases)('bounds the initial signed legacy $product $stage read and fences late continuation',async({product,stage})=>{
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),held=barrier<any>();
    const original=bucket.get.bind(bucket),cancel=vi.fn(),forbiddenJson=vi.fn(async()=>{await held.pending;return {schema:product==='guarded-action-pilot'?'delta-guarded-action-pilot/v1':'delta-fulfillment/v1'};});
    const object={size:2,etag:'fixture',body:new ReadableStream<Uint8Array>({cancel}),json:forbiddenJson};
    bucket.get=async key=>{
      if(!key.startsWith(product==='guarded-action-pilot'?'guarded-pilot/':'fulfillments/'))return original(key);
      held.enter();return stage==='get'?await held.pending:object;
    };
    const network=vi.fn(async()=>{throw new Error('unexpected new work after unknown original metadata');});vi.stubGlobal('fetch',network);
    vi.useFakeTimers();let finished:Response|undefined;
    const running=Promise.resolve(app.fetch(orderRequest({product,legacy:true,body:product==='guarded-action-pilot'?{urls:['https://example.com/']}:{url:'https://example.com/'}}),env)).then(response=>{finished=response;return response;});
    await held.entered;await vi.advanceTimersByTimeAsync(15_001);
    const timedOut=finished;
    held.release(stage==='get'?object:undefined);await vi.advanceTimersByTimeAsync(1);await running;
    expect(timedOut?.status).toBe(503);expect(await timedOut!.json()).toMatchObject({ok:false});
    expect(forbiddenJson).not.toHaveBeenCalled();expect(cancel).toHaveBeenCalled();
    expect(bucket.values.size).toBe(0);expect(env.BROWSER.quickAction).not.toHaveBeenCalled();expect(network).not.toHaveBeenCalled();
  });
  it('a stalled D1 diagnostic cannot withhold an otherwise available quote and its late ACK does not repeat work',async()=>{
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),held=barrier<any>();
    const run=vi.fn(()=>{held.enter();return held.pending;});
    env.ANALYTICS_DB={prepare:()=>({bind:()=>({run})})} as any;
    const network=vi.fn(async()=>{throw new Error('no network for quote');});vi.stubGlobal('fetch',network);
    vi.useFakeTimers();let finished:Response|undefined;
    const running=Promise.resolve(app.fetch(new Request('https://delta.test/v1/quote'),env)).then(response=>{finished=response;return response;});
    await held.entered;await vi.advanceTimersByTimeAsync(1_001);const timedOut=finished;
    held.release({success:true});await vi.advanceTimersByTimeAsync(1);await running;
    expect(timedOut?.status).toBe(200);expect(run).toHaveBeenCalledTimes(1);expect(network).not.toHaveBeenCalled();
    expect(env.BROWSER.quickAction).not.toHaveBeenCalled();expect(bucket.values.size).toBe(0);
  });
  it.each(['get','body'])('bounds an existing settlement %s read without converting it to missing or resubmitting',async stage=>{
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),held=barrier<any>(),cancel=vi.fn();
    const object={size:2,etag:'fixture',body:new ReadableStream<Uint8Array>({cancel}),json:vi.fn()};
    bucket.get=async()=>{held.enter();return stage==='get'?await held.pending:object;};
    const network=vi.fn(async()=>{throw new Error('no resubmission of unknown settlement');});vi.stubGlobal('fetch',network);
    const payment=orderPayment(),header=Buffer.from(JSON.stringify(payment)).toString('base64');
    vi.useFakeTimers();
    const read=readSettlement(env,header).then(()=>({ok:true}),error=>({error}));
    await held.entered;await vi.advanceTimersByTimeAsync(15_001);
    expect(await read).toMatchObject({error:expect.any(MetadataReadError)});
    held.release(object);await vi.advanceTimersByTimeAsync(1);
    expect(cancel).toHaveBeenCalled();expect(object.json).not.toHaveBeenCalled();expect(network).not.toHaveBeenCalled();expect(bucket.values.size).toBe(0);
  });
  it('the guarded facilitator cannot create a reservation or submit after an unknown existing-record read',async()=>{
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),held=barrier<any>(),cancel=vi.fn();
    bucket.get=async()=>{held.enter();return held.pending;};
    const network=vi.fn(async()=>{throw new Error('no settlement allowed');});vi.stubGlobal('fetch',network);
    vi.useFakeTimers();const payment=orderPayment();
    const running=guardedFacilitator(env,'sha256:fixture','sha256:fixture').client.settle(payment as unknown as PaymentPayload,payment.accepted as unknown as PaymentRequirements)
      .then(()=>({ok:true}),error=>({error}));
    await held.entered;await vi.advanceTimersByTimeAsync(15_001);expect(await running).toMatchObject({error:expect.any(MetadataReadError)});
    held.release({size:2,etag:'fixture',body:new ReadableStream({cancel})});await vi.advanceTimersByTimeAsync(1);
    expect(cancel).toHaveBeenCalled();expect(network).not.toHaveBeenCalled();expect(bucket.values.size).toBe(0);
  });
  it.each(['declared-size','actual-size','truncated','invalid-json','invalid-utf8','json-only'])
  ('rejects %s metadata without falling back to a provider JSON shortcut',async kind=>{
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),providerJson=vi.fn(async()=>({schema:'pretend-valid'}));
    const bytes=kind==='actual-size'?new Uint8Array(32_001):kind==='invalid-json'?new TextEncoder().encode('{x'):
      kind==='invalid-utf8'?new Uint8Array([0xff,0xff]):new TextEncoder().encode('{}');
    const cancel=vi.fn();
    bucket.get=async()=>({etag:'fixture',size:kind==='declared-size'?32_001:kind==='truncated'?4:2,
      ...(kind!=='json-only'?{body:new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes);controller.close();},cancel})}:{}),json:providerJson}) as any;
    await expect(readOrderMetadata(env,'fixture')).rejects.toBeInstanceOf(MetadataReadError);
    expect(providerJson).not.toHaveBeenCalled();expect(bucket.values.size).toBe(0);
  });
  it('nested snapshot metadata readers consume bounded bytes and preserve the original ETag',async()=>{
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),record={schema:'fixture',state:'unknown'};
    await bucket.put('fixture',JSON.stringify(record));const before=structuredClone([...bucket.values.entries()]);
    const snapshot=createOrderReadSnapshot(env);
    try {
      expect(await readOrderMetadata(snapshot.env,'fixture')).toEqual({record,etag:bucket.values.get('fixture')!.etag});
      expect(await readOrderMetadata(snapshot.env,'fixture')).toEqual({record,etag:bucket.values.get('fixture')!.etag});
    } finally {snapshot.cancel();}
    expect([...bucket.values.entries()]).toEqual(before);
  });
  it('a rejected late telemetry write emits no provider prose and never retries or fails the business caller',async()=>{
    const env=orderRuntime(new MemoryBucket());let reject!:(error:Error)=>void;
    const run=vi.fn(()=>new Promise((_resolve,rejectPromise)=>{reject=rejectPromise;}));
    env.ANALYTICS_DB={prepare:()=>({bind:()=>({run})})} as any;vi.useFakeTimers();
    const recording=recordEvent(env,{event:'capture_completed',route:'/v1/capture',success:true});
    await vi.advanceTimersByTimeAsync(1001);await expect(recording).resolves.toBeUndefined();
    reject(new Error('provider fixture-secret'));await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('fixture-secret');
    expect(console.error).toHaveBeenCalledWith(JSON.stringify({event:'analytics_write_failed',reason:'analytics_write_timeout'}));
  });
});
