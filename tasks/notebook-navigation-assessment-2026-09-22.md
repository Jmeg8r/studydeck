# Notebook navigation assessment

## Current behavior

StudyDeck has two configured topics. Each topic has an Open Notebook notebook ID in `app/cockpit.config.json`. The cockpit presents eleven study views in a 212 px left rail, with a native topic select in the rail footer. That select governs the single-topic tools, but it sits below the tool list, truncates long names, and is below the fold in a shorter window. The two topics are also visible near the bottom of Today, but those rows control schedule start and pause rather than direct navigation.

`workingTopic` in `app/web/js/topic.mjs` stores the learner's choice in local storage. On a fresh browser it falls back to Today's recommended topic, then the first topic. The chosen topic applies to Reading, Mind Map, Fact-Check, Practice Lab, Teachback, Essay, and Debrief. Today, Flashcards, and Test Center intentionally retain cross-topic behavior. A navigation design should preserve that distinction, show which notebook is open, and avoid suggesting that the entire cockpit has become a notebook filter.

Google's [Gemini notebooks documentation](https://support.google.com/gemini/answer/16972047) places a named **Notebooks** section in the sidebar. Google's [product announcement](https://blog.google/intl/en-ie/products/notebooks-gemini-notebooklm/) describes notebook-specific chats and sources in that space. The transferable idea is an always-visible notebook list with a clear active choice. StudyDeck already has topic selection and notebook mapping, so the design does not need a new notebook data model to solve this navigation problem.

## Options

Open the [interactive mockups](./notebook-navigation-concepts-2026-09-22.html) and select A, B, or C. Notebook clicks and view clicks work within the preview; no study data is written.

| Concept | Strength | Cost |
| --- | --- | --- |
| A. Notebooks in rail | Direct switch in one click while studying; closest to Gemini's sidebar pattern | The rail needs a scrollable tools region when vertical space is short; short labels in the rail need full names in the page heading and accessible label |
| B. Split workspace | Gives notebooks and tools separate persistent columns | Uses 400–480 px before study content at desktop widths, which crowds reading and practice |
| C. Notebook home | Useful overview if the topic catalog grows | Returning to the list takes an extra step during a study session |

## Recommendation

Choose **A** for the present two-topic cockpit. Put a **Notebooks** heading and two explicit notebook rows above the study tools. Indicate the selected notebook with the existing amber treatment, show its status as a secondary line, and display the full title in the main heading. Keep the view navigation below it. On narrow screens, put the notebook choices above the page as a horizontally scrollable control rather than hiding them in the rail footer.

Implementation would reuse `workingTopic` and `setWorkingTopic`, and keep the current fresh render surface that prevents a late response from showing the previous topic after a switch. Remove the redundant footer select once the new control handles the same choice. Label the selected notebook as **working notebook**; keep Today's schedule recommendation as a separate fact. When only one topic exists, show its identity without a switch control. When there are many topics, the notebook region should scroll independently of the tools, and search can be considered when the list actually needs it. No `state.json` or Open Notebook mutation is involved in switching.

The mockup's status text is a snapshot of the local cockpit on 22 September 2026, not a live feed. Actual implementation should draw names and schedule status from `/api/state` and use existing `workingTopic` resolution.
