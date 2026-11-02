import { afterEach, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { sha256, stableJson } from '../src/crypto';
import { MemoryBucket, orderRuntime, orderRequest, statusRequest, mockOrderNetwork } from './helpers/order-runtime';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([false,true])('refuses fresh Browser work after original settled raw retention expired (headerless=%s)', async headerless => {
  const bucket = new MemoryBucket(), env = orderRuntime(bucket), network = mockOrderNetwork();
  vi.stubGlobal('fetch', network);
  const policy = { schema:'delta-retention-policy/v1',policy_id:'isolated-review-only',classes:{
    raw_artifacts:{start_event:'settlement_confirmed',retain_seconds:60,deletion_window_seconds:60},
    minimal_metadata:{start_event:'settlement_confirmed',retain_seconds:120,deletion_window_seconds:60},
    transaction_audit:{start_event:'settlement_confirmed',retain_seconds:240,deletion_window_seconds:60},
  },export_rights:{raw_artifacts:'authenticated_until_raw_expiry',minimal_metadata:'authenticated_until_metadata_expiry'}};
  env.RETENTION_POLICY_JSON = JSON.stringify(policy);
  const request = async () => {
    const req = orderRequest(); req.headers.set('x-delta-retention-policy-hash',await sha256(stableJson(policy))); return req;
  };
  vi.mocked(env.BROWSER.quickAction).mockResolvedValueOnce(new Response('',{status:503}));
  const original = await app.fetch(await request(),env);
  expect(original.status).toBe(502);
  expect(await original.json()).toMatchObject({retryable:true,payment_will_not_be_charged_again:true});
  vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(Date.now()+61_000);
  expect(await (await app.fetch(statusRequest(),env)).json()).toMatchObject({state:'raw_artifacts_expired'});
  const originalStorage = [...bucket.values].map(([key,value]) => [key,value.text]);
  const replayRequest = await request();
  if (headerless) {
    replayRequest.headers.delete('x-delta-order-id');
    replayRequest.headers.delete('x-delta-recovery-token');
    replayRequest.headers.delete('x-delta-retention-policy-hash');
  }
  const replay = await app.fetch(replayRequest,env);
  expect(replay.status).toBe(410);
  expect(env.BROWSER.quickAction).toHaveBeenCalledTimes(1);
  expect(network.mock.calls.filter(([url])=>String(url).endsWith('/settle'))).toHaveLength(1);
  expect([...bucket.values].map(([key,value]) => [key,value.text])).toEqual(originalStorage);
});
