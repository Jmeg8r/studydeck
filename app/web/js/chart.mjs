// WHAT: Score history chart for one concept, with the pretest baseline called out.
// WHY: The whole point of the pretest is the delta against it, so the baseline is
//      drawn as a reference line rather than as just another point in the series.
import { clear, mk, token } from './svg.mjs';

const W = 640;
const H = 190;
const PAD = { top: 18, right: 18, bottom: 34, left: 38 };

/** attempts: [{ts, score, max, self_graded?}] in chronological order. */
export function renderScoreChart(svg, attempts) {
  clear(svg);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', H);

  const amber = token('--amber');
  const teal = token('--teal');
  const dim = token('--dim');
  const faint = token('--faint');
  const line = token('--rail-track');

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const y = (pct) => PAD.top + plotH * (1 - pct);
  const x = (i, n) => (n <= 1 ? PAD.left + plotW / 2 : PAD.left + (plotW * i) / (n - 1));

  for (const pct of [0, 0.5, 1]) {
    mk(svg, 'line', { x1: PAD.left, y1: y(pct), x2: W - PAD.right, y2: y(pct), stroke: line, 'stroke-width': 1 });
    mk(svg, 'text', {
      x: PAD.left - 8, y: y(pct) + 4, fill: faint, 'font-size': 10,
      'text-anchor': 'end', 'font-family': token('--font-display'),
    }).textContent = `${Math.round(pct * 100)}%`;
  }

  if (attempts.length === 0) {
    mk(svg, 'text', {
      x: W / 2, y: H / 2, fill: dim, 'font-size': 12,
      'text-anchor': 'middle', 'font-family': token('--font-display'),
    }).textContent = 'No attempts recorded yet';
    return;
  }

  const points = attempts.map((a, i) => ({
    ...a,
    pct: a.max > 0 ? a.score / a.max : 0,
    cx: x(i, attempts.length),
  }));

  // The first attempt is the pretest — the number every later attempt is measured against.
  const baseline = points[0];
  mk(svg, 'line', {
    x1: PAD.left, y1: y(baseline.pct), x2: W - PAD.right, y2: y(baseline.pct),
    stroke: teal, 'stroke-width': 1.2, 'stroke-dasharray': '4 4',
  });
  mk(svg, 'text', {
    x: W - PAD.right, y: y(baseline.pct) - 6, fill: teal, 'font-size': 9.5,
    'text-anchor': 'end', 'letter-spacing': 1, 'font-family': token('--font-display'),
  }).textContent = `PRETEST BASELINE ${baseline.score}/${baseline.max}`;

  if (points.length > 1) {
    mk(svg, 'polyline', {
      points: points.map((p) => `${p.cx},${y(p.pct)}`).join(' '),
      fill: 'none', stroke: amber, 'stroke-width': 2,
    });
  }

  for (const point of points) {
    const node = mk(svg, 'circle', {
      cx: point.cx, cy: y(point.pct), r: 5, fill: amber, stroke: token('--panel'), 'stroke-width': 1.5,
    });
    mk(node, 'title').textContent =
      `${point.ts.slice(0, 10)} — ${point.score}/${point.max}` +
      (point.self_graded?.length ? ` (${point.self_graded.length} self-graded)` : '');

    mk(svg, 'text', {
      x: point.cx, y: H - 12, fill: dim, 'font-size': 9.5,
      'text-anchor': 'middle', 'font-family': token('--font-display'),
    }).textContent = point.ts.slice(5, 10);
  }
}
