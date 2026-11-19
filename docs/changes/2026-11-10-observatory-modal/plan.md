---
change: 2026-11-10-observatory-modal
status: accepted
track: T1
accepted_by: james
intent: ./intent.md
linear: pending
---
# Plan: the Observatory is a real modal dialog

## Files that change

- `app/test/observatory.test.mjs` (new): the dialog contract, with a minimal DOM stub.
- `app/web/js/views/observatory.mjs`: `dialog`, `showModal`, labels, focus, dismissal.
- `app/web/css/app.css`: reset the user-agent dialog box so it still fills the window;
  hide it when not open; style the backdrop.

## Order of work

1. **Commit 1, tests only** (`test(observatory): ...`). A DOM stub small enough to live in
   the test file (the snapshot's `fixtures/dom.mjs` is not on `main`), with a `dialog`
   whose `showModal`/`close` set `open` and fire `close`. Tests:
   - opening appends a `DIALOG` that is open, has `aria-labelledby` pointing at the
     masthead's id, and focus is on the close button, which has an `aria-label`;
   - the close button closes it, removes it from `body`, and returns focus to the launcher;
   - a `close` event from the dialog itself (what Escape produces natively) does the same;
   - a `hashchange` closes it;
   - a click whose target is the dialog (the backdrop) closes it; a click inside does not.
   Against `main`, the dialog and focus cases must fail.
2. **Commit 2, the fix** (`fix(observatory): ...`), following the snapshot's shape:
   - remember `document.activeElement` as the launcher before building;
   - `el('dialog', { 'aria-labelledby': 'observatory-title' })`, masthead `id`, close
     button `aria-label: 'Close Observatory'`;
   - all dismissal routes call `overlay.close()`; one `close` listener removes the node,
     removes the `hashchange` listener and restores focus. The document `keydown` listener
     goes, because the native dialog handles Escape;
   - render the wheel only if the dialog is still open when the microtask runs;
   - CSS: `width/height/max-*: 100vw/100dvh/none`, `margin: 0`, `border: 0`,
     `.observatory:not([open]) { display: none; }`, a dark `::backdrop`.
   - Run the file, then `npm test` with no `node_modules`, then `npm run verify`.
3. **Browser check** against a `/tmp/learn` copy through the scratch launcher: open from
   Today with the keyboard, Tab cycles inside, Escape / ✕ / backdrop / Back each close it
   with focus back on the wheel button, and the desktop layout matches the current one.
4. PR through `forge-pr create`, `/gstack-codex review origin/main` posted verbatim, the
   AI gate, James's merge approval.

## Risks

- **User-agent dialog styles** (centred, bordered, max-size limited) would shrink the
  Observatory if any reset is missed. The browser check compares it with the current one.
- **The stub is not a browser.** It proves the wiring, not that `showModal` makes the page
  inert or traps Tab; the browser check proves those.

## Proof

- **Commit 1** (`86f7dd5`): against `main`, with no `node_modules`, 5 run and 4 fail, each
  for the stated reason: the overlay is a `DIV`; focus never moved off the launcher; nothing
  listens for `close`; a hash change leaves it open. The backdrop case passes, because
  `main` already handles it, and stays as a regression guard. The first draft of the
  close-button case also passed vacuously (focus never left the launcher, so "focus is back
  on the launcher" held); it now asserts focus moved in first.
- **Commit 2** (`f75cf0b`): `observatory.test.mjs` 5 pass. `npm test` 569 pass, 0 fail, no
  `node_modules`. `npm run verify` finds no damage.
- **Browser check**, 2026-11-10: the worktree's router on port 4319 over a `/tmp/learn`
  copy, Open Notebook pointed at a dead port, viewport 1280x800. Opened from Today with
  Enter on the focused wheel button: one `DIALOG`, `:modal`, named "The Study Observatory",
  focus on "Close Observatory". Seven Tabs kept focus inside it. Escape, a real click on ✕,
  and a real click on the dialog's bottom-left padding each closed it with focus back on
  the wheel button. Back from Today to Stats closed it; focus went to `body`, because the
  re-rendered view has a new wheel button and the old one is gone. Against the live
  cockpit on 4310 (opening the Observatory writes nothing), the box and the wheel match:
  1265x800, wheel at (308, 105), 650 wide.

## Deviations

- **The dialog is sized by `inset: 0` with `width/height: auto`, not `100vw`/`100dvh`**,
  found by the browser comparison. `100vw` counts the page's scrollbar strip, so the
  dialog was 1280 wide where the old overlay was 1265 and the wheel sat 7px right of where
  it was. Auto size against the existing `inset: 0` gives the old box exactly.
- **The test commit's message was briefly wrong.** A hook stopped the command that would have
  rewritten the message file, so the test commit first went in with the acceptance
  message. It was unpushed and was amended to the test message before anything else.

## Options not taken

- **Port the snapshot's concept picker in this slice.** It is the keyboard route into the
  wheel and belongs with the wheel accessibility slice, where it can be judged with the
  cell focus it complements.
- **Port `fixtures/dom.mjs` as a shared fixture.** Only this test needs it today; a shared
  fixture can be extracted when a second view test arrives.
