import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import currentWorker, { app } from '../src/index';
import { hmacSha256, sha256, stableJson } from '../src/crypto';
import { parseWatchRegistration, registerWatch, type WatchNotification, type WatchRecord } from '../src/watch';
import { MemoryBucket, mockOrderNetwork, orderRequest, orderRuntime } from './helpers/order-runtime';

// Opt-in exact locally reviewed artifact, not a caller-supplied unverified module.
const evidencePath = process.env.DELTA_FALLBACK_BUILD_EVIDENCE;
const reviewedCommit = process.env.DELTA_FALLBACK_REVIEWED_COMMIT ?? '0a7ef80cf210263ced2ba197c8461535c1ac350b';
let fallback: typeof app, fallbackWorker: typeof currentWorker;
async function verifiedModule(path: string, commit: string) {
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(commit) || evidence.commit !== commit ||
      evidence.schema !== 'delta-isolated-fallback-build/v1' || evidence.platform !== 'node' ||
      !Array.isArray(evidence.source_files) || evidence.source_files.length < 1 || evidence.source_files.length > 500 ||
      !['src/index.ts', 'src/watch.ts', 'src/guarded-pilot.ts'].every(path => evidence.source_files.some((file: {path?: string}) => file.path === path)) ||
      createHash('sha256').update(await readFile(evidence.artifact)).digest('hex') !== evidence.artifact_sha256) throw new Error('unverified_fallback_artifact');
  const module = await import(/* @vite-ignore */ pathToFileURL(evidence.artifact).href);
  if (typeof module.app?.fetch !== 'function' || typeof module.default?.scheduled !== 'function') throw new Error('unsupported_fallback_exports');
  return module as {app: typeof app; default: typeof currentWorker};
}
if (evidencePath) {
  const module = await verifiedModule(evidencePath, reviewedCommit);
  fallback = module.app; fallbackWorker = module.default;
}
// An additional immutable historical binary creates real old-version records.
// It is deliberately not used for new Watch work or qualified as a fallback.
const historicalPath = process.env.DELTA_FALLBACK_HISTORICAL_EVIDENCE;
const historical = historicalPath ? (await verifiedModule(historicalPath, '0a7ef80cf210263ced2ba197c8461535c1ac350b')).app : undefined;
const suite = evidencePath ? describe : describe.skip;
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const original = crypto, subtle = new Proxy(original.subtle, {get(target, name) {
    if (name === 'timingSafeEqual') return (a: ArrayBuffer, b: ArrayBuffer) => Buffer.from(a).equals(Buffer.from(b));
    const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
  }});
  vi.stubGlobal('crypto', {subtle, getRandomValues: original.getRandomValues.bind(original), randomUUID: original.randomUUID.bind(original)});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function artifactHashes(bucket: MemoryBucket) {
  return [...bucket.values].filter(([key]) => /^[0-9a-f-]{36}\//.test(key)).map(([key, value]) =>
    [key, createHash('sha256').update(value.bytes ?? Buffer.from(value.text)).digest('hex')]);
}
class WatchBucket extends MemoryBucket {
  async list(options?: R2ListOptions) {
    return {objects: [...this.values.keys()].filter(key => key.startsWith(options?.prefix ?? '')).map(key => ({key})), truncated: false};
  }
}
// Invoke the handler in memory only. Noon avoids discovery/IndexNow branches;
// waitUntil promises are collected rather than scheduling any external task.
async function tick(worker: typeof currentWorker, env: ReturnType<typeof orderRuntime>, expected: 'success'|'degraded'|'competing' = 'success') {
  const work: Promise<unknown>[] = [];
  await worker.scheduled({cron: '*/15 * * * *', scheduledTime: Date.parse('2026-11-02T12:00:00Z')} as ScheduledController,
    env, {waitUntil(promise: Promise<unknown>) {work.push(promise);}} as ExecutionContext);
  if(expected==='degraded'){
    // The new observer must expose the known injected failure. The original
    // quota/event/artifact assertions below still establish business recovery.
    await expect(Promise.all(work)).rejects.toThrow('scheduled_operations_degraded');
  }else if(expected==='competing'){
    // A real concurrent CAS loser may observe either delivered or deferred.
    // Only that exact new observation error is allowed; other errors fail.
    const results=await Promise.allSettled(work);expect(results).toHaveLength(1);
    for(const result of results)if(result.status==='rejected')expect(result.reason).toMatchObject({message:'scheduled_operations_degraded'});
  }else await Promise.all(work);
}
async function watchFixture(checks = 1, missingMetric = false) {
  vi.useFakeTimers(); vi.setSystemTime('2026-11-02T12:00:00Z');
  const bucket = new WatchBucket(), env = orderRuntime(bucket), requests: Request[] = [];
  let webhookStatus = 503;
  const network = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.hostname === 'cloudflare-dns.com') return Response.json(url.searchParams.get('type') === 'A' ? {Status: 0, Answer: [{type: 1, data: '93.184.216.34'}]} : {Status: 0, Answer: []});
    if (url.hostname === 'example.com') return new Response('', {status: 200});
    if (url.hostname === 'webhook.test') {requests.push(request.clone()); return new Response(null, {status: webhookStatus});}
    throw new Error('unmocked_network');
  });
  vi.stubGlobal('fetch', network);
  if (missingMetric) {
    const browser = vi.mocked(env.BROWSER.quickAction), original = browser.getMockImplementation()!;
    browser.mockImplementation(async (...args) => {const response = await original(...args); return new Response(response.body);});
  }
  const request = await parseWatchRegistration({url: 'https://example.com/', checks, interval_seconds: 900,
    webhook_url: 'https://webhook.test/events', expected: {contains: ['absent condition']}});
  const registered = await registerWatch({env, request, requestHash: 'sha256:product-fallback-watch', fingerprint: 'sha256:product-fallback-watch', partner: 'fixture', channel: 'fixture', grossPaidUsd: checks});
  const key = `watches/${registered.body.watch_id}.json`;
  const readWatch = () => JSON.parse(bucket.values.get(key)!.text) as WatchRecord;
  vi.setSystemTime(Date.parse(readWatch().next_check_at) + 1);
  const events = () => [...bucket.values].filter(([key]) => key.startsWith('watch-notifications/')).map(([key, value]) => ({key, event: JSON.parse(value.text) as WatchNotification}));
  return {bucket, env, requests, network, key, readWatch, events, secret: String(registered.body.webhook_secret),
    webhookStatus(status: number) {webhookStatus = status;}};
}
function pilotFixture(count = 2, missingMetric = false, settle?: () => Promise<Response>) {
  const bucket = new MemoryBucket(), env = orderRuntime(bucket), network = mockOrderNetwork(settle);
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => String(url).startsWith('https://example.com/') ? new Response('', {status: 200}) : network(url)));
  const browser = vi.mocked(env.BROWSER.quickAction), original = browser.getMockImplementation()!;
  browser.mockImplementation(async (...args) => {
    const response = await original(...args), snapshot = await response.json() as any;
    snapshot.meta.finalUrl = (args[1] as any).url;
    return Response.json(snapshot, {headers: missingMetric ? {} : {'x-browser-ms-used': '1'}});
  });
  const body = {urls: Array.from({length: count}, (_, index) => `https://example.com/page${index + 1}`), preflight: {url_index: 0, expected: {contains: ['absent condition']}}};
  const request = () => orderRequest({product: 'guarded-action-pilot', legacy: true, body});
  const key = () => [...bucket.values.keys()].find(key => key.startsWith('guarded-pilot/'))!;
  const record = () => JSON.parse(bucket.values.get(key())!.text);
  return {bucket, env, network, browser, body, request, key, record};
}
function registrationFixture() {
  vi.useFakeTimers(); vi.setSystemTime('2026-11-02T12:00:00Z');
  const bucket = new WatchBucket(), env = Object.assign(orderRuntime(bucket), {PARTNER_GATEWAY_SECRET: 'synthetic-internal-secret'});
  const network = mockOrderNetwork(); vi.stubGlobal('fetch', network);
  const request = () => new Request('https://delta.test/internal/partner/watch', {method: 'POST', headers: {
    'content-type': 'application/json', 'x-delta-core-secret': 'synthetic-internal-secret', 'x-delta-partner': 'fixture',
    'idempotency-key': 'watch-registration-001', 'x-delta-gross-usd': '1',
  }, body: JSON.stringify({url: 'https://example.com/', checks: 1, interval_seconds: 900})});
  return {bucket, env, network, request};
}

suite('mixed-runtime Watch and Pilot original-authority compatibility', () => {
  it('current Watch retries one original notification in fallback, then current consumes only the next prepaid slot', async () => {
    const s = await watchFixture(2);
    await tick(currentWorker, s.env, 'degraded');
    const first = s.events()[0].event, originalWatch = s.readWatch(), originalHashes = artifactHashes(s.bucket);
    expect(JSON.parse(first.raw_body)).toMatchObject({safe: false, changed: null});
    s.webhookStatus(204); vi.setSystemTime(Date.parse(first.next_attempt_at) + 1);
    await Promise.all([tick(fallbackWorker, s.env), tick(currentWorker, s.env, 'competing')]);
    expect(s.events()[0].event).toMatchObject({event_id: first.event_id, raw_body: first.raw_body, attempts: 2, state: 'delivered'});
    expect(s.readWatch()).toEqual(originalWatch); expect(artifactHashes(s.bucket)).toEqual(originalHashes);
    expect(s.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
    for (const request of s.requests) {
      const raw = await request.text();
      expect(raw).toBe(first.raw_body);
      expect(request.headers.get('x-delta-signature')).toBe(`sha256=${await hmacSha256(s.secret, `${request.headers.get('x-delta-timestamp')}.${raw}`)}`);
    }
    vi.setSystemTime(Date.parse(s.readWatch().next_check_at) + 1);
    await tick(currentWorker, s.env); await tick(fallbackWorker, s.env);
    expect(s.readWatch()).toMatchObject({checks_attempted: 2, checks_remaining: 0, state: 'exhausted'});
    expect(s.events()).toHaveLength(2); expect(s.env.BROWSER.quickAction).toHaveBeenCalledTimes(2);
    for (const [key, hash] of originalHashes) expect(artifactHashes(s.bucket)).toContainEqual([key, hash]);
  });
  it('fallback new Watch preserves missing browser usage as unknown and current restores the same event without recapture', async () => {
    const s = await watchFixture(1, true);
    await tick(fallbackWorker, s.env);
    const original = s.events()[0].event, hashes = artifactHashes(s.bucket);
    const manifest = JSON.parse([...s.bucket.values].find(([key]) => key.endsWith('/manifest.json'))![1].text);
    expect(manifest.execution.browser_ms_used).toBeNull();
    expect(manifest.execution.estimated_variable_cost_usd).toBeGreaterThan(0);
    s.webhookStatus(204); vi.setSystemTime(Date.parse(original.next_attempt_at) + 1);
    await tick(currentWorker, s.env, 'degraded'); await tick(fallbackWorker, s.env);
    expect(s.events()[0].event).toMatchObject({event_id: original.event_id, raw_body: original.raw_body, state: 'delivered'});
    expect(artifactHashes(s.bucket)).toEqual(hashes); expect(s.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
    expect(s.readWatch()).toMatchObject({checks_attempted: 1, checks_remaining: 0});
  });
  it('fallback promotes an interrupted current Watch outbox from its original committed check', async () => {
    const s = await watchFixture(), put = s.bucket.put.bind(s.bucket);
    let fail = true;
    s.bucket.put = async (key, value, options) => {if (fail && key.startsWith('watch-notifications/')) throw new Error('synthetic promotion loss'); return put(key, value, options);};
    await tick(currentWorker, s.env, 'degraded');
    const pending = s.readWatch().pending_notification!, hashes = artifactHashes(s.bucket);
    expect(pending).toBeDefined(); expect(s.requests).toHaveLength(0);
    fail = false; s.webhookStatus(204);
    await tick(fallbackWorker, s.env); await tick(currentWorker, s.env);
    expect(s.events()[0].event).toMatchObject({event_id: pending.event_id, raw_body: pending.raw_body, state: 'delivered'});
    expect(s.readWatch()).toMatchObject({checks_attempted: 1, checks_remaining: 0});
    expect(artifactHashes(s.bucket)).toEqual(hashes); expect(s.env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  });
  it('fallback bounds a hung Watch inventory while original notification dispatch still completes', async () => {
    const s = await watchFixture(); await tick(currentWorker, s.env, 'degraded');
    const first = s.events()[0].event, list = s.bucket.list.bind(s.bucket);
    s.webhookStatus(204); vi.setSystemTime(Date.parse(first.next_attempt_at) + 1);
    let release!: () => void, reached = false, finished = false, outcome: unknown;
    s.bucket.list = async options => options?.prefix === 'watches/' ? new Promise(resolve => {reached = true; release = () => {void list(options).then(resolve);};}) : list(options);
    const running = tick(fallbackWorker, s.env).then(() => {finished = true;}, error => {finished = true; outcome = error;});
    await vi.waitFor(() => expect(reached).toBe(true));
    // Let the independent successful notification finish before advancing the
    // inventory deadline; WebCrypto itself is not controlled by fake timers.
    await vi.waitFor(() => expect(s.events()[0].event.state).toBe('delivered'));
    await vi.advanceTimersByTimeAsync(20_001);
    let bounded = false;
    try {await vi.waitFor(() => expect(finished).toBe(true), {timeout: 500, interval: 5}); bounded = true;} catch { /* release the synthetic hung source before reporting failure */ }
    release(); await running;
    expect(bounded).toBe(true); expect((outcome as Error).message).toBe('notification_operation_timeout');
    expect(s.events()[0].event).toMatchObject({event_id: first.event_id, state: 'delivered', attempts: 2});
    s.bucket.list = list; await tick(currentWorker, s.env);
    expect(s.env.BROWSER.quickAction).toHaveBeenCalledTimes(1); expect(s.readWatch()).toMatchObject({checks_attempted: 1, checks_remaining: 0});
  });
  it.each(['lease', 'artifact', 'final'])('fallback fences a late Watch %s write and current retains original quota and evidence', async stage => {
    const s = await watchFixture(), put = s.bucket.put.bind(s.bucket);
    let release!: () => void, reached = false, finished = false;
    s.bucket.put = async (key, value, options) => {
      const row = key === s.key ? JSON.parse(String(value)) : null;
      if (!reached && (stage === 'lease' && row?.lease_until || stage === 'artifact' && key.endsWith('/page.html') || stage === 'final' && row?.checks_attempted === 1)) {
        reached = true; return new Promise(resolve => {release = () => {void put(key, value, options).then(resolve);};});
      }
      return put(key, value, options);
    };
    const running = tick(fallbackWorker, s.env).then(() => {finished = true;});
    await vi.waitFor(() => expect(reached).toBe(true)); await vi.advanceTimersByTimeAsync(50_001);
    const bounded = finished;
    release(); await running; await vi.advanceTimersByTimeAsync(1);
    expect(bounded).toBe(true); expect(s.requests).toHaveLength(0);
    const hashes = artifactHashes(s.bucket); s.webhookStatus(204);
    if (stage !== 'final') vi.setSystemTime(Date.now() + 60_001);
    await tick(currentWorker, s.env, stage==='final'?'success':'degraded'); await tick(fallbackWorker, s.env);
    expect(s.env.BROWSER.quickAction).toHaveBeenCalledTimes(stage === 'lease' ? 0 : 1);
    expect(artifactHashes(s.bucket)).toEqual(hashes);
    expect(s.readWatch()).toMatchObject(stage === 'final' ? {checks_attempted: 1, checks_remaining: 0} : {state: 'recovery_required', checks_attempted: 0, checks_remaining: 1});
    if (stage === 'final') expect(s.events()[0].event.state).toBe('delivered');
  });
  it.each(['get', 'body'])('fallback bounds existing Watch registration %s before current retrieves the same prepaid record', async stage => {
    const s = registrationFixture(); expect((await app.fetch(s.request(), s.env)).status).toBe(201);
    const originals = [...s.bucket.values], key = originals.find(([key]) => key.startsWith('watches/'))![0];
    const read = s.bucket.get.bind(s.bucket), stored = (await read(key))!, cancel = vi.fn();
    let reached = false, release!: () => void, finished = false;
    s.bucket.get = async name => {
      if (name !== key) return read(name); reached = true;
      const object = {...stored, body: new ReadableStream<Uint8Array>({cancel})};
      if (stage === 'get') return new Promise(resolve => {release = () => resolve(object);});
      return object;
    };
    const running = Promise.resolve(fallback.fetch(s.request(), s.env)).then(response => {finished = true; return response;});
    await vi.waitFor(() => expect(reached).toBe(true)); await vi.advanceTimersByTimeAsync(20_001);
    const bounded = finished;
    if (stage === 'get') release();
    const response = await running;
    expect(bounded).toBe(true); expect(response.status).toBe(503);
    s.bucket.get = read;
    const recovered = await app.fetch(s.request(), s.env); expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({checks_purchased: 1, checks_remaining: 1, checks_attempted: 0, idempotent_replay: true});
    expect([...s.bucket.values]).toEqual(originals); expect(s.env.BROWSER.quickAction).not.toHaveBeenCalled(); expect(s.network).not.toHaveBeenCalled();
  });
  it('fallback registration late conditional write remains one original prepaid record for current retry', async () => {
    const s = registrationFixture(), put = s.bucket.put.bind(s.bucket);
    let release!: () => void, reached = false, finished = false;
    s.bucket.put = async (key, value, options) => {
      if (!reached && key.startsWith('watches/')) {reached = true; return new Promise(resolve => {release = () => {void put(key, value, options).then(resolve);};});}
      return put(key, value, options);
    };
    const running = Promise.resolve(fallback.fetch(s.request(), s.env)).then(response => {finished = true; return response;});
    await vi.waitFor(() => expect(reached).toBe(true)); await vi.advanceTimersByTimeAsync(20_001);
    const bounded = finished; release(); const response = await running; await vi.advanceTimersByTimeAsync(1);
    expect(bounded).toBe(true); expect(response.status).toBe(503);
    const originals = [...s.bucket.values];
    const recovered = await app.fetch(s.request(), s.env); expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({checks_purchased: 1, checks_remaining: 1, checks_attempted: 0, idempotent_replay: true});
    expect([...s.bucket.values]).toEqual(originals); expect(originals.filter(([key]) => key.startsWith('watches/'))).toHaveLength(1);
    expect(s.env.BROWSER.quickAction).not.toHaveBeenCalled(); expect(s.network).not.toHaveBeenCalled();
  });
  it.each([false, true])('completed negative Pilot replays byte-consistent original response across fallback (missing metric=%s)', async missingMetric => {
    const s = pilotFixture(2, missingMetric);
    const first = await app.fetch(s.request(), s.env); expect(first.status).toBe(200);
    const response = await first.json(), originals = [...s.bucket.values];
    for (const runtime of [fallback, app]) {
      const replay = await runtime.fetch(s.request(), s.env);
      expect(replay.status).toBe(200); expect(await replay.json()).toEqual({...response as object, idempotent_replay: true});
    }
    expect([...s.bucket.values]).toEqual(originals); expect(s.browser).toHaveBeenCalledTimes(2);
    expect(s.network.mock.calls.filter(([url]) => String(url).endsWith('/settle'))).toHaveLength(1);
  });
  it('partial Pilot fallback resumes only page two; returning current retains page one negative observation and bytes', async () => {
    const s = pilotFixture(2, true), browser = s.browser.getMockImplementation()!; let calls = 0;
    s.browser.mockImplementation(async (...args) => ++calls === 2 ? new Response('', {status: 503}) : browser(...args));
    expect((await app.fetch(s.request(), s.env)).status).toBe(502);
    const page = s.record().progress.pages[0], hashes = artifactHashes(s.bucket);
    expect(page.observation.browser_ms).toBeNull(); expect(page.observation.preflight.safe).toBe(false);
    const resumed = await fallback.fetch(s.request(), s.env); expect(resumed.status).toBe(200);
    const response = await resumed.json(); expect(response).toMatchObject({preflight: {safe: false}});
    const replay = await app.fetch(s.request(), s.env); expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({...response as object, idempotent_replay: true});
    expect(s.record().progress.pages[0]).toEqual(page);
    for (const entry of hashes) expect(artifactHashes(s.bucket)).toContainEqual(entry);
    expect(s.browser.mock.calls.map(call => (call[1] as any).url)).toEqual([s.body.urls[0], s.body.urls[1], s.body.urls[1]]);
    expect(s.network.mock.calls.filter(([url]) => String(url).endsWith('/settle'))).toHaveLength(1);
  });
  it('Pilot observed page draft reconciles in fallback and current never repeats that observation', async () => {
    const s = pilotFixture(), put = s.bucket.put.bind(s.bucket); let failed = false;
    s.bucket.put = async (key, value, options) => {
      if (!failed && key.startsWith('guarded-pilot/') && JSON.parse(String(value)).progress?.pages[0].phase === 'complete') {failed = true; throw new Error('synthetic checkpoint loss');}
      return put(key, value, options);
    };
    expect((await app.fetch(s.request(), s.env)).status).toBe(503);
    const hashes = artifactHashes(s.bucket), page = s.record().progress.pages[0];
    expect(page.phase).toBe('observed');
    // Only advance time; never erase the original lease or draft to allow retry.
    vi.useFakeTimers({toFake: ['Date']}); vi.setSystemTime(Date.now() + 90_001);
    const recovered = await fallback.fetch(s.request(), s.env); expect(recovered.status).toBe(200);
    expect((await app.fetch(s.request(), s.env)).status).toBe(200);
    expect(s.record().progress.pages[0]).toEqual({...page, phase: 'complete'});
    for (const entry of hashes) expect(artifactHashes(s.bucket)).toContainEqual(entry);
    expect(s.browser.mock.calls.map(call => (call[1] as any).url)).toEqual(s.body.urls);
    expect(s.network.mock.calls.filter(([url]) => String(url).endsWith('/settle'))).toHaveLength(1);
  });
  it('unknown Pilot page outcome remains unknown across fallback and current without replacement work', async () => {
    const s = pilotFixture(), browser = s.browser.getMockImplementation()!; let calls = 0;
    s.browser.mockImplementation(async (...args) => {if (++calls === 2) throw new Error('synthetic unknown browser outcome'); return browser(...args);});
    expect((await app.fetch(s.request(), s.env)).status).toBe(503);
    const originals = [...s.bucket.values];
    for (const runtime of [fallback, app]) expect((await runtime.fetch(s.request(), s.env)).status).toBe(503);
    expect([...s.bucket.values]).toEqual(originals); expect(s.browser).toHaveBeenCalledTimes(2);
    expect(s.record().progress.pages.map((page: any) => page.phase)).toEqual(['complete', 'unknown']);
    expect(s.network.mock.calls.filter(([url]) => String(url).endsWith('/settle'))).toHaveLength(1);
  });
  it('unknown Pilot settlement remains original unknown through fallback and resume with no Browser call', async () => {
    const settle = vi.fn(async () => {throw new Error('synthetic ACK loss');}), s = pilotFixture(2, false, settle);
    await app.fetch(s.request(), s.env); expect(settle).toHaveBeenCalledTimes(1);
    const originals = [...s.bucket.values];
    for (const runtime of [fallback, app]) {
      const response = await runtime.fetch(s.request(), s.env); expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({state: 'settlement_unknown', retryable: false});
    }
    expect([...s.bucket.values]).toEqual(originals); expect(settle).toHaveBeenCalledTimes(1); expect(s.browser).not.toHaveBeenCalled();
  });
  it.each([false, true])('historical Pilot response without optional economics basis survives (draft=%s)', async draft => {
    const s = pilotFixture(1); expect((await app.fetch(s.request(), s.env)).status).toBe(200);
    // Assemble an explicitly synthetic, self-consistent historical fixture
    // before the compatibility boundary; never edit a real evidence artifact.
    const historical = s.record(); delete historical.response.economics.basis;
    historical.response_hash = await sha256(`delta-pilot-response/v1\n${stableJson({request_hash: historical.request_hash,
      payment_fingerprint: historical.payment_fingerprint, response: historical.response})}`);
    if (draft) historical.state = 'processing';
    await s.bucket.put(s.key(), JSON.stringify(historical));
    const hashes = artifactHashes(s.bucket);
    for (const runtime of [app, fallback, app]) {
      const replay = await runtime.fetch(s.request(), s.env); expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({...historical.response, idempotent_replay: true});
      expect(s.record().response).toEqual(historical.response); expect(s.record().response_hash).toBe(historical.response_hash);
    }
    expect(artifactHashes(s.bucket)).toEqual(hashes); expect(s.browser).toHaveBeenCalledTimes(1);
    expect(s.network.mock.calls.filter(([url]) => String(url).endsWith('/settle'))).toHaveLength(1);
  });
  (historical ? it : it.skip).each([false, true])('actual old-runtime Pilot survives current/candidate/current (interrupted final write=%s)', async draft => {
    const s = pilotFixture(), put = s.bucket.put.bind(s.bucket); let failed = false;
    s.bucket.put = async (key, value, options) => {
      if (draft && !failed && key.startsWith('guarded-pilot/') && JSON.parse(String(value)).state === 'complete') {failed = true; throw new Error('synthetic historical final write loss');}
      return put(key, value, options);
    };
    expect((await historical!.fetch(s.request(), s.env)).status).toBe(draft ? 503 : 200);
    const original = s.record(), hashes = artifactHashes(s.bucket);
    expect(original.response.economics).not.toHaveProperty('basis'); expect(original.response.preflight.safe).toBe(false);
    for (const runtime of [app, fallback, app]) {
      const replay = await runtime.fetch(s.request(), s.env); expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({...original.response, idempotent_replay: true});
      expect(s.record().response).toEqual(original.response); expect(s.record().response_hash).toBe(original.response_hash);
    }
    expect(artifactHashes(s.bucket)).toEqual(hashes); expect(s.browser).toHaveBeenCalledTimes(2);
    expect(s.network.mock.calls.filter(([url]) => String(url).endsWith('/settle'))).toHaveLength(1);
  });
});
