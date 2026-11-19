// WHAT: Mind Map studio — sketch from memory, then diff against the real map.
// WHY: Step 4, retrieval-first. You draw before you look; the gaps are the study targets.
//
// The app cannot read your sketch, so it does not pretend to. You tick what you actually
// recalled and it computes the rest. That is honest, and marking your own recall is
// better retrieval practice than having an image parsed for you.
import { clear, el } from '../dom.mjs';
import { requestJson } from '../api.mjs';
import { withMutationId } from '../mutation.mjs';

/**
 * Sketch types the server will store, mirrored from `SKETCH_TYPES` in lib/mindmap.mjs.
 *
 * Raster only: SVG is a script-carrying document and was being served back from this app's
 * own origin. One list feeds both the picker's `accept` and the check on the chosen file, so
 * the hint and the rule cannot drift apart.
 */
const SKETCH_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const readAsDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('could not read that file'));
  reader.readAsDataURL(blob);
});

/** Longest edge after the first downscale. A whiteboard photo stays legible well below this. */
const MAX_EDGE_PX = 2048;
/** Each further attempt shrinks the longest edge by this much. */
const EDGE_STEP = 0.8;
/** Enough attempts to bring a 12-megapixel phone photo under the limit; then give up honestly. */
const MAX_ATTEMPTS = 6;
const JPEG_QUALITY = 0.82;

/**
 * Decode from a DATA url, never a blob: one.
 *
 * `URL.createObjectURL` is the obvious way to do this and it does not work here: this
 * app's CSP is `img-src 'self' data:` (guard.mjs, rule 12), so a blob: source is refused
 * and the load fails as an indistinguishable `error` event. Caught by driving the page,
 * not by the suite — there is no DOM and no CSP in a node:test run, so every unit test
 * would have gone on passing.
 */
const loadImage = (dataUrl) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('that file is not an image the browser can read'));
  img.src = dataUrl;
});

const encode = (canvas) => new Promise((resolve, reject) => {
  canvas.toBlob(
    (blob) => (blob ? resolve(blob) : reject(new Error('the browser could not encode the resized image'))),
    'image/jpeg',
    JPEG_QUALITY,
  );
});

/**
 * Shrink a photo until it fits the server's sketch limit (assessment finding F9).
 *
 * WHY here and not a bigger limit on the server: a sketch travels base64-encoded inside a
 * JSON body, so 8 MiB of image was ~11 MB of request against a 1,000,000-byte cap — every
 * phone photo was refused, and raising the cap would mean buffering 11 MB per request for
 * a feature used a few times a week. The photo of a whiteboard only has to be legible.
 *
 * Returns the original blob untouched when it already fits: re-encoding a small sketch
 * would cost quality for nothing.
 */
async function prepareSketch(file, limitBytes) {
  const original = await readAsDataUrl(file);
  if (file.size <= limitBytes) return { dataUrl: original, bytes: file.size, resized: false };

  const img = await loadImage(original);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  let edge = MAX_EDGE_PX;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const scale = Math.min(1, edge / Math.max(img.width, img.height));
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    context.drawImage(img, 0, 0, canvas.width, canvas.height);

    const encoded = await encode(canvas);
    if (encoded.size <= limitBytes) {
      return { dataUrl: await readAsDataUrl(encoded), bytes: encoded.size, resized: true };
    }
    edge = Math.round(edge * EDGE_STEP);
  }

  // Say so rather than upload something that will be refused: a 413 arriving after the
  // recall work is the failure this whole function exists to prevent.
  throw new Error('that image could not be shrunk far enough to upload — try a smaller photo');
}

function resultsView(root, result, onDone) {
  root.append(el('div', { class: 'crumb' }, 'Studydeck / Mind Map / Diff'));

  const head = el('div', { class: 'card' });
  head.append(el('div', { class: 'cap' }, 'Recall diff'));
  head.append(el('h2', { class: 'score-line' },
    `${result.total - result.missed.length} / ${result.total}`));
  head.append(el('p', { class: 'q-hint' },
    `${Math.round(result.run.recall_rate * 100)}% recalled from memory. ` +
    (result.note ? 'Diff saved to Open Notebook as a note.' : '')));
  if (result.note_error) {
    head.append(el('p', { class: 'q-error' }, `Note not saved: ${result.note_error} (the run itself was recorded)`));
  }
  root.append(head);

  const gaps = el('div', { class: 'card', style: 'margin-top:18px' });
  gaps.append(el('div', { class: 'cap' }, `Gaps · ${result.missed.length} — tomorrow’s study targets`));
  if (result.missed.length === 0) {
    gaps.append(el('p', { class: 'q-hint' }, 'Nothing missed on this pass.'));
  } else {
    for (const concept of result.missed) {
      const row = el('div', { class: 'qrow' });
      const label = el('span', {}, concept.name);
      label.append(el('span', { class: 'who' }, ` · ${concept.domain}`));
      row.append(label, el('span', { class: 'pill hot' }, 'missed'));
      gaps.append(row);
    }
  }

  const actions = el('div', { class: 'q-actions' });
  const done = el('button', { class: 'btn primary', type: 'button' }, 'Back to Mind Map');
  done.addEventListener('click', onDone);
  actions.append(done);
  gaps.append(actions);
  root.append(gaps);
}

export function renderMindMap(root, state, { topic }) {

  const showStudio = async () => {
    clear(root);
    root.append(el('div', { class: 'crumb' }, `Studydeck / Mind Map — ${topic.name}`));
    root.append(el('div', { class: 'loading' }, 'Loading the map…'));

    let preflight;
    try {
      preflight = await requestJson(`/api/mindmap?topic=${encodeURIComponent(topic.slug)}`);
    } catch (err) {
      clear(root);
      const panel = el('div', { class: 'error-panel' });
      panel.append(el('h2', {}, 'Could not load the map'), el('pre', {}, err.message));
      root.append(panel);
      return;
    }

    clear(root);
    root.append(el('div', { class: 'crumb' }, `Studydeck / Mind Map — ${topic.name}`));

    const intro = el('div', { class: 'card' });
    intro.append(el('div', { class: 'cap' }, 'Sketch first, then name what you recalled'));
    intro.append(el('p', { class: 'q-hint' },
      'Draw the concept map from memory before submitting. Name only the concepts you can recall; ' +
      'the authoritative map and comparison guidance appear after this run is recorded.'));

    let sketchDataUrl = null;
    const fileInput = el('input', { type: 'file', accept: SKETCH_TYPES.join(','), class: 'q-input' });
    const preview = el('div');
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;

      // `accept` is a picker hint, not a gate: "All Files" in the OS dialog and drag-drop
      // both walk straight past it. Checking here turns a rejection that would otherwise
      // arrive when the whole run is submitted — after the recall work, at the worst
      // possible moment — into one at the moment of choosing. The server stays the
      // authority (lib/mindmap.mjs); this is about when you find out, not whether.
      if (!SKETCH_TYPES.includes(file.type)) {
        sketchDataUrl = null; // else a rejected pick silently submits the PREVIOUS file
        clear(preview);
        preview.append(el('span', { class: 'q-error' },
          `${file.type || 'that file'} is not a photo — PNG, JPEG or WebP only.`));
        return;
      }

      try {
        clear(preview);
        preview.append(el('span', { class: 'q-hint' }, 'Preparing the photo…'));

        // The server's limit is on decoded bytes and arrives with the preflight, so there is one
        // number and the browser respects it here — rather than the server refusing the
        // photo after the whole recall run is submitted (F9).
        const sketch = await prepareSketch(file, preflight.sketch_limit_bytes ?? Infinity);
        sketchDataUrl = sketch.dataUrl;

        clear(preview);
        const img = el('img', { class: 'sketch-preview', alt: 'your sketch' });
        img.src = sketchDataUrl;
        preview.append(img);
        if (sketch.resized) {
          preview.append(el('div', { class: 'q-hint' },
            `Resized from ${Math.round(file.size / 1024)} KB to ${Math.round(sketch.bytes / 1024)} KB for upload.`));
        }
      } catch (err) {
        sketchDataUrl = null; // same reason as above — a failed read must not keep the old one
        clear(preview);
        preview.append(el('span', { class: 'q-error' }, err.message));
      }
    });
    intro.append(el('div', { class: 'q-hint', style: 'margin-top:12px' }, 'Optional — attach a photo of your sketch:'));
    intro.append(fileInput, preview);
    root.append(intro);

    const card = el('div', { class: 'card', style: 'margin-top:18px' });
    card.append(el('div', { class: 'cap' }, 'What do you recall?'));
    const recalledNames = el('textarea', {
      class: 'q-input', rows: '6',
      placeholder: 'One concept name per line, from your sketch and memory',
    });
    card.append(el('p', { class: 'q-hint' },
      'Do not look up the curriculum while writing this. Blank is allowed; unknown names are not silently corrected.'));
    card.append(recalledNames);

    const actions = el('div', { class: 'q-actions' });
    const save = el('button', { class: 'btn primary', type: 'button' }, 'Save diff');
    save.addEventListener('click', async () => {
      save.disabled = true;
      save.textContent = 'Saving…';
      actions.querySelector('.q-error')?.remove();
      try {
        // Cleared on success, so a genuinely second recall run mints a fresh id and is
        // recorded as the separate run it is.
        const request = {
          topic_slug: topic.slug,
          recalled_names: recalledNames.value.split('\n').map((name) => name.trim()).filter(Boolean),
          sketch: sketchDataUrl,
        };
        const result = await withMutationId(`mindmap:${topic.slug}`, (mutationId) =>
          requestJson('/api/mindmap/run', { method: 'POST', body: { ...request, mutation_id: mutationId } }),
        { payload: request });
        clear(root);
        resultsView(root, result, showStudio);
      } catch (err) {
        save.disabled = false;
        save.textContent = 'Save diff';
        actions.append(el('span', { class: 'q-error' }, err.message));
      }
    });
    actions.append(save);
    card.append(actions);
    root.append(card);
  };

  showStudio();
}
