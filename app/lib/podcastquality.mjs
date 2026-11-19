// WHAT: Deterministic gates for the local chapter renderer: plan a chapter into bounded
//       sections, require each transcript turn to quote its section, refuse repeated or
//       empty transcripts before speech, and flag a looping audio envelope after assembly.
// WHY:  Open Notebook's generate job checks none of this, so a podcast that repeats itself
//       or wanders from its source is found only by listening to all of it. Pure functions,
//       no I/O, so every verdict is reproducible from its inputs (D5a of the September port).
//
// Passing these checks is technical QC, not a claim that a model's explanation is
// accurate or pedagogically complete; publication needs a listen.
import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const clipKey = value => digest(value);
export const PROMPT_VERSION = 'chapter-dialogue-v5';
export const words = text => String(text).match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];

const REVIEW_HEADING = /^#{1,6}\s+(?:Questionnaire|Review Questions|Further Research|References)\s*$/;
// CommonMark: up to three spaces, then three or more of one fence character.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Where the end-of-chapter questions or references begin: the first matching heading
 * that is not inside a fenced code block, or undefined. A "## References" line in a
 * markdown example is part of the explanation, and treating it as the chapter's end
 * would silently drop everything after it.
 */
function reviewHeadingIndex(text) {
  let offset = 0;
  let open = null; // the opening run, e.g. '````'
  for (const line of text.split('\n')) {
    const [, run, rest] = FENCE.exec(line.replace(/\r$/, '')) ?? [];
    if (run && open === null) open = run;
    // A closer uses the opener's character, is at least as long, and carries nothing after.
    else if (run && run[0] === open[0] && run.length >= open.length && !rest.trim()) open = null;
    else if (open === null && REVIEW_HEADING.test(line)) return offset;
    offset += line.length + 1;
  }
  return undefined;
}

export function planChapter(text, { contextTokens } = {}) {
  if (!text?.trim()) throw new Error('Source has no usable text');
  if (!Number.isInteger(contextTokens) || contextTokens < 4096) throw new Error('A verified model context of at least 4096 tokens is required');
  // UTF-8 bytes are a conservative token upper bound. Reserve 2400 tokens for
  // instructions, the coverage outline and output. Never silently truncate source.
  const maxBytes = Math.min(12000, contextTokens - 2400);
  const segments = [];
  const reviewStart = reviewHeadingIndex(text);
  const contentEnd = reviewStart ?? text.length;
  const excluded = reviewStart === undefined ? [] : [{ start: reviewStart, end: text.length, reason: 'End-of-chapter questions and references are not explanatory source passages' }];
  let start = 0;
  while (start < contentEnd) {
    let end = Math.min(contentEnd, start + maxBytes);
    while (Buffer.byteLength(text.slice(start, end)) > maxBytes) end -= Math.max(1, Math.ceil((end - start) / 8));
    if (end < contentEnd) {
      const boundary = text.lastIndexOf('\n', end);
      if (boundary > start + (end - start) / 2) end = boundary + 1;
      else { const space = text.lastIndexOf(' ', end); if (space > start) end = space + 1; }
    }
    const excerpt = text.slice(start, end);
    segments.push({ id: `section-${segments.length + 1}`, start, end, source_hash: digest(excerpt),
      anchor: excerpt.trim().slice(0, 180), responsibility: `Explain the ideas in source characters ${start}–${end}; use an example grounded in this section.` });
    start = end;
    if (segments.length > 12) throw new Error('Source exceeds the chapter context budget; select a smaller source or a larger-context model');
  }
  const budget = Math.max(400, Math.min(1800, segments.length * 260));
  return { version: 1, purpose: 'chapter study explanation', word_budget: budget, context_tokens: contextTokens,
    max_source_chars: maxBytes, excluded, segments: segments.map(s => ({ ...s, word_budget: Math.round(budget / segments.length) })) };
}

export function checkGrounding(turns, source) {
  const normalize = text => String(text ?? '').replace(/[\\`*_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const passage = normalize(source);
  const issues = (Array.isArray(turns) ? turns : []).flatMap((turn, index) => {
    const quote = normalize(turn?.source_quote);
    return words(quote).length < 6 || quote.length > 4000 || !passage.includes(quote) ? [`Turn ${index + 1}: source quote is missing or does not match this section`] : [];
  });
  // Checked on the array, not the input: a string has a length too, and would pass.
  if (!Array.isArray(turns) || !turns.length) issues.push('No source-grounded turns');
  return { passed: !issues.length, issues };
}

/** Citable passages include surrounding explanation, not isolated code/heading lines. */
export function sourcePassages(text) {
  const passages = []; let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + 1600);
    const newline = text.lastIndexOf('\n', end);
    if (end < text.length && newline > start + 600) end = newline + 1;
    if (text.length - end < 160) end = text.length;
    passages.push({ id: `p${passages.length + 1}`, text: text.slice(start, end) }); start = end;
  }
  return passages;
}

export function checkTranscript(turns, speakers, { minWords = 40, maxWords = 3000 } = {}) {
  const issues = [];
  const warnings = [];
  if (!Array.isArray(turns) || !turns.length || turns.length > 180) return { passed: false, issues: ['Transcript must contain 1–180 turns'], words: 0 };
  const seen = new Map();
  const allWords = [];
  for (const [index, turn] of turns.entries()) {
    if (!speakers.includes(turn?.speaker)) issues.push(`Turn ${index + 1}: unknown speaker`);
    if (typeof turn?.dialogue !== 'string' || !turn.dialogue.trim()) { issues.push(`Turn ${index + 1}: empty dialogue`); continue; }
    if (turn.dialogue.length > 2400) issues.push(`Turn ${index + 1}: speech chunk exceeds 2400 characters`);
    allWords.push(...words(turn.dialogue.toLowerCase()));
  }
  // A repeated 24-word passage is too long to be a conversational acknowledgement.
  // Non-overlapping occurrences also catch repetition inside a single model turn.
  for (let i = 0; i + 24 <= allWords.length; i++) {
    const key = allWords.slice(i, i + 24).join(' ');
    const prior = seen.get(key);
    if (prior !== undefined && i - prior >= 24) { issues.push(`Repeated passage near word ${i + 1}`); break; }
    if (prior === undefined) seen.set(key, i);
  }
  if (allWords.length < minWords || allWords.length > maxWords) issues.push(`Transcript has ${allWords.length} words; expected ${minWords}–${maxWords}`);
  const vocabulary = new Map();
  const lowNovelty = new Map();
  const common = new Set('that this with have from your which their these those they them when where what about would could should into more also such using used model models data learning example instance important ensures ensure helps help crucial approach process'.split(' '));
  for (const turn of turns) {
    // Turns the first pass already refused carry no vocabulary: they must not throw here,
    // and a missing dialogue must not count as the word "undefined".
    if (typeof turn?.dialogue !== 'string') continue;
    const section = turn.section_id ?? 'transcript';
    const prior = vocabulary.get(section) ?? new Set();
    const content = new Set(words(turn.dialogue.toLowerCase()).filter(w => w.length > 3 && !common.has(w)));
    const novel = [...content].filter(w => !prior.has(w)).length;
    if (content.size >= 12 && novel / content.size < .25) lowNovelty.set(section, (lowNovelty.get(section) ?? 0) + 1);
    for (const word of content) prior.add(word);
    vocabulary.set(section, prior);
  }
  for (const [section, count] of lowNovelty) if (count >= 2) warnings.push(`${section}: several turns add little new vocabulary; check for repeated explanations`);
  return { passed: issues.length === 0, issues, warnings, words: allWords.length };
}

/** 100 ms RMS envelopes; flag near-identical 20 s windows separated by >= 60 s. */
export function repeatedEnvelope(envelope) {
  const windows = [];
  const size = 200;
  for (let offset = 0; offset + size <= envelope.length; offset += 50) {
    const values = envelope.slice(offset, offset + size);
    const mean = values.reduce((a, b) => a + b, 0) / size;
    const centered = values.map(x => x - mean);
    const norm = Math.sqrt(centered.reduce((a, b) => a + b * b, 0));
    if (norm > 0.01) windows.push({ offset, values: centered.map(x => x / norm) });
  }
  const matches = [];
  for (let i = 0; i < windows.length; i++) for (let j = i + 1; j < windows.length; j++) {
    if (windows[j].offset - windows[i].offset < 600) continue;
    const similarity = windows[i].values.reduce((a, x, k) => a + x * windows[j].values[k], 0);
    if (similarity > 0.985) matches.push({ from_seconds: windows[i].offset / 10, repeated_at_seconds: windows[j].offset / 10, similarity });
    if (matches.length >= 8) return matches;
  }
  return matches;
}
