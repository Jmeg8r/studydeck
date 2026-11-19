// WHAT: The mastery wheel — one ring per topic, one arc per concept, grouped by domain.
// WHY: The shared radial component from the approved comps. Rendered as a compact
//      widget here; the full-screen Observatory view (variant A) grafts onto the
//      same geometry in M3, which is why radii are computed rather than hard-coded.
import { arcPath, clear, mk, polar, token } from './svg.mjs';

const GAP_BETWEEN_DOMAINS = 0.03; // radians of breathing room between domain groups
const GAP_BETWEEN_CONCEPTS = 0.009;

/**
 * Neutral (unexplored) arc colours.
 *
 * The widget follows the active theme. The Observatory does not: it is always the
 * night-sky field, in light mode too, so its neutrals are fixed cream-on-navy —
 * theme tokens would render invisible there.
 */
const NEUTRALS = {
  widget: () => ({ fill: token('--arc-fill'), stroke: token('--arc-stroke') }),
  observatory: () => ({ fill: 'rgba(242,229,196,0.12)', stroke: 'rgba(242,229,196,0.20)' }),
};

/** Fill + stroke for a concept arc, by learn-anything status. */
function arcStyle(status, neutral) {
  switch (status) {
    case 'needs_practice':
      return { fill: token('--amber'), stroke: token('--amber'), width: 1.5, glow: true };
    case 'mastered':
      return { fill: token('--teal'), stroke: token('--teal'), width: 1.2, glow: false };
    case 'in_progress':
      return { fill: `${token('--teal')}55`, stroke: token('--teal'), width: 1, glow: false };
    default:
      return { ...neutral, width: 0.6, glow: false };
  }
}

/**
 * Ring radii for `count` topics, innermost first.
 * Bands are even so any number of topics fills the same footprint.
 *
 * `gutterFactor` is the slice of each band left empty between rings. The Observatory
 * needs a wider one because it prints a domain label in that gap — at the widget's
 * 0.16 the labels land on top of the next ring out.
 */
function ringRadii(index, count, outerRadius, gutterFactor) {
  const innerStart = outerRadius * 0.35;
  const band = (outerRadius - innerStart) / count;
  const r0 = innerStart + band * index;
  return { r0, r1: r0 + band - band * gutterFactor };
}

/**
 * Observatory chart furniture (the variant-A graft): concentric guide rings and a
 * degree scale. Decorative, but it is what turns a donut chart into an instrument.
 */
function renderChartFurniture(svg, outerRadius, palette) {
  const ringRadiiFractions = [0.36, 0.46, 0.6, 0.7, 0.8, 0.91, 0.98];
  for (const [i, fraction] of ringRadiiFractions.entries()) {
    mk(svg, 'circle', {
      cx: 0, cy: 0, r: outerRadius * fraction,
      fill: 'none', stroke: palette.ring, 'stroke-width': i % 2 ? 0.5 : 0.75,
    });
  }
  for (let deg = 0; deg < 360; deg += 5) {
    const angle = (deg * Math.PI) / 180;
    const major = deg % 15 === 0;
    const [x0, y0] = polar(outerRadius * 1.0, angle);
    const [x1, y1] = polar(outerRadius * (major ? 1.04 : 1.02), angle);
    mk(svg, 'line', {
      x1: x0, y1: y0, x2: x1, y2: y1,
      stroke: palette.tick, 'stroke-width': major ? 1 : 0.5,
    });
  }
}

/**
 * Render the wheel into an <svg>.
 * Topics render innermost-first in the order given (config's `ring` ordering).
 *
 * `variant: 'observatory'` adds the guide rings, degree scale and domain labels for
 * the full-screen view; the compact widget stays clean.
 */
export function renderWheel(svg, topics, { size = 238, outerRadius = 112, variant = 'widget', onSelect } = {}) {
  clear(svg);
  const observatory = variant === 'observatory';
  const extent = outerRadius * (observatory ? 1.24 : 1.07);

  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', `${-extent} ${-extent} ${extent * 2} ${extent * 2}`);

  if (observatory) {
    renderChartFurniture(svg, outerRadius, {
      ring: 'rgba(242,229,196,0.10)',
      tick: 'rgba(242,229,196,0.18)',
    });
  }

  const neutral = (NEUTRALS[variant] ?? NEUTRALS.widget)();
  const gutterFactor = observatory ? 0.4 : 0.16;

  topics.forEach((topic, ringIndex) => {
    const { r0, r1 } = ringRadii(ringIndex, topics.length, outerRadius, gutterFactor);
    const totalConcepts = topic.domains.reduce((n, d) => n + d.concepts.length, 0);
    if (totalConcepts === 0) return;

    let angle = 0;
    for (const domain of topic.domains) {
      const span = (domain.concepts.length / totalConcepts) * 2 * Math.PI - GAP_BETWEEN_DOMAINS;
      const per = span / domain.concepts.length;

      domain.concepts.forEach((concept, i) => {
        const a0 = angle + per * i + GAP_BETWEEN_CONCEPTS;
        const a1 = angle + per * (i + 1) - GAP_BETWEEN_CONCEPTS;
        const style = arcStyle(concept.status, neutral);

        const path = mk(svg, 'path', {
          d: arcPath(r0, r1, a0, a1),
          fill: style.fill,
          stroke: style.stroke,
          'stroke-width': style.width,
        });
        // The one cell you're actively working should read as hot at a glance.
        if (style.glow) path.setAttribute('filter', `drop-shadow(0 0 8px ${token('--amber')}90)`);

        mk(path, 'title').textContent =
          `${topic.name} · ${domain.name} · ${concept.name} — ${concept.status.replace('_', ' ')}`;

        if (onSelect) {
          path.style.cursor = 'pointer';
          path.addEventListener('click', () => onSelect({ topic, domain, concept }));
        }
      });

      // Domain names sit in the gutter just outside their own ring, rotated to run
      // ALONG the arc. Horizontal labels collide tangentially — each one then owns
      // its own angular sector, so long names in narrow domains can't overlap.
      if (observatory) {
        const band = (outerRadius - outerRadius * 0.35) / topics.length;
        const mid = angle + span / 2;
        const labelRadius = r1 + band * gutterFactor * 0.45;
        const [lx, ly] = polar(labelRadius, mid);

        let degrees = (mid * 180) / Math.PI;
        // Past the horizontal, flip so the text never reads upside down.
        if (degrees > 90 && degrees < 270) degrees += 180;

        const fontSize = Math.max(7.5, outerRadius * 0.027);
        const letterSpacing = 1.1;
        // Fit to the arc the domain actually occupies. Inner rings have less arc per
        // domain, so a long name there would run into its neighbours; truncating is
        // honest because the full name is in the cell tooltip and the detail panel.
        const arcLength = labelRadius * span;
        const perChar = fontSize * 0.6 + letterSpacing;
        const maxChars = Math.floor(arcLength / perChar);
        const full = domain.name.toUpperCase();
        const label = full.length > maxChars ? `${full.slice(0, Math.max(1, maxChars - 1))}…` : full;

        if (maxChars >= 4) {
          mk(svg, 'text', {
            x: lx, y: ly,
            transform: `rotate(${degrees.toFixed(2)} ${lx.toFixed(2)} ${ly.toFixed(2)})`,
            fill: 'rgba(242,229,196,0.5)',
            'font-size': fontSize,
            'text-anchor': 'middle',
            'dominant-baseline': 'middle',
            'letter-spacing': letterSpacing,
            'font-family': 'Avenir Next, Avenir, sans-serif',
          }).textContent = label;
        }
      }

      angle += span + GAP_BETWEEN_DOMAINS;
    }
  });
}
