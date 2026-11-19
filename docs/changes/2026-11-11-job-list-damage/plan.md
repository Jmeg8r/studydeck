---
change: 2026-11-11-job-list-damage
status: accepted
track: T2
intent: ./intent.md
spec: ./spec.md
accepted_by: james
linear: pending
---
# Plan: one damaged job file stops blocking the video and Higgsfield job lists

## Files that change

- **`app/lib/videogeneration.mjs`**, inside `createVideoService` (spec R1–R5):
  - A module constant `VIDEO_JOB_DAMAGED = 'Video job state is damaged'`.
  - A private `read(id)` that returns `null`, `{ damaged: true }`, or `{ job }`. The
    restart rewrite moves into it.
  - `get` becomes `read`, plus a throw on damage.
  - `list` maps damage to `{ id, status: 'damaged', error: VIDEO_JOB_DAMAGED }`. It sorts
    dated jobs by `created_at` descending, then markers by `id`.
  - `start`'s replay search skips markers. One comment names the gap from spec F2.
- **`app/lib/higgsfield.mjs`**, inside `createHiggsfieldService`: the same change, with
  `HIGGSFIELD_JOB_DAMAGED = 'Higgsfield storyboard state is damaged'`.
- **`app/test/videogeneration.test.mjs`** and **`app/test/higgsfield.test.mjs`**: unit
  tests for A1–A4.
- **`app/test/jobdamageroutes.test.mjs`** (new): the route test for A3 and A5, through
  `handleRequest`. It follows `localmedia.test.mjs`'s setup: the env vars are set before
  `router.mjs` is imported dynamically, the server listens on an ephemeral `127.0.0.1`
  port, and the temp root is removed in `after`.
- **`docs/changes/2026-11-11-job-list-damage/plan.md`**: run results and any
  **Deviations**.

`app/router.mjs` and the views do not change (R6).

## Order of work

1. **Red, unit.** Add the tests below to both unit files. Damaged files are made with the
   existing tests' recipe (a primary of `{` with no `.bak`, or a `.bak` of `{` with no
   primary).
   - `list` with one healthy job and one damaged file returns `[healthy, marker]`, with
     the exact message (A1).
   - Two healthy jobs and two damaged files order as dated-desc, then markers by `id` (A2).
   - `get(damagedId)` throws with status 500 (A3).
   - `start` with the healthy job's `mutation_id` returns it, and the injected
     render/prepare is never called. A different notebook gives 409. A fresh id starts a
     new job, and the test waits for it to settle (A4).

   Run `npm test`. A1, A2 and A4 must fail on the 500. A3 passes, as a control. Commit
   `test(videos): a damaged job file in the job lists, red`, with the failing-test counts
   from the run in the message.
2. **Red, routes.** Write `jobdamageroutes.test.mjs`:
   - Env: `STUDYDECK_VIDEO_DIR` is a temp shelf, `STUDYDECK_LEARN_ROOT` is an empty temp
     dir, `STUDYDECK_ON_BASE_URL=http://127.0.0.1:9`, and `STUDYDECK_ON_PASSWORD` is a
     fake.
   - Seed one healthy job (status `completed` for video, `prepared` for Higgsfield, with a
     known `mutation_id` and `notebook_id` matching the configured
     `ai-agent-design-patterns` topic) and one damaged file, in
     `<shelf>/.video-renders/<uuid>/job.json` and `<shelf>/.higgsfield-prep/<uuid>.json`.
   - Assert that both list GETs answer 200 with the marker (A5), and both detail GETs for
     the damaged id answer 500 (A3).
   - Assert that both start POSTs with the seeded `mutation_id` answer 202 with the seeded
     id (A5).
   - Assert that both start POSTs with a fresh `mutation_id` answer 202 with a new id.
     That job's first step calls Open Notebook at port 9, which refuses the connection, so
     it fails fast without calling ollama or TTS. The test polls the detail route until
     the job leaves `running` before `after` removes the temp root.
   - POSTs send `content-type: application/json` and a loopback `Host`, per rule 12.

   Run `npm test`. The list and start cases must fail on 500, and the detail cases pass
   as controls. Commit `test(videos): job list and start routes with a damaged job file,
   red`, with the run in the message.
3. **Green.** Make the two service changes. Run `npm test`. Everything passes, including
   `higgsfieldview.test.mjs` and the existing service tests, unchanged. Commit
   `fix(videos): a damaged job file no longer blocks the job lists`, with the run in the
   message.
4. **VERIFY.** Run `npm test` with `node_modules` absent, `npm run verify` if it exists,
   and the live check (Proof). Record the results in this file
   (`docs(plan): record the green run for job-list-damage`).

## Risks

- **A job file that parses but is not a job object** (`[]`, `"x"`, or no `created_at`)
  is not damage under spec R1: `readJsonSafe` returns `source: 'primary'`. It still makes
  `list()` throw in the sort, as it does today. That is outside this slice. It is named
  under **Options not taken** and offered as a follow-up, not fixed silently.
- **The route test starts real jobs.** It is bounded by the port-9 Open Notebook and the
  settle-poll. If `collectSources` ever stops calling Open Notebook first, the test could
  reach ollama. The test header says so.
- **Spec A6 becomes a code-review item.** There is no per-entry seam where a non-damage
  error can be injected without adding production code. R5 rests on the structure: `list`
  has no `try`/`catch`. The red/green runs show markers only for `fallback` files. Codex
  and the security review are asked to check it.

## Proof

- `npm test`: the red runs in steps 1 and 2, then a full green run.
- `mv node_modules /tmp/nm-off` if it exists, then `npm test`, then move it back. Or
  confirm it is absent (rule 5).
- Live check:
  - `rm -rf /tmp/learn && mkdir -p /tmp/learn && cp -R .learn/topics/. /tmp/learn/`
  - Seed `/tmp/studydeck-videos` with one healthy and one corrupt file per service.
  - Port 4320 comes from a scratchpad copy of `cockpit.config.json` passed with
    `STUDYDECK_CONFIG_PATH`, as in chapter-render-routes, because there is no port env
    var and the real cockpit holds 4310:
    `STUDYDECK_CONFIG_PATH=<copy> STUDYDECK_LEARN_ROOT=/tmp/learn STUDYDECK_VIDEO_DIR=/tmp/studydeck-videos node app/server.mjs`
  - `curl -s -H 'Host: 127.0.0.1:4320' 127.0.0.1:4320/api/videos/jobs` and
    `.../api/videos/higgsfield` both show 200, the healthy job, and the marker.
  - No start POST is sent live. The route test covers it, and a live one would call real
    Open Notebook.

## Options not taken

- Catching 500s in `list()`. Rejected in spec F1.
- Treating a wrong-shape job file as damage. That needs a validator per job type, which
  is a separate slice.
- A view notice for damaged entries. Out of scope per the intent.

## Results

- **Red, unit** (`7e1d36f`): 17 tests, 9 pass, 8 fail. All 8 failures throw the damage
  error (4 video, 4 Higgsfield). Both `get` controls pass.
- **Red, routes** (`c543a30`): 8 tests, 2 pass, 6 fail. Each failure is the route answering
  500 with the damage error. Both detail-route controls pass.
- **Green** (`80821d8`): `npm test` with `node_modules` absent gives 937 tests, 937 pass,
  0 fail. `npm run verify` reports "No damage found", exit 0.
- **Live, 2026-11-11, port 4320:** the config copy was passed with `STUDYDECK_CONFIG_PATH`,
  with `STUDYDECK_LEARN_ROOT=/tmp/learn` and `STUDYDECK_VIDEO_DIR=/tmp/studydeck-videos`,
  and one healthy and one corrupt (`{`) file per service.
  - `GET /api/videos/jobs` answered HTTP 200, with the healthy job, then
    `{"id":"22222222-…","status":"damaged","error":"Video job state is damaged"}`.
  - `GET /api/videos/higgsfield` answered HTTP 200, with the healthy storyboard, then the
    marker with `Higgsfield storyboard state is damaged`.
  - `GET /api/videos/jobs/22222222-…` answered HTTP 500, as before.
  - The server was stopped and port 4320 freed. No start POST was sent live.
- **Spec A6** is a code-review item, as planned. `list` and `listJobs` contain no
  `try`/`catch`.

## Review

- **Security review** (read-only Sonnet subagent, 2026-11-11): one low finding, and
  everything else checked and cleared.
  - *Cleared:* the marker leaks nothing (fixed message, id already matched against
    `^[a-f0-9-]{36}$`, no path or file text). Only `fallback` becomes a marker, so other
    exceptions still propagate. Replay and the 409 hold, with the documented F2 gap only.
    `get()` still answers 500. The route test reaches only its owned socket, so no ollama
    call and no password exposure. Guard and CORS are untouched, and rules 5 and 8 are
    unaffected.
  - *L1 (low), answered:* the views now hide a damaged job that used to surface as a list
    error. If the damaged file held a notebook's newest `failed` or `prepared` storyboard,
    the view shows the older state or none. This is the "No UI change" scope James chose
    (intent, *Out of scope*; spec R6). The fault stays visible at the API. A view notice is
    offered as a follow-up, not added here.
- **Codex** on `a839ad0`: `NO_FINDINGS`, GATE: PASS. The run after this record is on the
  PR.

## Deviations

- **Step 2, Open Notebook stub.** The route test points Open Notebook at a socket it owns
  and hangs up on, as `degradation.test.mjs` does, not at `127.0.0.1:9`. A fixed port can
  be taken by another service, which would then receive the fake password. A socket the
  test owns can't be, and the reset fails the job at once.
- **Step 2, topic trees.** The start and list routes read each topic's `state.json` for
  its name, so the test seeds a minimal tree per configured topic. The first red run failed
  on ENOENT for that file, not on the damage, and was not committed.
- **Step 3, one shared list helper.** The plan put a full `list` in each closure. Instead,
  `listJobs(ids, read, damagedMessage)` is exported from `videogeneration.mjs`, and
  `higgsfield.mjs` imports it beside `collectSources`, which it already imported from there.
  The sort rule (dated jobs newest first, then markers by `id`) lives in one place instead
  of two. Each service keeps its own `read`, `get`, message constant and replay guard.
