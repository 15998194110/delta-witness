import type { RuntimeEnv } from './env';
import { sha256, stableJson, uuidFromDigest } from './crypto';
import { commitClaim } from './claims';
import { withinDeadline } from './deadline';
import { createOrderReadSnapshot } from './order-storage';
import { fulfillmentRecordKey, paidRequestHash, parseCaptureRequest, parsePreflightRequest, readFulfillment,
  verifiedDelivery, type DeliveryResponse, type FulfillmentRecord, type PaidRequest } from './fulfillment';

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ATTEMPT = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const SCHEMA = 'delta-partner-billing/v1';
type Billing = {
  schema: typeof SCHEMA; identity_digest: string; request_hash: string; product: 'capture' | 'preflight';
  state: 'charge_unknown' | 'platform_charged'; attempt_id: string; reserved_at: string;
  confirmed_at?: string; charged_count?: 1; source: 'partner_adapter_assertion'; event_name: 'proof-created';
};
type BillingFulfillment = FulfillmentRecord & { partner_billing?: Billing };
export type PartnerBillingInput = {
  partner: string; userId: string; businessOrderId: string; product: 'capture' | 'preflight';
  request: unknown; operation: 'status' | 'reserve_charge' | 'confirm_charge'; attemptId?: string;
};
export type PartnerBillingResult = { status: number; body: Record<string, unknown> };

export async function partnerBusinessIdentity(partner: string, userId: string, businessOrderId: string) {
  if (!/^[a-z0-9_-]{1,40}$/.test(partner) || !OPAQUE.test(userId) || !OPAQUE.test(businessOrderId) || businessOrderId.length < 8) throw new Error('invalid_partner_business_identity');
  const identityDigest = await sha256(stableJson({schema:'delta-partner-business/v1',user_id:userId,business_order_id:businessOrderId}));
  const idempotencyKey = `business-v1:${identityDigest.slice(7)}`;
  const fingerprint = await sha256(`partner\n${partner}\n${idempotencyKey}`);
  return {idempotencyKey,fingerprint,key:fulfillmentRecordKey(fingerprint),identityDigest};
}

function billingOf(record: BillingFulfillment, identityDigest: string, requestHash: string, product: string): Billing | undefined {
  const value = record.partner_billing;
  if (value === undefined) return undefined;
  if (!value || value.schema !== SCHEMA || value.identity_digest !== identityDigest || value.request_hash !== requestHash || value.product !== product ||
      !['charge_unknown','platform_charged'].includes(value.state) || !ATTEMPT.test(value.attempt_id) ||
      value.source !== 'partner_adapter_assertion' || value.event_name !== 'proof-created' ||
      !Number.isFinite(Date.parse(value.reserved_at)) ||
      (value.state === 'platform_charged' && (value.charged_count !== 1 || !value.confirmed_at || !Number.isFinite(Date.parse(value.confirmed_at)))) ||
      (value.state === 'charge_unknown' && (value.charged_count !== undefined || value.confirmed_at !== undefined))) throw new Error('partner_billing_evidence_invalid');
  return value;
}

// Uses the original fulfillment's CAS; it never creates an independent payment
// ledger, capture implementation, reset path, or permission inferred from time.
export async function coordinatePartnerBilling(env: RuntimeEnv, input: PartnerBillingInput): Promise<PartnerBillingResult> {
  if ((env as RuntimeEnv & {PARTNER_BILLING_COORDINATION_ENABLED?: string}).PARTNER_BILLING_COORDINATION_ENABLED !== 'true') {
    return {status:503,body:{ok:false,error:'partner_billing_not_enabled',may_charge:false}};
  }
  let identity: Awaited<ReturnType<typeof partnerBusinessIdentity>>, body: PaidRequest, requestHash: string;
  try {
    identity = await partnerBusinessIdentity(input.partner,input.userId,input.businessOrderId);
    if (!['capture','preflight'].includes(input.product) || !['status','reserve_charge','confirm_charge'].includes(input.operation) ||
        (input.operation === 'status' ? input.attemptId !== undefined : typeof input.attemptId !== 'string' || !ATTEMPT.test(input.attemptId))) throw new Error();
    body = input.product === 'capture' ? parseCaptureRequest(input.request) : parsePreflightRequest(input.request);
    requestHash = await paidRequestHash(`/partner/${input.product}`,body);
  } catch { return {status:400,body:{ok:false,error:'invalid_partner_billing_request',may_charge:false}}; }
  const result = (status: number, state: string, billing?: Billing, delivery?: DeliveryResponse, mayCharge=false): PartnerBillingResult => ({status,body:{
    ok:status===200,schema:SCHEMA,business_order_id:input.businessOrderId,product:input.product,state,may_charge:mayCharge,
    billing:{state:billing?.state ?? (status>=409?'unknown':'unreserved'),event_name:'proof-created',
      platform_charged:billing?.state==='platform_charged' ? true : billing || status>=409 ? null : false,
      assurance:'partner_adapter_assertion_only',settlement_confirmed:null,treasury_received:null,net_payout_usd:null,revenue_usd:null},
    ...(delivery ? {delivery} : {}),...(mayCharge ? {attempt_id:input.attemptId} : {}),
  }});
  const snapshot = createOrderReadSnapshot(env), bounded = snapshot.env;
  snapshot.allowArtifactsFor(uuidFromDigest(await sha256(`${identity.fingerprint}\n${input.product}`)));
  try {
    return await withinDeadline((async()=>{
      const stored = await readFulfillment(bounded,identity.key);
      if (!stored) return result(404,'order_not_found');
      const record = stored.record as BillingFulfillment;
      if (record.partner !== input.partner || record.fulfillment_fingerprint !== identity.fingerprint || record.route !== `/partner/${input.product}` ||
          record.request_hash !== requestHash || record.requested_url !== body.url || record.payment_fingerprint !== undefined) return result(409,'order_identity_conflict');
      const billing = billingOf(record,identity.identityDigest,requestHash,input.product);
      if (record.state !== 'complete') return result(202,'delivery_unconfirmed',billing);
      // No hashless historical record can newly grant a charging permit.
      if (!record.response_hash || !HASH.test(record.response_hash)) throw new Error('original_delivery_digest_missing');
      const delivery = await verifiedDelivery(bounded,stored,body,input.product,identity.fingerprint);
      if (!delivery) throw new Error('original_delivery_unconfirmed');
      snapshot.assertActive();
      if (input.operation === 'status') return result(200,'complete',billing,delivery);
      if (input.operation === 'reserve_charge') {
        if (billing) return result(200,'complete',billing,delivery);
        const next: Billing = {schema:SCHEMA,identity_digest:identity.identityDigest,request_hash:requestHash,product:input.product,
          state:'charge_unknown',attempt_id:input.attemptId!,reserved_at:new Date().toISOString(),source:'partner_adapter_assertion',event_name:'proof-created'};
        // The durable state is UNKNOWN before permitting the caller's one SDK
        // charge call. A lost put/response cannot grant this permission again.
        const saved = await commitClaim<BillingFulfillment>(bounded,identity.key,stored,{...record,partner_billing:next});
        snapshot.assertActive();
        if (!saved) return result(409,'billing_reservation_unconfirmed');
        return result(200,'complete',next,delivery,true);
      }
      if (!billing || billing.attempt_id !== input.attemptId) return result(409,'billing_attempt_conflict',billing,delivery);
      if (billing.state === 'platform_charged') return result(200,'complete',billing,delivery);
      const next: Billing = {...billing,state:'platform_charged',charged_count:1,confirmed_at:new Date().toISOString()};
      const saved = await commitClaim<BillingFulfillment>(bounded,identity.key,stored,{...record,partner_billing:next});
      snapshot.assertActive();
      return saved ? result(200,'complete',next,delivery) : result(409,'billing_confirmation_unconfirmed',billing,delivery);
    })(),15_000,'partner_billing_deadline',snapshot.cancel);
  } catch { return result(503,'billing_outcome_unconfirmed'); }
  finally { snapshot.cancel(); }
}
