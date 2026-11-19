// WHAT: Server-side deck grading, and the answer-stripping that makes a deck safe to serve.
// WHY: Answers must never reach the browser before submit — otherwise a retake stops
//      being a measurement and the pretest baseline is worthless. Grading therefore
//      lives here, on the server, and the client only ever posts raw responses.
//
// Grading rules mirror learn-anything's own quiz skill exactly (Step 6), so an in-app
// attempt and a Claude-session attempt score the same deck identically:
//   exact    → strict equality; multi_select compares as UNORDERED sets
//   accepted → trim + lowercase, then membership in accepted_answers[]
//   ai_only  → no auto-grade; the reference answer is for self-check on re-practice

/** Fields that reveal the answer. Stripped from anything sent before submit. */
const ANSWER_FIELDS = ['answer', 'accepted_answers', 'explanation'];

/** A deck safe to send to the browser: prompts and options only. */
export function stripAnswers(deck) {
  return {
    ...deck,
    questions: deck.questions.map((q) => {
      const safe = { ...q };
      for (const field of ANSWER_FIELDS) delete safe[field];
      return safe;
    }),
  };
}

const normalize = (value) => String(value ?? '').trim().toLowerCase();

function sameSet(a, b) {
  const left = new Set((Array.isArray(a) ? a : [a]).map(normalize));
  const right = new Set((Array.isArray(b) ? b : [b]).map(normalize));
  if (left.size !== right.size) return false;
  for (const item of left) if (!right.has(item)) return false;
  return true;
}

/**
 * Grade one question against a response.
 * Returns `correct: null` for ai_only — "not auto-gradable", which is different
 * from "wrong" and must stay distinguishable all the way into the attempt record.
 */
function gradeQuestion(question, response) {
  const answered = response !== undefined && response !== null && response !== '';

  if (question.gradeable === 'ai_only') {
    return { correct: null, answered, reference: question.answer };
  }
  if (!answered) return { correct: false, answered: false };

  switch (question.gradeable) {
    case 'exact': {
      if (question.type === 'multi_select') return { correct: sameSet(response, question.answer), answered };
      if (question.type === 'true_false') {
        // Radio inputs hand back strings; the deck stores real booleans.
        const asBool = typeof response === 'boolean' ? response : normalize(response) === 'true';
        return { correct: asBool === question.answer, answered };
      }
      return { correct: normalize(response) === normalize(question.answer), answered };
    }
    case 'accepted': {
      const candidates = [...(question.accepted_answers ?? []), question.answer];
      return { correct: candidates.some((c) => normalize(c) === normalize(response)), answered };
    }
    default:
      return { correct: null, answered, reference: question.answer };
  }
}

/**
 * Grade a whole deck.
 *
 * `selfGrades` carries the learner's own verdict on ai_only items (upstream's
 * documented "self-check on re-practice"). Which items were self-graded is
 * recorded on the attempt so a self-marked score is never mistaken for a
 * machine-graded one.
 */
export function gradeDeck(deck, responses = {}, selfGrades = {}, confidence = {}) {
  const results = [];
  let score = 0;
  let max = 0;
  const misses = [];
  const pending = [];
  const selfGraded = [];

  for (const question of deck.questions) {
    const graded = gradeQuestion(question, responses[question.id]);
    let correct = graded.correct;

    if (correct === null && question.id in selfGrades) {
      correct = Boolean(selfGrades[question.id]);
      selfGraded.push(question.id);
    }

    if (correct === null) {
      pending.push(question.id);
    } else {
      max += 1;
      if (correct) score += 1;
      else misses.push(question.id);
    }

    results.push({
      id: question.id,
      type: question.type,
      gradeable: question.gradeable,
      prompt: question.prompt,
      response: responses[question.id] ?? null,
      confidence: confidence[question.id] ?? null,
      correct,
      self_graded: selfGraded.includes(question.id),
      // Revealed only in a grade response — never in GET /api/decks/:file.
      answer: question.answer,
      explanation: question.explanation,
    });
  }

  return { score, max, misses, pending, self_graded: selfGraded, results };
}
