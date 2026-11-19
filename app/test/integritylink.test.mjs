// WHAT: When the health banner offers a link to Recovery.
// WHY:  The link is only honest where Recovery can act. Storage damage (a file recovered
//       from backup, a torn line) is not Recovery's work, and a link there would send the
//       learner to an empty page. A separate file, so a missing export fails only this.
import test from 'node:test';
import assert from 'node:assert/strict';

const healthyTopic = {
  topic_slug: 'ai-engineering', degraded: [], unparseable_lines: 0, stale_temp_files: [], unreadable_decks: [],
  attempts: { mastery_unapplied: 0, mastery_ambiguous: 0, factcheck_cards_owed: 0 },
  operations: { unresolved: 0, unresolved_list: [] },
};

test('the banner offers Recovery only when Recovery can act on something', async () => {
  const { hasRecoverableWork } = await import('../web/js/integrity.mjs');
  assert.equal(hasRecoverableWork([healthyTopic]), false);
  assert.equal(hasRecoverableWork([{ ...healthyTopic, degraded: ['cards.json'] }]), false, 'storage damage is not Recovery work');
  assert.equal(hasRecoverableWork([{ ...healthyTopic, attempts: { ...healthyTopic.attempts, mastery_unapplied: 1 } }]), true);
  assert.equal(hasRecoverableWork([{ ...healthyTopic, attempts: { ...healthyTopic.attempts, factcheck_cards_owed: 1 } }]), true);
  assert.equal(hasRecoverableWork([{ ...healthyTopic, operations: { unresolved: 1, unresolved_list: [] } }]), true);
});
