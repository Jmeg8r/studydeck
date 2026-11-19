// WHAT: Regression tests for debrief card identity (assessment finding F4).
// WHY: Card ids were `card-debrief-<date>-<position>` with positions restarting at 1 on
//      every debrief. A second walk debrief on the same day therefore produced ids the
//      first debrief already owned, the skip-if-exists guard dropped every new draft, and
//      the response reported zero cards while the Open Notebook note had saved fine. The
//      failure looked like the model returning nothing, which is why it survived review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDebriefCards } from '../lib/debrief.mjs';

const DATE = '2026-07-28';
const drafted = [
  { front: 'What is a validation set for?', back: 'Measuring generalisation, not fitting.' },
  { front: 'What does fine_tune do to the body?', back: 'Freezes it for one epoch, then unfreezes.' },
];

test('two debriefs on the same day produce disjoint card ids', () => {
  const morning = buildDebriefCards(drafted, { debriefId: 'aaaaaaaa-1111-4000-8000-000000000000', date: DATE });
  const evening = buildDebriefCards(drafted, { debriefId: 'bbbbbbbb-2222-4000-8000-000000000000', date: DATE });

  const ids = new Set([...morning, ...evening].map((c) => c.id));
  assert.equal(ids.size, 4, 'four distinct cards — pre-fix this collapsed to two');
  assert.equal(morning[0].id, 'card-debrief-2026-07-28-aaaaaaaa-1');
  assert.equal(evening[0].id, 'card-debrief-2026-07-28-bbbbbbbb-1');
});

test('the second debrief is not dropped by the existing-id guard', () => {
  const morning = buildDebriefCards(drafted, { debriefId: 'aaaaaaaa-1111-4000-8000-000000000000', date: DATE });
  const evening = buildDebriefCards(drafted, {
    debriefId: 'bbbbbbbb-2222-4000-8000-000000000000',
    date: DATE,
    existingIds: new Set(morning.map((c) => c.id)),
  });

  assert.equal(evening.length, 2, 'the evening debrief keeps all of its cards');
});

test('source_ref carries the full debrief id, so a card is traceable to its submission', () => {
  const [card] = buildDebriefCards(drafted, { debriefId: 'aaaaaaaa-1111-4000-8000-000000000000', date: DATE });
  assert.equal(card.source_ref, 'debrief:aaaaaaaa-1111-4000-8000-000000000000:1');
  assert.equal(card.source, 'walk');
  assert.equal(card.created, DATE);
});

test('an actual repeat of the same debrief is still skipped', () => {
  const first = buildDebriefCards(drafted, { debriefId: 'aaaaaaaa-1111-4000-8000-000000000000', date: DATE });
  const repeat = buildDebriefCards(drafted, {
    debriefId: 'aaaaaaaa-1111-4000-8000-000000000000',
    date: DATE,
    existingIds: new Set(first.map((c) => c.id)),
  });
  assert.deepEqual(repeat, []);
});

test('concept_slug is carried through, defaulting to null rather than being invented', () => {
  const [tagged] = buildDebriefCards(drafted, { debriefId: 'aaaaaaaa', date: DATE, conceptSlug: 'your-first-model' });
  const [untagged] = buildDebriefCards(drafted, { debriefId: 'aaaaaaaa', date: DATE });
  assert.equal(tagged.concept_slug, 'your-first-model');
  assert.equal(untagged.concept_slug, null);
});
