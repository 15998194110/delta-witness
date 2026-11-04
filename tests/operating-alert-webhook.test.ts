import {expect,it} from 'vitest';
import {verifyResendWebhookSignature} from '../src/operating-alert-webhook';
it('matches the published Svix manual-verification vector without reserializing payload',async()=>{
  const bytes=new TextEncoder().encode('{"event_type":"ping","data":{"success":true}}');
  const headers=new Headers({'svix-id':'msg_loFOjxBNrRLzqYUf','svix-timestamp':'1731705121','svix-signature':'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0='});
  const publicExample='whsec_plJ3nmyCDGBKInavdOK15jsl',clock=1731705121000;
  expect(await verifyResendWebhookSignature(bytes,headers,publicExample,clock)).toBe(true);
  expect(await verifyResendWebhookSignature(new TextEncoder().encode('{ "event_type":"ping","data":{"success":true}}'),headers,publicExample,clock)).toBe(false);
  expect(await verifyResendWebhookSignature(bytes,headers,publicExample,clock+301000)).toBe(false);
  headers.set('svix-signature',`v1,${btoa('0'.repeat(32))} ${headers.get('svix-signature')}`);
  expect(await verifyResendWebhookSignature(bytes,headers,publicExample,clock)).toBe(true);
});
