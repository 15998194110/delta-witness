import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app as currentApp } from '../src/index';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { MemoryBucket, mockOrderNetwork, orderRequest, orderRuntime } from './helpers/order-runtime';
import { storeCapture, readStoredCapture } from '../src/capture';

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const runtimes: [string,typeof currentApp][] = [['current',currentApp]];
if (process.env.DELTA_FALLBACK_BUILD_EVIDENCE) {
  const evidence=JSON.parse(await readFile(process.env.DELTA_FALLBACK_BUILD_EVIDENCE,'utf8'));
  const reviewed=process.env.DELTA_FALLBACK_REVIEWED_COMMIT;
  if (!reviewed || !/^[a-f0-9]{40}$/.test(reviewed) || evidence.commit!==reviewed || evidence.schema!=='delta-isolated-fallback-build/v1' ||
      evidence.platform!=='node' || !Array.isArray(evidence.source_files) || !evidence.source_files.some((file:{path:string})=>file.path==='src/index.ts') ||
      createHash('sha256').update(await readFile(evidence.artifact)).digest('hex')!==evidence.artifact_sha256) throw new Error('unverified_fallback_artifact');
  const candidate=await import(/* @vite-ignore */ pathToFileURL(evidence.artifact).href);
  if(typeof candidate.app?.fetch!=='function')throw new Error('unsupported_fallback_exports');
  runtimes.push(['reviewed-fallback',candidate.app]);
}
describe.each(runtimes)('%s original financial and delivery writes are bounded, synthetic only', (_name,app) => {
  it.each(['settlement-reservation', 'settlement-confirmation', 'settlement-diagnostic', 'order-binding', 'fulfillment-claim', 'fulfillment-draft', 'fulfillment-complete', 'artifact', 'manifest'])('stalled %s returns unknown and a late ACK cannot start new work', async stage => {
    const bucket = new MemoryBucket(), env = orderRuntime(bucket), network = stage === 'settlement-diagnostic' ? mockOrderNetwork(async()=>{throw new Error('synthetic settlement ACK lost');}) : mockOrderNetwork();
    vi.stubGlobal('fetch', network); vi.useFakeTimers();
    const put = bucket.put.bind(bucket);
    let enter!: () => void, release!: () => void, held = false, result: Response | undefined;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    bucket.put = async (key, value, options) => {
      const row = typeof value === 'string' && /^(?:settlements|orders|fulfillments)\//.test(key) ? JSON.parse(value) : undefined;
      const target = stage === 'settlement-reservation' ? key.startsWith('settlements/') && row?.state === 'settlement_unknown' :
        stage === 'settlement-confirmation' ? key.startsWith('settlements/') && row?.state === 'settlement_confirmed' :
        stage === 'settlement-diagnostic' ? key.startsWith('settlements/') && row?.failure_class :
        stage === 'order-binding' ? key.startsWith('orders/') :
        stage === 'artifact' ? key.endsWith('/page.html') :
        stage === 'manifest' ? key.endsWith('/manifest.json') :
        key.startsWith('fulfillments/') && (stage === 'fulfillment-claim' ? !row?.response : stage === 'fulfillment-draft' ? row?.response && row.state === 'processing' : row?.state === 'complete');
      if (!held && target) {
        held = true; enter(); return new Promise(resolve => { release = () => { void put(key, value, options).then(resolve); }; });
      }
      return put(key, value, options);
    };
    const running = Promise.resolve(app.fetch(orderRequest({legacy:stage !== 'order-binding'}), env)).then(response => { result = response; return response; });
    await entered; await vi.advanceTimersByTimeAsync(15_001);
    const deadlineResult = result, networkBeforeRelease = network.mock.calls.length, browserBeforeRelease = vi.mocked(env.BROWSER.quickAction).mock.calls.length;
    release(); await running; await vi.advanceTimersByTimeAsync(1);
    expect(deadlineResult?.status).toBe(503);
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(browserBeforeRelease);
    expect(network.mock.calls).toHaveLength(networkBeforeRelease);
    const records = [...bucket.values.entries()].filter(([key]) => /^(?:settlements|fulfillments)\//.test(key)).map(([,value]) => JSON.parse(value.text));
    expect(records.some(value => value.failure_class === 'unexpected_error')).toBe(false);
    if (['settlement-reservation','order-binding'].includes(stage)) {
      expect(records.find(value => value.schema === 'delta-settlement/v1').state).toBe('settlement_unknown');
      expect(network.mock.calls.filter(([url]) => String(url).endsWith('/settle'))).toHaveLength(0);
    }
    if (stage === 'settlement-confirmation') {
      expect(records.find(value => value.schema === 'delta-settlement/v1').state).toBe('settlement_confirmed');
      expect(records.filter(value => value.schema === 'delta-fulfillment/v1')).toHaveLength(0);
    }
    if (stage === 'artifact') expect([...bucket.values.keys()].some(key => key.endsWith('/manifest.json'))).toBe(false);
    if (stage === 'manifest') expect(records.find(value=>value.schema==='delta-fulfillment/v1').state).toBe('processing');
  });

  it.each(['get','body'])('direct legacy draft recovery bounds its original artifact %s without replacing or recapturing', async stage => {
    const bucket = new MemoryBucket(), env = orderRuntime(bucket), network = mockOrderNetwork();
    vi.stubGlobal('fetch',network);
    const put = bucket.put.bind(bucket);
    bucket.put = async (key, value, options) => {
      if (key.startsWith('fulfillments/') && JSON.parse(String(value)).state === 'complete') throw new Error('synthetic final ACK loss');
      return put(key, value, options);
    };
    expect((await app.fetch(orderRequest({legacy:true}),env)).status).toBe(503);
    bucket.put = put;
    const before = structuredClone([...bucket.values]), get = bucket.get.bind(bucket), cancel = vi.fn();
    let enter!:()=>void, release!:()=>void, result:Response|undefined;
    const entered=new Promise<void>(resolve=>{enter=resolve;});
    bucket.get=async key=>{
      const object=await get(key);
      if(!key.endsWith('/page.html'))return object;
      const stalled={...object!,body:new ReadableStream<Uint8Array>({cancel})};enter();
      return stage==='get'?new Promise(resolve=>{release=()=>resolve(stalled);}):stalled;
    };
    vi.useFakeTimers();
    const running=Promise.resolve(app.fetch(orderRequest({legacy:true}),env)).then(response=>{result=response;return response;});
    await entered;await vi.advanceTimersByTimeAsync(15_001);const deadlineResult=result;
    if(stage==='get')release();await running;await vi.advanceTimersByTimeAsync(1);
    expect(deadlineResult?.status).toBe(503);expect(cancel).toHaveBeenCalled();
    expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);expect([...bucket.values]).toEqual(before);
    expect(network.mock.calls.filter(([url])=>String(url).endsWith('/settle'))).toHaveLength(1);
  });

  // The deployed bundle exports only Worker/app; its internal store helper is
  // separately covered by the candidate's full source suite, not mislabelled
  // as a fallback invocation through this current-source import.
  (_name === 'current' ? it : it.skip)('immutable artifact conflict read is bounded and cannot publish a late replacement manifest',async()=>{
    const bucket=new MemoryBucket(),env=orderRuntime(bucket);vi.stubGlobal('fetch',mockOrderNetwork());
    expect((await app.fetch(orderRequest({legacy:true}),env)).status).toBe(200);
    const original=JSON.parse([...bucket.values.entries()].find(([key])=>key.startsWith('fulfillments/'))![1].text);
    const artifacts=await readStoredCapture({env,fulfillmentFingerprint:original.fulfillment_fingerprint,product:'capture',requestedUrl:'https://example.com/',grossPriceUsd:1,paymentProtocol:'x402-v2-upfront'});
    expect(artifacts).not.toBeNull();const before=structuredClone([...bucket.values]),get=bucket.get.bind(bucket),put=bucket.put.bind(bucket),puts:string[]=[];
    let enter!:()=>void,release!:()=>void,result:unknown;
    const entered=new Promise<void>(resolve=>{enter=resolve;});
    bucket.get=async key=>{if(!key.endsWith('/page.html'))return get(key);enter();return new Promise(resolve=>{release=()=>{void get(key).then(resolve);};});};
    bucket.put=async(key,value,options)=>{puts.push(key);return put(key,value,options);};
    vi.useFakeTimers();const running=storeCapture(env,artifacts!).then(()=>{result='success';},error=>{result=error;});
    await entered;await vi.advanceTimersByTimeAsync(15_001);const timedOut=result;release();await running;await vi.advanceTimersByTimeAsync(1);
    expect(timedOut).toMatchObject({message:'order_evidence_unavailable'});
    expect(puts.some(key=>key.endsWith('/manifest.json'))).toBe(false);expect([...bucket.values]).toEqual(before);
  });

  it.each(['get','body'])('prior proof %s is bounded before settlement and a late read starts no new work',async stage=>{
    const bucket=new MemoryBucket(),env=orderRuntime(bucket),network=mockOrderNetwork();vi.stubGlobal('fetch',network);
    const id='22222222-2222-4222-8222-222222222222',cancel=vi.fn();
    let enter!:()=>void,release!:()=>void,result:Response|undefined;
    const entered=new Promise<void>(resolve=>{enter=resolve;});
    bucket.get=async key=>{
      if(key!==`${id}/manifest.json`)return null;
      enter();const object={size:2,etag:'fixture',body:new ReadableStream<Uint8Array>({cancel}),json:vi.fn()};
      return (stage==='get'?new Promise(resolve=>{release=()=>resolve(object);}):object) as any;
    };
    vi.useFakeTimers();
    const running=Promise.resolve(app.fetch(orderRequest({legacy:true,product:'preflight',body:{url:'https://example.com/',prior_proof_id:id}}),env)).then(response=>{result=response;return response;});
    await entered;await vi.advanceTimersByTimeAsync(15_001);const timedOut=result,networkCalls=network.mock.calls.length;
    if(stage==='get')release();await running;await vi.advanceTimersByTimeAsync(1);
    expect(timedOut?.status).toBe(503);expect(cancel).toHaveBeenCalled();expect(network.mock.calls).toHaveLength(networkCalls);
    expect(network.mock.calls.filter(([url])=>String(url).endsWith('/settle'))).toHaveLength(0);
    expect(env.BROWSER.quickAction).not.toHaveBeenCalled();expect(bucket.values.size).toBe(0);
  });
});
