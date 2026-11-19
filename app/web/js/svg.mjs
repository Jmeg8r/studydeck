// WHAT: Minimal SVG helpers shared by the wheel and the timeline strip.
// WHY: Both components are hand-built SVG (no chart library) — this is the whole
//      toolkit they need, lifted straight from the approved comps.

export const NS = 'http://www.w3.org/2000/svg';

/** Create an SVG element with attributes and append it to `parent`. */
export function mk(parent, name, attrs = {}) {
  const el = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  parent.appendChild(el);
  return el;
}

/** Polar → cartesian, with 0 radians at 12 o'clock. */
export const polar = (r, angle) => [r * Math.cos(angle - Math.PI / 2), r * Math.sin(angle - Math.PI / 2)];

/** Path data for an annular sector (a ring segment) between two radii and two angles. */
export function arcPath(r0, r1, a0, a1) {
  const [x0, y0] = polar(r1, a0);
  const [x1, y1] = polar(r1, a1);
  const [x2, y2] = polar(r0, a1);
  const [x3, y3] = polar(r0, a0);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${x0},${y0}A${r1},${r1} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 ${large} 0 ${x3},${y3}Z`;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Read a CSS custom property off :root so SVG fills follow the active theme. */
export function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
