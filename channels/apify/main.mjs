import { Actor } from "apify";

function stableInput(value) {
  if (Array.isArray(value)) return value.map(stableInput);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stableInput(value[key])]));
  return value;
}

function completedDelivery(status, result, product) {
  if (status !== 200 || !result || result.ok !== true || result.product !== product) return false;
  const id = result.proof_id;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return false;
  const origin = 'https://delta-witness-api.ruphussten.workers.dev';
  if (result.public_proof_url !== `${origin}/p/${id}` || result.manifest_url !== `${origin}/v1/proofs/${id}`) return false;
  if (!/^sha256:[0-9a-f]{64}$/i.test(result.bundle_root) || typeof result.observed_at !== 'string' || !Number.isFinite(Date.parse(result.observed_at))) return false;
  if ((result.reason !== undefined && typeof result.reason !== 'string') ||
      (result.idempotent_replay !== undefined && typeof result.idempotent_replay !== 'boolean')) return false;
  return product !== 'preflight' || ([true, false, null].includes(result.safe) && [true, false, null].includes(result.changed));
}

function safeDelivery(result) {
  const clean=Object.fromEntries(['ok','product','proof_id','public_proof_url','manifest_url','bundle_root','observed_at',
    'safe','changed','reason','idempotent_replay'].filter(key=>result[key]!==undefined).map(key=>[key,result[key]]));
  if(result.diff && typeof result.diff==='object' && !Array.isArray(result.diff)) {
    const diff=result.diff, cleanDiff={};
    if(typeof diff.prior_proof_id==='string' && /^[0-9a-f-]{36}$/i.test(diff.prior_proof_id))cleanDiff.prior_proof_id=diff.prior_proof_id;
    for(const name of ['missing_text','excluded_text_found']) {
      if(Array.isArray(diff[name]) && diff[name].length<=10 && diff[name].every(value=>typeof value==='string' && value.length<=200))cleanDiff[name]=diff[name];
    }
    if(Array.isArray(diff.hash_changes) && diff.hash_changes.length<=2 && diff.hash_changes.every(change=>
      change && ['html','markdown'].includes(change.field) && ['expected','observed'].every(name=>typeof change[name]==='string' && /^sha256:[0-9a-f]{64}$/i.test(change[name])))) {
      cleanDiff.hash_changes=diff.hash_changes.map(({field,expected,observed})=>({field,expected,observed}));
    }
    clean.diff=cleanDiff;
  }
  return clean;
}

async function gatewayResponse(url, init) {
  const controller = new AbortController();
  let reader;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('gateway_deadline_exceeded'));
      controller.abort();
      void reader?.cancel().catch(() => {});
    }, 120_000);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error('gateway_deadline_exceeded'); }
      reader = response.body?.getReader();
      if (!reader) return response;
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) throw new Error('gateway_deadline_exceeded');
          if (done) break;
          size += value.byteLength;
          if (size > 1_048_576) { void reader.cancel().catch(() => {}); throw new Error('gateway_response_too_large'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return new Response(bytes, { status: response.status, headers: response.headers });
    })()]);
  } finally { clearTimeout(timer); }
}

function assertBudget() {
  if (!Actor.isAtHome()) throw new Error('Platform pricing is required before purchase');
  const charging = Actor.getChargingManager(), pricing = charging.getPricingInfo();
  const eventPrice = Number(pricing.perEventPrices['proof-created']);
  const minimumGross = Number(process.env.DELTA_MIN_GROSS_EVENT_USD || '1');
  const datasetPrice = Number(pricing.perEventPrices['apify-default-dataset-item'] ?? 0);
  const chargeable = charging.calculateMaxEventChargeCountWithinLimit('proof-created');
  if (!Number.isFinite(minimumGross) || minimumGross < 1 || !pricing.isPayPerEvent || !Number.isFinite(eventPrice) ||
      eventPrice < minimumGross || !Number.isFinite(datasetPrice) || datasetPrice !== 0 ||
      typeof chargeable !== 'number' || !(chargeable >= 1)) throw new Error('PPE price or available budget is not authorized');
}

function billingResult(status, result, product, businessOrderId, operation, attemptId) {
  if (!result || result.schema !== 'delta-partner-billing/v1' || result.business_order_id !== businessOrderId || result.product !== product ||
      typeof result.may_charge !== 'boolean' || !result.billing || result.billing.event_name !== 'proof-created' ||
      result.billing.assurance !== 'partner_adapter_assertion_only' ||
      ['settlement_confirmed','treasury_received','net_payout_usd','revenue_usd'].some(key=>result.billing[key] !== null)) throw new Error('Invalid coordinator response');
  const state = result.billing.state;
  if (!['unreserved','charge_unknown','platform_charged'].includes(state) ||
      result.billing.platform_charged !== (state==='platform_charged' ? true : state==='charge_unknown' ? null : false) ||
      (result.may_charge && (operation!=='reserve_charge' || state!=='charge_unknown' || result.attempt_id!==attemptId))) throw new Error('Invalid charge permission');
  if (status===404 && operation==='status' && result.state==='order_not_found' && !result.may_charge && state==='unreserved') return result;
  if (status!==200 || result.state!=='complete' || !completedDelivery(200,result.delivery,product)) throw new Error('Original delivery unconfirmed');
  return {...result,delivery:safeDelivery(result.delivery)};
}

// The SDK has no generic cancellation handle for storage/charging. A timeout
// stops this continuation, never retries the call, and keeps Core's original
// charge_unknown marker when a provider-side effect may still finish later.
async function platformOperation(operation) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('platform_operation_unconfirmed')),30_000);
    })]);
  } finally {clearTimeout(timer);}
}

let exitCode = 1;
let failureCode = 'actor_initialization_unconfirmed';
try {
  await platformOperation(()=>Actor.init());
  failureCode='actor_configuration_invalid';
  const input = (await platformOperation(()=>Actor.getInput())) ?? {}, url = input.url;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Public URL required');
  if (input.product !== undefined && !['capture','preflight'].includes(input.product)) throw new Error('Unsupported product');
  const product = input.product ?? 'preflight';
  const gateway = process.env.DELTA_PARTNER_GATEWAY_URL, secret = process.env.DELTA_PARTNER_SECRET;
  if (!gateway || !secret) throw new Error('Actor is not configured');
  const gatewayUrl = new URL(gateway);
  if (gatewayUrl.protocol!=='https:' || gatewayUrl.username || gatewayUrl.password || gatewayUrl.search || gatewayUrl.hash) throw new Error('Invalid gateway');
  const runId = Actor.getEnv().actorRunId;
  // Preserve uncertain legacy markers. Never reinterpret an old run as a new
  // business order; an already-complete old run may display its existing result.
  const payload = product==='preflight' ? {url,expected:input.expected,prior_proof_id:input.prior_proof_id} : {url};
  const legacyIdentity = JSON.stringify(stableInput({product,payload:{...payload,external_request_id:runId}}));
  failureCode='run_requires_reconciliation';
  const previous = runId ? await platformOperation(()=>Actor.getValue(`DELTA-PROOF-CHARGE-${runId}`)) : null;
  let result;
  if (previous) {
    if (previous.state!=='complete' || previous.requestIdentity!==legacyIdentity || !completedDelivery(200,previous.result,product)) throw new Error('Legacy run unresolved');
    result=safeDelivery(previous.result);
  } else {
    failureCode='business_identity_required';
    const businessOrderId=input.business_order_id, userId=process.env.APIFY_USER_ID;
    if (typeof businessOrderId!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(businessOrderId) ||
        typeof userId!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(userId)) throw new Error('Stable business ID and trusted platform user required');
    const headers={'content-type':'application/json','x-delta-partner-secret':secret,'x-delta-partner-user':userId,'x-delta-partner-plan':'apify-ppe'};
    const base=gateway.replace(/\/$/,''), orderUrl=`${base}/business/${encodeURIComponent(businessOrderId)}/${product}`;
    failureCode='billing_coordination_unavailable';
    const capabilityResponse=await gatewayResponse(`${base}/business/capabilities`,{headers,redirect:'error'});
    const capability=await capabilityResponse.json().catch(()=>null);
    if (capabilityResponse.status!==200 || capability?.schema!=='delta-partner-billing/v1' || capability.enabled!==true ||
        capability.business_order_id_required!==true || capability.trusted_user_id_required!==true ||
        capability.charge_permission!=='one_winning_original_fulfillment_cas' || capability.platform_settlement_verified!==false) throw new Error('Supported coordination required');
    const billing=async(operation,attemptId)=>{
      const response=await gatewayResponse(`${orderUrl}/billing`,{method:'POST',headers,redirect:'error',
        body:JSON.stringify({request:payload,operation,...(attemptId?{attempt_id:attemptId}:{})})});
      return billingResult(response.status,await response.json().catch(()=>null),product,businessOrderId,operation,attemptId);
    };
    let original=await billing('status');
    if (original.state==='order_not_found') {
      failureCode='pricing_not_authorized'; assertBudget();
      failureCode='delivery_unconfirmed';
      const response=await gatewayResponse(orderUrl,{method:'POST',headers,body:JSON.stringify(payload),redirect:'error'});
      result=await response.json().catch(()=>null);
      if (!completedDelivery(response.status,result,product)) throw new Error('Original delivery unconfirmed');
      result=safeDelivery(result);
    } else result=original.delivery;
    failureCode='delivery_storage_unconfirmed';
    await platformOperation(()=>Actor.setValue('OUTPUT',result));
    if (original.billing.state==='charge_unknown') {
      failureCode='charge_outcome_unconfirmed'; throw new Error('Original charge requires platform reconciliation');
    }
    if (original.billing.state!=='platform_charged') {
      failureCode='pricing_not_authorized'; assertBudget();
      const attemptId=crypto.randomUUID();
      failureCode='charge_guard_unconfirmed';
      const permit=await billing('reserve_charge',attemptId);
      if (permit.delivery.proof_id!==result.proof_id || permit.delivery.bundle_root!==result.bundle_root) throw new Error('Original proof changed');
      if (!permit.may_charge) {
        if (permit.billing.state!=='platform_charged') throw new Error('Another attempt owns the charge');
        result=permit.delivery;
      } else {
        // There is no guessed platform idempotency argument. Core's original
        // ETag reservation precedes this one SDK invocation, across every run.
        failureCode='charge_outcome_unconfirmed'; assertBudget();
        const charged=await platformOperation(()=>Actor.charge({eventName:'proof-created',count:1}));
        if (charged.chargedCount!==1) throw new Error('Charge not confirmed');
        const confirmed=await billing('confirm_charge',attemptId);
        if (confirmed.billing.state!=='platform_charged' || confirmed.may_charge) throw new Error('Charge bookkeeping unconfirmed');
        result=confirmed.delivery;
        // Default dataset items must be unpriced (checked above). Recovery only
        // restores OUTPUT and never repeats a possibly accepted dataset append.
        failureCode='delivery_storage_unconfirmed';
        await platformOperation(()=>Actor.pushData(result));
      }
    }
  }
  console.log(JSON.stringify(result,null,2));
  exitCode=0;
} catch {
  throw new Error(`${failureCode}; original business order/run requires reconciliation before recovery`);
} finally {
  try {await platformOperation(()=>Actor.exit({exitCode}));}
  catch {throw new Error('actor_exit_unconfirmed; retain original business order/run for reconciliation');}
}
