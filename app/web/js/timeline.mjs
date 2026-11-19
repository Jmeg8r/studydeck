// WHAT: The schedule strip — expanding intervals across the 30-day pipeline.
// WHY: The spacing IS the method, so the strip is scaled by actual day number
//      (not evenly spaced ticks) — the widening gaps are the visual argument.
import { clear, mk, token } from './svg.mjs';

const W = 1040;
const H = 80;
const PAD = 24;
const AXIS_Y = 38;

export function renderTimeline(svg, timeline, { dayN } = {}) {
  clear(svg);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);
  svg.setAttribute('width', '100%');
  svg.setAttribute('preserveAspectRatio', 'none');

  if (!timeline.length) return;

  const lastDay = timeline[timeline.length - 1].day;
  const x = (day) => PAD + (W - 2 * PAD) * (day / lastDay);

  const amber = token('--amber');
  const coral = token('--coral');
  // Coral is too light for text on the cream theme (2.81:1); labels use its text shade.
  const errorText = token('--error-text');
  const accentText = token('--accent-text');
  const dim = token('--dim');
  const faint = token('--faint');

  mk(svg, 'line', {
    x1: PAD, y1: AXIS_Y, x2: W - PAD, y2: AXIS_Y,
    stroke: token('--rail-track'), 'stroke-width': 2,
  });

  // Two overlays, and the split is the point. Amber runs to the last stage you actually
  // COMPLETED; coral runs from there to today. The strip used to paint one amber run all
  // the way to today's date, which drew calendar time as if it were progress — the same
  // claim the queue used to make, in picture form.
  const completed = timeline.filter((m) => m.state === 'done');
  const lastDoneDay = completed.length ? Math.max(...completed.map((m) => m.day)) : null;
  const todayX = typeof dayN === 'number' ? x(Math.min(Math.max(dayN, 0), lastDay)) : null;

  if (lastDoneDay !== null && lastDoneDay > 0) {
    mk(svg, 'line', {
      x1: PAD, y1: AXIS_Y, x2: x(lastDoneDay), y2: AXIS_Y, stroke: amber, 'stroke-width': 2,
    });
  }
  const owedFromX = lastDoneDay === null ? PAD : x(lastDoneDay);
  if (todayX !== null && todayX > owedFromX) {
    // Elapsed but unearned. Dashed so it reads as a gap rather than as covered ground.
    mk(svg, 'line', {
      x1: owedFromX, y1: AXIS_Y, x2: todayX, y2: AXIS_Y,
      stroke: coral, 'stroke-width': 2, 'stroke-dasharray': '3 3', opacity: 0.7,
    });
  }

  timeline.forEach((milestone, i) => {
    const cx = x(milestone.day);
    const isNow = milestone.state === 'now';
    const isOwed = milestone.state === 'owed';
    const isDone = milestone.state === 'done';
    // Done is amber, anything owed is coral, anything ahead stays quiet.
    const hue = isDone ? amber : (isNow || isOwed) ? coral : null;

    const node = mk(svg, 'circle', {
      cx, cy: AXIS_Y, r: isNow ? 7 : 5,
      // Only the action and completed stages are filled; an owed stage is a hollow ring,
      // so "you owe this" never looks like "you did this".
      fill: isDone || isNow ? hue : token('--panel'),
      stroke: hue ?? faint,
      'stroke-width': 1.5,
    });
    // Matches what the hero and queue pills say for the same stage — a strip that reads
    // "owed 0d" beside a pill reading "due today" is two answers to one question.
    const owedDays = milestone.owed_days ?? 0;
    const status = isDone
      ? `done${milestone.completed_on ? ` ${milestone.completed_on}` : ''}`
      : isNow || isOwed
        ? (owedDays === 0 ? 'due today' : `owed ${owedDays}d`)
        : 'not yet due';
    mk(node, 'title').textContent = `Day ${milestone.day} — ${milestone.title} (${status})`;

    mk(svg, 'text', {
      x: cx, y: 64,
      fill: isNow ? errorText : dim,
      'font-size': 11.5, 'text-anchor': 'middle', 'font-family': token('--font-display'),
    }).textContent = `d${milestone.day}`;

    // Early milestones cluster tightly, so their labels alternate height and
    // left-anchor to stay legible; later ones have room to centre.
    const crowded = milestone.day <= 4;
    mk(svg, 'text', {
      x: crowded ? cx + 4 : cx,
      y: crowded ? (i % 2 ? 8 : 20) : 18,
      fill: isNow ? errorText : isDone ? accentText : faint,
      'font-size': 9.5,
      'text-anchor': crowded ? 'start' : 'middle',
      'letter-spacing': 1,
      'font-family': token('--font-display'),
    }).textContent = milestone.label;
  });
}
