// A view of the original obligation, not a new payment/refund/fulfillment grant.
// The caller must have authenticated the original order and verified settlement.
export type RemediationReason = 'original_evidence_unverified' | 'original_delivery_pending' |
  'original_delivery_failed' | 'raw_artifacts_expired' | 'order_revoked';

export function orderRemediation(reason: RemediationReason, recordedComplete = false) {
  return {
    schema: 'delta-order-remediation/v1',
    state: reason === 'original_delivery_pending' ? 'pending_original_delivery' : 'needs_intervention',
    reason,
    obligation: recordedComplete ? 'original_delivery_integrity_requires_review' : 'original_paid_delivery_unresolved',
    responsible_party: 'delta_operator',
    // An absent/corrupt/unavailable read does not prove permanent destruction.
    historical_evidence_loss_confirmed: null,
    next_action: reason === 'original_delivery_pending' ? 'recheck_original_order' : 'review_original_evidence_and_remedy',
    original_recovery: 'only_exact_original_bytes_and_original_binding_checks',
    replacement_observation: { authorized: false, required: 'explicit_buyer_acceptance_and_new_true_observation_time' },
    refund: { authorized: false, required: 'separate_owner_authorization_and_original_payment_reconciliation' },
    additional_payment_required: false,
    // This view cannot settle historical financial recognition either way.
    customer_revenue_recognized: null,
  } as const;
}
