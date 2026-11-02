import { describe, expect, it } from 'vitest';
import { projectOperatorTransition } from '../scripts/operator-coordination.mjs';

const at = '2026-11-02T00:00:00.000Z';
const prepare = target => ({ transition: 'prepare', action_id: 'new-fixture', target,
  payload_hash: `sha256:${'a'.repeat(64)}`, at });
const original = () => ({ opportunities: [], contact_suppressions: [], distribution_submissions: [],
  revenue_cursor: { through: 100, unknown: true },
  sprint_closure: { status: 'closed_target_missed', new_sprint_acquisition_enabled: false },
  unknown_original_field: { preserve: 'fixture-only' } });

describe('historical operator identity fields, synthetic projection only', () => {
  it.each(['last_sent_message_id', 'superseded_message_id', 'bounce_message_id'])
  ('historical %s prevents a new first contact without rewriting original evidence', field => {
    const document = original();
    document.opportunities.push({ contact: 'Buyer <Buyer@EXAMPLE.test>', [field]: 'synthetic-message-1',
      historical_extension: { unchanged: true } });
    const before = structuredClone(document);
    expect(() => projectOperatorTransition(document, prepare('buyer@example.test'))).toThrow('prior_contact_or_submission_requires_reconciliation');
    expect(() => projectOperatorTransition(document, prepare('other@example.test'))).toThrow('prior_contact_or_submission_requires_reconciliation');
    expect(document).toEqual(before);
  });

  it('historical failed recipient remains fenced even when the contact field names a different domain', () => {
    const document = original();
    document.opportunities.push({ contact: 'other@unrelated.test', failed_recipient: 'old@EXAMPLE.test',
      failed_sent_message_id: 'synthetic-failed-message' });
    const before = structuredClone(document);
    expect(() => projectOperatorTransition(document, prepare('old@example.test'))).toThrow('prior_contact_or_submission_requires_reconciliation');
    expect(document).toEqual(before);
  });

  it.each([
    { url: 'https://market.example.test/listing/fixture', approval_message_id: 'synthetic-approval' },
    { url: 'https://market.example.test/submit', status: 'unknown-delivery-do-not-resubmit' },
    { endpoint: 'historical-unusable-endpoint', url: 'https://market.example.test/listing/fixture', approval_message_id: 'synthetic-approval' },
  ])('historical distribution URL remains reserved with its original approval or unknown state (%j)', submission => {
    const document = original(); document.distribution_submissions.push(submission);
    const before = structuredClone(document);
    expect(() => projectOperatorTransition(document, prepare('market.example.test'))).toThrow('prior_contact_or_submission_requires_reconciliation');
    expect(document).toEqual(before);
  });

  it.each(['submit.example.test', 'listing.example.test'])
  ('both recorded endpoint and listing URL remain fenced for %s', target => {
    const document = original(); document.distribution_submissions.push({
      endpoint: 'https://submit.example.test/contact', url: 'https://listing.example.test/item/fixture',
      approval_message_id: 'synthetic-approval', unknown_original_field: 'retained',
    });
    const before = structuredClone(document);
    expect(() => projectOperatorTransition(document, prepare(target))).toThrow('prior_contact_or_submission_requires_reconciliation');
    expect(document).toEqual(before);
  });
});
