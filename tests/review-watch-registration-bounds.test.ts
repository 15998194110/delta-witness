import {afterEach,describe,it,expect,vi} from 'vitest';
import {registerWatch,type WatchRegistration} from '../src/watch';
import {MemoryBucket,orderRuntime} from './helpers/order-runtime';

afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
function setup(request:Partial<WatchRegistration>={}) {
  const bucket=new MemoryBucket(),env=orderRuntime(bucket),analytics=vi.fn(async()=>{});
  env.ANALYTICS_DB={prepare:()=>({bind:()=>({run:analytics})})} as never;
  const input={env,request:{url:'https://example.com/',checks:2,interval_seconds:900,...request},requestHash:'sha256:registration-fixture',
    fingerprint:'sha256:original-registration-fixture',partner:'fixture',channel:'fixture',grossPaidUsd:2};
  return {bucket,env,input,analytics};
}

describe('bounded original Watch registration, no platform or capture operation',()=>{
  it.each(['get','body'])('stalled registration %s terminates and its late response cannot create an order',async stage=>{
    vi.useFakeTimers();const s=setup(),cancel=vi.fn();let reached=false,release:(()=>void)|undefined;
    const object={size:1,etag:'synthetic',body:new ReadableStream<Uint8Array>({cancel}),json:async()=>new Promise(()=>{})};
    s.bucket.get=async()=>{reached=true;if(stage==='get')return new Promise(resolve=>{release=()=>resolve(object as never);});return object as never;};
    const put=vi.spyOn(s.bucket,'put'),pending=registerWatch(s.input);await vi.waitFor(()=>expect(reached).toBe(true));await vi.advanceTimersByTimeAsync(20_001);
    expect(await pending).toMatchObject({status:503,body:{error:'watch_registration_unconfirmed',retryable:false}});
    release?.();await vi.advanceTimersByTimeAsync(1);expect(cancel).toHaveBeenCalledOnce();expect(put).not.toHaveBeenCalled();
    expect(s.analytics).not.toHaveBeenCalled();expect(s.env.BROWSER.quickAction).not.toHaveBeenCalled();expect(s.bucket.values.size).toBe(0);
  });
  it('a late committed registration remains on its original key and never resumes 201, telemetry or Browser work',async()=>{
    vi.useFakeTimers();const s=setup(),put=s.bucket.put.bind(s.bucket);let reached=false,release!:()=>void;
    s.bucket.put=async(key,value,options)=>{reached=true;return new Promise(resolve=>{release=()=>{void put(key,value,options).then(resolve);};});};
    const pending=registerWatch(s.input);await vi.waitFor(()=>expect(reached).toBe(true));await vi.advanceTimersByTimeAsync(20_001);
    expect((await pending).status).toBe(503);release();await vi.advanceTimersByTimeAsync(1);
    expect(s.bucket.values.size).toBe(1);expect(s.analytics).not.toHaveBeenCalled();expect(s.env.BROWSER.quickAction).not.toHaveBeenCalled();
    const originals=[...s.bucket.values];s.bucket.put=put;
    const replay=await registerWatch({...s.input,grossPaidUsd:0});expect(replay.status).toBe(200);expect(replay.body).toMatchObject({idempotent_replay:true,checks_remaining:2,checks_attempted:0});
    expect([...s.bucket.values]).toEqual(originals);expect(s.analytics).not.toHaveBeenCalled();
  });
  it('immediate endless CAS conflicts stop after three attempts without waiting for a timer',async()=>{
    const s=setup(),put=vi.spyOn(s.bucket,'put').mockResolvedValue(null);
    expect((await registerWatch(s.input)).status).toBe(503);expect(put).toHaveBeenCalledTimes(3);
    expect(s.bucket.values.size).toBe(0);expect(s.analytics).not.toHaveBeenCalled();expect(s.env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
  it('CAS conflict reads the winning original registration without replacing quota or revealing its secret',async()=>{
    const s=setup({webhook_url:'https://webhook.test/'}),put=s.bucket.put.bind(s.bucket);let conflicted=false;
    s.bucket.put=async(key,value,options)=>{const result=await put(key,value,options);if(!conflicted){conflicted=true;return null;}return result;};
    const result=await registerWatch(s.input);expect(result.status).toBe(200);expect(result.body).toMatchObject({idempotent_replay:true,checks_remaining:2});
    expect(result.body.webhook_secret).toBeUndefined();expect(s.analytics).not.toHaveBeenCalled();expect(s.bucket.values.size).toBe(1);
  });
  it.each(['oversized','invalid-json','missing-target'])('bad prior proof metadata (%s) cannot create or report a registered order',async kind=>{
    const id='11111111-1111-4111-8111-111111111111',s=setup({prior_proof_id:id}),cancel=vi.fn(),json=vi.fn();
    if(kind==='oversized')s.bucket.get=async key=>key.endsWith('/manifest.json')?({size:1,etag:'fixture',json,
      body:new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(262_145));},cancel})} as never):null;
    else await s.bucket.put(`${id}/manifest.json`,kind==='invalid-json'?'not-json':JSON.stringify({}));
    const originals=[...s.bucket.values];expect((await registerWatch(s.input)).status).toBe(503);
    expect([...s.bucket.values]).toEqual(originals);expect(s.analytics).not.toHaveBeenCalled();expect(s.env.BROWSER.quickAction).not.toHaveBeenCalled();
    if(kind==='oversized'){expect(cancel).toHaveBeenCalledOnce();expect(json).not.toHaveBeenCalled();}
  });
  it('historical original registration replays before current gross, pricing or prior-proof validation',async()=>{
    const s=setup();expect((await registerWatch(s.input)).status).toBe(201);const originals=[...s.bucket.values];s.analytics.mockClear();
    Object.assign(s.env,{RETENTION_POLICY_JSON:'invalid',WATCH_BASE_PRICE_USD:'9'});
    const replay=await registerWatch({...s.input,grossPaidUsd:0});expect(replay.status).toBe(200);expect(replay.body.prepaid_check_price_usd).toBe(1);
    expect([...s.bucket.values]).toEqual(originals);expect(s.analytics).not.toHaveBeenCalled();expect(s.env.BROWSER.quickAction).not.toHaveBeenCalled();
  });
});
