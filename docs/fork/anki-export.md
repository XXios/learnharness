# Fork plan: Anki export of long-term anchors

Status: **approved concept, not yet planned at implementation level** (grilled 2026-10-26/27). Fork-only document (`XXios/learnharness`).

## Goal

LearnHarness builds understanding (teaching) and makes it usable (practice), but nothing schedules spaced review over months. This feature hands the **long-term anchors** of selected sessions to Anki, which owns the scheduling, and keeps the Anki workload small.

## Approved decisions (do not re-litigate)

| # | Decision | Rejected alternative + why |
|---|---|---|
| A1 | **Anki owns all scheduling.** LearnHarness only picks and words the cards. Practice sessions stay unchanged. | LearnHarness's own scheduler (breaks "stores ideas, not ratings of ability"). Reading Anki results back in: maybe later. |
| A2 | **Cards come from knowledge-graph propositions.** | A fresh pass over the transcript: no stable IDs, and one idea taught in three sessions would become three cards. |
| A3 | **Delivery: a `.txt` export first, AnkiConnect push later**, both behind the same export step. AnkiWeb has no public API. AnkiConnect (desktop add-on, `localhost:8765`) is the only direct route. | `.apkg`: more work for little gain. |
| A4 | **Only when you ask, and selective.** No automatic or end-of-session suggestions. LearnHarness remembers what has already been carded. | Suggestions at session end, or a continuous background pass. |
| A5 | **What you select: sessions and imported notes files** (= graph birth clusters, `src/core/session-clusters.ts`). The graph has no topic/module hierarchy. | Selecting nodes in the graph (later), a new "topic" grouping (new structure). |
| A6 | **Card records live in a new file that's only ever added to** (e.g. `data/anki/cards.jsonl`): proposition id → GUID, deck, date, card text, state (`exported` / `declined`). The graph is never written to. | Fields on graph nodes: the extraction pipeline is the graph's only writer. |
| A7 | **Unticked cards are remembered as `declined`** and come back only through a "show declined" toggle. | Re-curating from scratch every time: you'd reject the same cards again on every export. |
| A8 | **One `LearnHarness` deck**, tagged `learnharness` + the session. | A subdeck per session: titles change, and a mixed deck matches the practice doctrine's interleaving. |
| A9 | **Context on every card:** a short, concrete context line written by the curator (e.g. *"Thermodynamics › Carnot cycle — ideal reversible heat engine"*, not just the session title), **plus** a question that makes sense on its own. | Session title only (too vague). |
| A10 | **Stock card types** `Basic` / `Basic (and reversed card)` (reversed only for real term↔definition pairs). The context is a separate styled first line on the front. The back has the answer plus a plain-text source line `LearnHarness · <session title> · <date>`. | A custom card type: a `.txt` import can't create one. Revisit when AnkiConnect lands. A `learnharness://` deep link: there's no link handler. |
| A11 | **What counts as card-worthy (anchors):** terms ↔ definitions, named results/laws/formulas, key conditions/values, the premises central chains rest on. **Not:** why/explain questions, derivations, worked examples, multi-sentence answers, anything that follows trivially from another card. **Coverage goal:** the smallest set that still lets the learner rebuild the whole idea; the curator works through the session's main chains. | Curator judgment with no rule. |
| A12 | **Limit:** about 8 cards per session normally, at most 15. Every card past 8 shows a coverage reason in the review list. The limit counts the **session's total over all exports**. A reversed pair counts as 1. Both numbers can be changed in settings. | No limit, a per-export limit, a reviews-per-day limit (Anki already has one). |
| A13 | **Exporting a session again** suggests only propositions that were never carded or declined, within the remaining limit. Existing cards are never reworded unless you ask. | Re-curating the whole set. |
| A14 | **Each export file holds only cards never exported before** (`learnharness-anki-<date>.txt`, with Anki headers: separator, html, notetype column, deck column, tags, GUID column). Importing therefore never overwrites edits or history in Anki. | One cumulative file: re-importing a GUID overwrites edits made in Anki. |
| A15 | **A new background role `cardCurator`**, with its own model setting in Agent settings. Its default slot is the same as `extractor`'s. | Reusing `extractor`: it's a different judgment. |
| A16 | **Where you start:** an "Anki" button on the home/graph view next to Import notes → session/notes picker → curation job → review list → export. | A sidebar right-click entry (later, leading into the same picker). |
| A17 | **Picker:** each row shows "never carded" or "N cards · last export <date>". Sessions not yet extracted (or with turns pending) are marked, with an "Extract first" action you start yourself. Extraction never runs automatically. | Extracting automatically, or hiding those sessions. |
| A18 | **Curation runs as a background job** (activity dock, cost meter). Its result is a **saved draft** until you export or discard it. | A foreground spinner that loses the work when closed. |
| A19 | **Review list:** every proposed card is ticked by default and editable inline. Extra cards show their coverage reason. | Exporting without review. |
| A20 | **File destination:** a native Save dialog that remembers the last folder. In the web/dev build it's a browser download. | A silent fixed folder. |
| A21 | **Card language = the session's language.** | A global language setting (maybe later). |
| A22 | **Merges:** when the auditor merges a proposition into another, the card record moves to the surviving node, so the card is never suggested twice. Deleted propositions: their Anki cards stay (a `.txt` import can't delete). | Orphan list or auto-delete: deferred to the AnkiConnect version. |
| A23 | **Settings:** a new "Anki" section (limits now, the AnkiConnect switch later). | Putting it inside the Graph section. |

## Out of scope for the first version (later)

- An AnkiConnect push, which also creates a proper `LearnHarness Basic` card type with Context/Front/Back/Source fields
- Automatic orphan cleanup
- A "card this node" action in the graph view
- A "Make Anki cards" entry in the sidebar's session right-click menu
- Reading Anki review results back in (e.g. for practice)

**Process rule (AGENTS.md):** any design or implementation question not answered here → STOP and ask the user. Never guess. Next step: an implementation-level plan (files, contracts, prompt wording for `cardCurator`), approved before any code.
