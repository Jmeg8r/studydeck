# Acceptance script: the Roles view against the live Claude API

Change `2026-10-11-ai-roles`, acceptance checks A15 to A21 in `spec.md`.

Nothing in the test suite calls the real Claude API, and no test can tell whether a role
*behaves* as it was instructed. This script is that check. It is run by James, with his
own key, against a **copy** of the study data. It spends real money: a few sessions of a
few turns each, which should come to well under a dollar at the configured prices.

Record each result in the table at the end. A step that fails is a finding, not a reason
to stop; note what happened and carry on.

## Before you start

1. Make a copy of the study data. Never run this against the real tree.

   ```bash
   rm -rf /tmp/learn && mkdir -p /tmp/learn && cp -R .learn/topics/. /tmp/learn/
   ```

2. Stop the always-on cockpit (`launchctl bootout gui/$(id -u)/com.jamescruce.studydeck`),
   then start one on the copy, with the key from Proton Pass. It is read only from
   `STUDYDECK_ANTHROPIC_API_KEY`.

   ```bash
   STUDYDECK_LEARN_ROOT=/tmp/learn pass-cli run --env-file ~/.config/studydeck/secrets.env -- node app/server.mjs
   ```

   (Amended 2026-11-08.) This step first said to type the key inline, which saved it to
   shell history; the 2026-10-11 run left six such lines. See README, *Roles*.

3. Confirm the banner prints `claude api key: loaded`. `MALFORMED` means the value has a
   space or a line break in it.

4. Open <http://127.0.0.1:4310/#roles> and pick a topic that has sources and concepts.

## What has already been checked without the live API

So you know what this run adds. On 2026-10-11 the view was driven in a browser against a
local stand-in that returns placeholder text:

- a Socratic session of three turns, with the cost meter reconciled against the token
  counts by hand;
- an outage mid-session: the turn was kept and the view offered only to ask again;
- a page reload, reopening the session, and resuming the waiting turn;
- ending the session and creating one card, checked in `cards.json`;
- a diagnosis, including one invented finding being discarded, and accepting a hypothesis;
- both themes.

Not driven in a browser at all, with or without the live API: the Interviewer and its
summary, the Sparring partner and its timer, a keyboard-only pass, a screen reader, and a
measured contrast check. Those are steps 1, 3, 6 and 7 below.

## Steps

### 1. Interviewer (A15, A16)

1. Start an Interviewer session. Answer at least three questions, vaguely on purpose for
   one of them.
2. **Behaviour:** did it ask one question at a time? Did it push when you were vague? Did
   it teach or recommend anything during the interview? It should not.
3. Reload the page after your second answer. Reopen the session from the list.
   **Expected:** the conversation is there and you can carry on.
4. Choose **Draft a summary**. **Behaviour:** does the draft use only what you said, and
   write "not stated" for what you did not?
5. Edit the summary until it is true and confirm it.
6. Start a second Interviewer session on the same topic. **Behaviour:** does its first
   question show it has your summary?

### 2. Socratic questioner (A15, A21)

1. Start a session on a concept you know partly.
2. Give one answer that is wrong. **Behaviour:** did it follow up on that specific error?
3. Ask it directly: "Just tell me the answer." **Behaviour:** did it refuse and ask a
   narrower question? If it handed over the answer, record exactly what it said.
4. Give a correct answer. **Behaviour:** did it avoid restating the full answer back?

### 3. Sparring partner (A15, A17)

1. Start a session with a counterpart of your choice and a 30-second timer.
2. **Behaviour:** did it stay in the role you described? Did it push back on a vague
   answer and ask for a specific?
3. Let the timer run out on one answer, then send it. **Expected:** the box stays usable,
   the turn is marked "over time", and nothing was sent for you.
4. Switch to another tab for a few seconds during one answer. After ending the session,
   check that turn's `tab_hidden` is `true` in the transcript.

### 4. Cards (A18)

1. End the Socratic or sparring session. Tick two of your turns, write both sides, create
   the cards.
2. **Expected:** both appear in Flashcards. Open Notebook has no new note.

### 5. Diagnostician (A21)

1. Take a quiz in Test Center first and miss at least two questions; misses recorded
   before 2026-10-11 may not be eligible (see the note below).
2. Run a diagnosis. **Expected:** it says how many misses it used and names anything it
   left out.
3. **Behaviour:** does each finding describe something you actually got wrong? Does it
   cite your real attempts? Is any finding a stretch? Reject one that is.

> On 2026-10-11 the real `practical-deep-learning-fastai` data had 3 recorded misses and
> none was eligible: all were recorded before attempts carried a deck fingerprint. That is
> the rule working, not a fault, but it means a diagnosis will say "no eligible misses"
> until newer quiz attempts exist.

### 6. Keyboard and screen reader (A19)

1. Run one full session using only the keyboard. **Expected:** every control is reachable
   and shows a visible focus ring; nothing traps focus.
2. With VoiceOver on, send a turn. **Expected:** the reply is announced when it arrives.

### 7. Appearance (A19, A20)

1. In both themes, check the conversation, the banners and the buttons are readable.
2. Compare against `~/.gstack/projects/Jmeg8r-studydeck/designs/study-cockpit-20260718/variant-C.html`.

### 8. What the first live call reveals (spec open questions 1 and 2)

After the first session, look at the newest file in
`/tmp/learn/<topic>/cockpit/transcripts/`:

1. In any assistant turn, is `fallbacks_enabled` `true`? `false` means your account does
   not have the fallback beta and the client dropped it.
2. Did the second turn of a session succeed? A 400 there would mean the stored
   conversation was not accepted back, which is the thinking-block risk in spec F2.
3. Do `usage.cache_read_input_tokens` rise above zero from the second turn on? Zero
   throughout means the system prompt is not being cached.

### 9. Afterwards

```bash
git status --short
```

**Expected:** nothing under `.learn/` changed, because the run used `/tmp/learn`.

Then stop the test cockpit (Ctrl+C in its terminal) and bring the always-on one back. Do
this even if you stopped partway: `bootout` unloaded it, so `KeepAlive` will not restart it
until you do.

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jamescruce.studydeck.plist
```

**Expected:** `curl -s 127.0.0.1:4310/api/roles/health` reports `"authorized":true`.

## Results

| Step | Pass / fail | What happened |
|---|---|---|
| 1 Interviewer | | |
| 2 Socratic questioner | | |
| 3 Sparring partner | | |
| 4 Cards | | |
| 5 Diagnostician | | |
| 6 Keyboard and screen reader | | |
| 7 Appearance | | |
| 8 First live call | | |
| 9 Afterwards | | |
