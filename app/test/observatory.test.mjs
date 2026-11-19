// WHAT: The Observatory's dialog contract — what it is, where focus goes, and every way out.
// WHY:  It covers the whole window, so a route that fails to close it, or a close that drops
//       focus, strands a keyboard user with nothing on screen to act on. The stub below
//       proves the wiring only; that showModal() makes the page inert and keeps Tab inside
//       is a browser behaviour, checked by driving a real one.
import test from 'node:test';
import assert from 'node:assert/strict';

class Node extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attrs = {};
    this.parentNode = null;
    this.open = false;
    this.style = {};
    this.data = '';
  }
  get textContent() { return this.data + this.children.map((c) => c.textContent).join(''); }
  set textContent(value) { this.children = []; this.data = String(value); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  append(...children) {
    for (const child of children) {
      const node = typeof child === 'string' ? textNode(child) : child;
      node.parentNode = this;
      this.children.push(node);
    }
  }
  appendChild(child) { this.append(child); return child; }
  get firstChild() { return this.children[0]; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
  remove() { this.parentNode?.removeChild(this); }
  find(predicate) {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const found = child.find(predicate);
      if (found) return found;
    }
    return null;
  }
  focus() { globalThis.document.activeElement = this; }
  click() { this.dispatchEvent(new Event('click')); }
  // Only meaningful on a DIALOG; the real element fires 'close' from close() and from Escape.
  showModal() { this.open = true; }
  close() {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event('close'));
  }
}

function textNode(value) {
  const node = new Node('#text');
  node.data = String(value);
  return node;
}

function installDom() {
  const body = new Node('body');
  globalThis.document = Object.assign(new EventTarget(), {
    body,
    activeElement: body,
    createElement: (tag) => new Node(tag),
    createElementNS: (_ns, tag) => new Node(tag),
    createTextNode: textNode,
  });
  globalThis.window = Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 800 });
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#888888' });
  globalThis.localStorage = { getItem: () => null };
  const launcher = new Node('button');
  body.append(launcher);
  launcher.focus();
  return { body, launcher };
}

const state = { topics: [], today: {}, totals: { concepts: 0, unexplored: 0 }, schedule: {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const { openObservatory } = await import('../web/js/views/observatory.mjs');

function open(withState = state) {
  const dom = installDom();
  openObservatory(withState);
  const dialog = dom.body.children.at(-1);
  return { ...dom, dialog };
}

test('it opens as a modal dialog named by its masthead, with focus on a labelled close button', async () => {
  const { dialog, launcher } = open();
  await tick();
  assert.equal(dialog.tagName, 'DIALOG');
  assert.equal(dialog.open, true, 'opened with showModal()');
  const labelledBy = dialog.getAttribute('aria-labelledby');
  assert.ok(labelledBy, 'the dialog has an accessible name');
  assert.ok(dialog.find((n) => n.getAttribute('id') === labelledBy), 'aria-labelledby points at an element inside it');
  const close = dialog.find((n) => n.tagName === 'BUTTON');
  assert.ok(close.getAttribute('aria-label'), 'the ✕ button is not announced as a bare symbol');
  assert.equal(document.activeElement, close);
  assert.notEqual(document.activeElement, launcher);
});

test('the close button removes it and returns focus to the control that opened it', () => {
  const { dialog, body, launcher } = open();
  // Otherwise "focus is back on the launcher" passes for code that never moved it.
  assert.notEqual(document.activeElement, launcher, 'focus moved into the dialog first');
  dialog.find((n) => n.tagName === 'BUTTON').click();
  assert.equal(body.children.includes(dialog), false);
  assert.equal(document.activeElement, launcher);
});

test('a native close (what Escape produces) does the same cleanup', () => {
  const { dialog, body, launcher } = open();
  dialog.close();
  assert.equal(body.children.includes(dialog), false);
  assert.equal(document.activeElement, launcher);
});

test('a hash change (Back, or a rail link) closes it', () => {
  const { dialog, body, launcher } = open();
  window.dispatchEvent(new Event('hashchange'));
  assert.equal(body.children.includes(dialog), false);
  assert.equal(document.activeElement, launcher);
});

test('a click on the backdrop closes it; a click inside does not', () => {
  const { dialog, body } = open();
  const header = dialog.children[0];
  // The stub has no bubbling, so a click inside is the dialog's listener seeing another target.
  const inside = new Event('click');
  Object.defineProperty(inside, 'target', { value: header });
  dialog.dispatchEvent(inside);
  assert.equal(body.children.includes(dialog), true, 'a click inside leaves it open');
  dialog.dispatchEvent(new Event('click'));
  assert.equal(body.children.includes(dialog), false, 'a click on the dialog itself is the backdrop');
});

// Two topics, so the picker's labels have to say which ring a concept is on.
const concept = (slug, name, status) => ({ slug, name, status, confidence: 2 });
const mapped = {
  topics: [
    {
      slug: 'agents', name: 'Agents', concept_count: 2, schedule: { started: false }, position: {},
      domains: [{ slug: 'loops', name: 'Loops', concepts: [concept('react', 'ReAct', 'in_progress'), concept('reflexion', 'Reflexion', 'unexplored')] }],
      weakness: { domains: [{ slug: 'loops', concepts: [{ slug: 'react', evidence: 'weak', asked: 4, missed: 1, cards: 2 }] }] },
    },
    {
      slug: 'fastai', name: 'fast.ai', concept_count: 1, schedule: { started: false }, position: {},
      domains: [{ slug: 'data', name: 'Data', concepts: [concept('blocks', 'DataBlock', 'needs_practice')] }],
    },
  ],
  today: {},
  totals: { concepts: 3, unexplored: 1 },
  schedule: {},
};

const detailOf = (dialog) => dialog.find((n) => n.getAttribute('class') === 'obs-detail');

test('a keyboard user can inspect every concept through a labelled picker', async () => {
  const { dialog } = open(mapped);
  await tick();
  const picker = dialog.find((n) => n.tagName === 'SELECT');
  assert.ok(picker, 'the Observatory has a concept picker');
  const id = picker.getAttribute('id');
  assert.ok(dialog.find((n) => n.tagName === 'LABEL' && n.getAttribute('for') === id), 'the picker has a <label for>');
  const options = picker.children.filter((n) => n.tagName === 'OPTION');
  assert.equal(options[0].getAttribute('value'), '', 'the first option chooses nothing');
  assert.equal(options.length, mapped.totals.concepts + 1, 'one option per concept, plus the blank one');
  assert.match(options[3].textContent, /fast\.ai.*Data.*DataBlock/, 'an option names its topic, domain and concept');

  // Every cell the pointer can click and every option the picker offers must show the same set
  // of detail panels; otherwise the keyboard path is a second, drifting copy of the click path.
  const svg = dialog.find((n) => n.tagName === 'SVG');
  const fromCells = svg.children.filter((n) => n.tagName === 'PATH' && n.style.cursor === 'pointer')
    .map((cell) => { cell.click(); return detailOf(dialog).textContent; });
  const fromPicker = options.slice(1).map((option) => {
    picker.value = option.getAttribute('value');
    picker.dispatchEvent(new Event('change'));
    return detailOf(dialog).textContent;
  });
  assert.equal(fromCells.length, mapped.totals.concepts, 'control: every concept cell is clickable');
  assert.deepEqual([...fromPicker].sort(), [...fromCells].sort());
  assert.match(fromPicker[0], /ReAct.*3\/4 correct.*2 cards queued/);
});

test('the detail panel announces what was chosen, and the wheel is one labelled image', async () => {
  const { dialog } = open(mapped);
  await tick();
  assert.equal(detailOf(dialog).getAttribute('aria-live'), 'polite');
  const svg = dialog.find((n) => n.tagName === 'SVG');
  assert.equal(svg.getAttribute('role'), 'img');
  assert.match(svg.getAttribute('aria-label') ?? '', /3 concepts/);
});

// The caption needs a wheel of at least ~446px to clear the inner ring (measured 2026-11-10).
// Viewport width alone misses the short laptop window, so the class follows wheelSize().
test('a wheel too small for the hub caption marks its field compact', () => {
  const cases = [[1280, 800, false], [1280, 560, true], [800, 800, true], [390, 844, true]];
  const seen = cases.map(([width, height]) => {
    const { body } = installDom();
    Object.assign(window, { innerWidth: width, innerHeight: height });
    openObservatory(state);
    const field = body.children.at(-1).find((n) => (n.getAttribute('class') ?? '').startsWith('obs-field'));
    return [width, height, field.getAttribute('class').split(' ').includes('compact')];
  });
  assert.deepEqual(seen, cases);
});
