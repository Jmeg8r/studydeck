// WHAT: The lapse-rate gate contract from tasks/roadmap-2026-07-30.md §5.
// WHY:  Roadmap D-c. The Anki/FSRS exporter has been gated since 2026-07-16 on "if the
//       review heuristic's ceiling is hit after ~2 weeks", with nothing measuring it. These
//       tests pin the contract so the gate means the same thing every time it is read —
//       including the part that decides NOT to answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAPSE_STATUS, MIN_MATURE_REVIEWS, lapseRate } from '../lib/lapse.mjs';

const REF = '2026-07-30';

/** `results` is oldest-first; days ago is spaced so everything lands inside the window. */
function historyFor(cardId, results, { startDaysAgo = 10 } = {}) {
  return results.map((result, i) => {
    const day = new Date(Date.parse(`${REF}T00:00:00Z`) - (startDaysAgo - i) * 86_400_000);
    return { card_id: cardId, result, ts: `${day.toISOString().slice(0, 10)}T10:00:00Z` };
  });
}

/** N cards each with two hits (maturing them) then one more review of `last`. */
function matureCards(count, last) {
  const reviews = [];
  for (let i = 0; i < count; i += 1) reviews.push(...historyFor(`card-${i}`, ['hit', 'hit', last]));
  return reviews;
}

test('below the minimum sample the rate is NOT reported — insufficient is a real answer', () => {
  // The clause worth defending hardest. 1 miss in 3 is 33% and means nothing; a gate three
  // reviews can trip will trip early, get overridden, and stop being believed.
  const result = lapseRate(matureCards(3, 'miss'), REF);

  assert.equal(result.status, LAPSE_STATUS.INSUFFICIENT);
  assert.equal(result.rate, null, 'a rate was reported on an unusable sample');
  assert.equal(result.mature_reviews, 3);
  assert.equal(result.needed, MIN_MATURE_REVIEWS - 3);
});

test('insufficient is not a green zero, even when nothing was missed', () => {
  // The failure this mirrors is verify:live calling an empty notebook clean. "I looked and
  // there was nothing to look at" must never render as a pass.
  const result = lapseRate(matureCards(3, 'hit'), REF);
  assert.equal(result.status, LAPSE_STATUS.INSUFFICIENT);
  assert.equal(result.rate, null);
});

test('a rate above the threshold, on a real sample, opens the gate', () => {
  // 40 mature reviews, 12 of them lapses = 30% > 20%.
  const reviews = [...matureCards(12, 'miss'), ...matureCards(28, 'hit').map((r) => ({ ...r, card_id: `x-${r.card_id}` }))];
  const result = lapseRate(reviews, REF);

  assert.equal(result.mature_reviews, 40);
  assert.equal(result.lapses, 12);
  assert.equal(result.status, LAPSE_STATUS.CEILING);
  assert.ok(Math.abs(result.rate - 0.3) < 1e-9);
});

test('at or below the threshold the heuristic is holding', () => {
  // Exactly 20% must NOT trip it — the contract says "> 20%", and a boundary that drifts
  // by one review is how a written threshold stops being one.
  const reviews = [...matureCards(8, 'miss'), ...matureCards(32, 'hit').map((r) => ({ ...r, card_id: `x-${r.card_id}` }))];
  const result = lapseRate(reviews, REF);

  assert.equal(result.mature_reviews, 40);
  assert.equal(result.rate, 0.2);
  assert.equal(result.status, LAPSE_STATUS.HOLDING, 'exactly the threshold tripped the gate');
});

test('only MATURE reviews count — a young card missing says nothing about the scheduler', () => {
  // 40 cards, each reviewed twice and missed the second time. The second review happens at
  // the 3-day rung, so none of it is mature and there is nothing to measure.
  const reviews = [];
  for (let i = 0; i < 40; i += 1) reviews.push(...historyFor(`young-${i}`, ['hit', 'miss']));
  const result = lapseRate(reviews, REF);

  assert.equal(result.mature_reviews, 0, 'a 3-day rung was counted as mature');
  assert.equal(result.status, LAPSE_STATUS.INSUFFICIENT);
});

test('a card\'s FIRST review is never mature — that is exposure, not retention', () => {
  const reviews = [];
  for (let i = 0; i < 40; i += 1) reviews.push(...historyFor(`first-${i}`, ['miss']));
  assert.equal(lapseRate(reviews, REF).mature_reviews, 0);
});

test('a miss resets the rung, so the next review is young again', () => {
  // hit, hit (now at 7d), miss (mature — counted), then hit at the 1-day rung (not mature).
  const reviews = [];
  for (let i = 0; i < 40; i += 1) reviews.push(...historyFor(`reset-${i}`, ['hit', 'hit', 'miss', 'hit'], { startDaysAgo: 12 }));
  const result = lapseRate(reviews, REF);

  assert.equal(result.mature_reviews, 40, 'only the third review of each card is mature');
  assert.equal(result.lapses, 40);
});

test('the window bounds what is COUNTED, not what decides maturity', () => {
  // The subtle one. A card's rung comes from reviews that may predate the window entirely.
  // Dropping those before computing maturity would make every card look young and the rate
  // look artificially clean — a scheduler failure reported as a healthy one.
  const reviews = [];
  for (let i = 0; i < 40; i += 1) {
    // Two hits 40 and 39 days ago (well outside the window), then a miss 2 days ago.
    reviews.push(
      ...historyFor(`old-${i}`, ['hit', 'hit'], { startDaysAgo: 40 }),
      ...historyFor(`old-${i}`, ['miss'], { startDaysAgo: 2 }),
    );
  }
  const result = lapseRate(reviews, REF);

  assert.equal(result.mature_reviews, 40, 'history outside the window was dropped before judging maturity');
  assert.equal(result.status, LAPSE_STATUS.CEILING);
});

test('reviews outside the window are not counted', () => {
  const reviews = [];
  for (let i = 0; i < 40; i += 1) reviews.push(...historyFor(`stale-${i}`, ['hit', 'hit', 'miss'], { startDaysAgo: 60 }));
  const result = lapseRate(reviews, REF);
  assert.equal(result.mature_reviews, 0);
  assert.equal(result.status, LAPSE_STATUS.INSUFFICIENT);
});

test('out-of-order jsonl lines do not corrupt maturity', () => {
  // Append order is not guaranteed to be timestamp order across sessions, and maturity
  // depends entirely on what came before each review.
  const ordered = historyFor('c1', ['hit', 'hit', 'miss']);
  const shuffled = [ordered[2], ordered[0], ordered[1]];
  assert.equal(lapseRate(shuffled, REF, { minMature: 1 }).mature_reviews, 1);
  assert.equal(lapseRate(shuffled, REF, { minMature: 1 }).lapses, 1);
});

test('malformed review rows are ignored rather than guessed at', () => {
  const reviews = [null, { result: 'miss' }, { card_id: 'c', result: 'miss', ts: 'nonsense' }];
  const result = lapseRate(reviews, REF, { minMature: 1 });
  assert.equal(result.mature_reviews, 0);
  assert.equal(result.status, LAPSE_STATUS.INSUFFICIENT);
});

test('no reviews at all is insufficient, never a pass', () => {
  const result = lapseRate([], REF);
  assert.equal(result.status, LAPSE_STATUS.INSUFFICIENT);
  assert.equal(result.rate, null);
  assert.equal(result.needed, MIN_MATURE_REVIEWS);
});
