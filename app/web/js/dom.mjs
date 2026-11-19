// WHAT: Tiny DOM helpers. No framework, no build step — this is the whole runtime.
// WHY: Building nodes instead of assigning innerHTML keeps state-derived strings
//      (topic names, milestone text) out of the HTML parser entirely.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export const text = (value) => document.createTextNode(value);

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}
