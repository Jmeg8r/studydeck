// WHAT: A small DOM recorder for view-lifetime tests.
// WHY: The suite runs with no dependencies (CLAUDE.md rule 5), so there is no jsdom. This
//      records what a view builds and calls, which is what a lifetime contract pins. It
//      does not lay anything out or play media; layout and playback are checked by hand.
export class Element extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attrs = {};
    this.style = {};
    this.value = '';
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  setAttribute(name, value) { this.attrs[name] = String(value); if (name === 'value') this.value = value; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  append(...children) {
    for (const child of children) {
      // As in a browser, anything that is not a node (null included) becomes text.
      const node = child instanceof Element ? child : Object.assign(new Element('#text'), { textContent: String(child) });
      node.parentNode?.removeChild(node);
      node.parentNode = this;
      this.children.push(node);
    }
  }
  appendChild(child) { this.append(child); return child; }
  insertBefore(node, reference) {
    if (!reference) { this.append(node); return node; }
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.children.splice(this.children.indexOf(reference), 0, node);
    return node;
  }
  prepend(...children) { this.append(...children); this.children.unshift(...this.children.splice(-children.length)); }
  get firstChild() { return this.children[0]; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; return child; }
  remove() { this.parentNode?.removeChild(this); }
  // An assigned textContent replaces an element's children in a browser; reading it back
  // here is the same as reading the text it was given.
  get text() {
    if (this.tagName === '#TEXT' || this.textContent !== undefined) return this.textContent ?? '';
    return this.children.map((child) => child.text).join('');
  }
  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      const match = selector.startsWith('.')
        ? (child.attrs.class ?? '').split(' ').includes(selector.slice(1))
        : child.tagName.toLowerCase() === selector;
      if (match) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  click() { this.dispatchEvent(new Event('click')); }
  // Recorded, not laid out: a test reads document.activeElement to see where focus went.
  focus() { document.activeElement = this; }
}

export function installDom() {
  globalThis.document = Object.assign(new EventTarget(), {
    hidden: false,
    body: new Element('body'),
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => Object.assign(new Element('#text'), { textContent: text }),
    getElementById: () => null,
  });
  globalThis.window = Object.assign(new EventTarget(), { innerHeight: 100, innerWidth: 1000 });
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));
