# Fork plan: Anki export (implementation level)

Status: **approved plan** (2026-10-27), implementation in progress on `feat/anki-export` (worktree `../learnharness-anki`). Fork-only document (`XXios/learnharness`). Concept and decisions A1–A23: `docs/fork/anki-export.md` (not re-litigated here). Structure follows `claude-code-subscription.md`: fork code lives in new files, and upstream-owned files only get small registration points.

## Implementation decisions (user, 2026-10-27)

| # | Decision |
|---|---|
| I1 | **Branch:** a worktree off `main`: `../learnharness-anki`, branch `feat/anki-export`. The uncommitted Claude Code work in the main checkout stays untouched. `docs/fork/anki-export*.md` are copied into the worktree. |
| I2 | **A22 needs no hook.** The auditor never merges two existing nodes. It only links a *new* extracted proposition to an *existing* node id (`mergeFindings`, `src/core/graph.ts:181`), and that id survives with its provenance unioned. Node ids only vanish through deletion (`graph-deletion.ts`). A card keyed by node id is therefore never suggested twice. A test pins this. **If upstream ever adds a node→node merge, hook it there** and append a ledger line for the survivor. |
| I3 | **Candidates = birth propositions only** (A5): a session's not-yet-carded, not-declined propositions whose `birthSessionOf` is that session. Propositions born elsewhere but used by the session's chains go to the curator as *context only*. |
| I4 | **Picker rows = every teaching chat + every imported notes file.** Practice chats are hidden. Most recently active first. |
| I5 | **Only exported cards count against the limit.** Declined cards use none. A re-ticked declined card uses budget like any other. |
| I6 | **15 is a hard cap.** Ticks that would push a session past the max are disabled ("limit reached — raise it in Settings › Anki"). |
| I7 | **One picker submit = one curation job = one draft = one file.** The curator runs once per session, in parallel, under the shared 3-slot background semaphore (`withBgLlmSlot`). A failed session shows its error in its own group; the other groups stay usable. |
| I8 | **At most one draft.** While a draft exists, the Anki button opens it. A new curation needs export or discard first. Export also re-checks the ledger. |
| I9 | **Commit point = file written (desktop) / response served (web).** A cancelled Save dialog records nothing. Ticked → `exported`, unticked curator cards → `declined`, in one append. Then the draft is deleted. Every export is also copied to `data/anki/exports/`. |
| I10 | **Anki settings are a fork file**, `data/anki/settings.json`, with its own route. Upstream settings code is not touched. |
| I11 | **Note type names are settings**, defaulting to `Basic` / `Basic (and reversed card)`, because Anki localizes them (e.g. German `Einfach`). |
| I12 | **Tags:** `learnharness learnharness::<title_slug>`. The slug comes from the title at export time. |
| I13 | **Source line:** `LearnHarness · <title> · <session start date YYYY-MM-DD>`. For notes: the file's **base name** and import date. |
| I14 | **cardCurator model:** an extra row, "Card curator", under Agent › Models. Unset reads "Same as Cheap". Stored as `agent.models.cardCurator` (existing override plumbing). |
| I15 | **Dock + cost:** small edits. A `curations` list in the activity feed, a dock blob with cost and abort, `kind:"curation"` on the abort route, and an "Anki cards" stage in the graph cost pill (usage from `data/anki/runs.jsonl`). |
| I16 | **Stale drafts are revalidated, never re-curated.** A card whose proposition was deleted shows greyed out ("source deleted"), unticked, not exportable, and gets no ledger line. A session with new propositions since curation shows a note only. |
| I17 | **Not-extracted rows:** zero propositions → not selectable, only **Extract first**. Turns pending → selectable, with the note "cards only from what's extracted so far" plus **Extract first**. |
| I18 | **Reversed notes:** the context line goes on **both** fields. Back = context + definition + source line. |
| I19 | **Verification:** you import into a **scratch Anki profile**; I never touch Anki data. Dev data = a one-time copy of this checkout's `data/` into the worktree, with the root `auth.json` symlinked. |

### Facts that make the listed edge cases trivial

- **Proposition edited after export:** cannot happen. A node's `name`/`statement` are fixed by its first ledger line, and link-appends only add aliases. The card text in Anki is the user's anyway (A13: never reworded).
- **Session renamed after export:** old cards keep their old tag and source line (they're frozen in Anki). The ledger keeps `sessionId`. New exports use the new title.
- **Session deleted (`delete-nodes`) after export:** the node may die (its Anki card stays, per A22) or re-attribute to another birth session. Either way the ledger line by node id keeps it from being suggested again.
- **Rewording exported cards (A13 "unless you ask"):** impossible in v1 by A14 (an exported GUID never goes into a file again). It comes with AnkiConnect.

## Proposed details: please confirm or correct while approving

These are my defaults for things not covered above. Each one is marked **[confirm]** where it's used below.

1. **GUID** = `lh_` + node id (e.g. `lh_n_3fa2c1d9e0b4`): deterministic, so re-building a file gives identical GUIDs.
2. **Deck name** = `LearnHarness` (fixed constant, A8).
3. **File name** = `learnharness-anki-<local YYYY-MM-DD>.txt`. The copy in `data/anki/exports/` gets `-2`, `-3`… on same-day collisions. The desktop dialog handles its own overwrite prompt.
4. **Math:** the curator writes LaTeX as `\(…\)` / `\[…\]` (Anki's MathJax syntax). The exporter also rewrites any stray `$…$` / `$$…$$` to that form.
5. **Settings ranges:** both limits are integers 1–50, with normal ≤ max (the PUT rejects normal > max with 400, and the sanitizer clamps normal down). Note type names: trimmed, non-empty, ≤ 100 chars, no tab/newline.
6. **Desktop last folder** stored in `userData/anki-export.json` (`{ lastFolder }`). The first default is `~/Downloads`.
7. **Curator input is graph-only** (A2): no transcript. Language (A21) follows the propositions, which the extractor wrote in the session's language.
8. **Curator prompt** lives in a fork TS file (like the extraction prompts). It is not user-overridable in v1 (prompt overrides only cover the conversation agents).
9. **UI copy:** as written in §UI below.

## Files

### New (fork-owned)

| File | Role |
|---|---|
| `src/core/contracts/anki.ts` | Types: `AnkiCardRecord`, `AnkiDraft`, `AnkiDraftGroup`, `AnkiDraftCard`, `AnkiCuratorCard`, `AnkiSettings`, `AnkiPickerRow`, `AnkiCurationRun`, `AnkiCurationActivity`, `AnkiStore` (port). Pure. |
| `src/core/anki/ledger.ts` | Pure fold over ledger lines: last line per node wins. Per-session exported/declined counts, last export date, budget (`remaining = max − exported`, `normalRemaining = max(0, normal − exported)`). |
| `src/core/anki/candidates.ts` | Pure: one session's candidates, context propositions and relevant chains from a `DerivedGraph` + ledger (I3). Also the stale-draft revalidation (I16). |
| `src/core/anki/export-format.ts` | Pure: draft cards → `.txt` (headers, HTML escaping, math normalization, tags/slug, GUIDs, reversed layout). Deterministic. |
| `src/core/anki/settings.ts` | `ANKI_FACTORY_SETTINGS`, `sanitizeAnkiSettings`, `resolveAnkiSettings`, `parseAnkiSettingsBody`. Browser-safe. |
| `src/core/anki/index.ts` | Barrel for the client-safe parts (types, settings resolver, budget helpers). |
| `src/store/anki.ts` | fs adapter for `AnkiStore` under `PATHS.data/anki/`: `cards.jsonl` (append-only), `draft.json` (tmp+rename), `runs.jsonl` (append-only), `settings.json`, `exports/`. Paths are derived from `PATHS.data` inside this file, so `config.ts` gets no new path. |
| `src/agent/anki/curator-prompt.ts` | `CARD_CURATOR_INSTRUCTIONS` + `curatorPrompt(input)` (the full text is in §Curator). |
| `src/agent/anki/curator.ts` | `runCardCurator(input, engine, signal, onStep)`. `runSubmitAgent` with role `cardCurator`, TypeBox schema, `validate` (§Curator), `maxTurns: 4`. |
| `src/agent/anki/curation.ts` | The job: registry on `globalThis` (the extraction-registry idiom), one `AbortController` per job, per-session calls under `withBgLlmSlot`, live usage, draft writes, `emit("activity-changed")`. |
| `src/server/anki.ts` | Composition: picker rows, start (refusal gates: `ModelsNotConfiguredError` / provider key, like extraction), draft read/patch/discard, export preview/commit, settings get/put, `curationActivity()`, `ankiCostRuns()`. |
| `app/api/anki/sessions/route.ts` | `GET` → `{ rows: AnkiPickerRow[], settings }` |
| `app/api/anki/draft/route.ts` | `GET` (draft + revalidation + declined rows on `?declined=1`), `POST {sessionIds}` (start → 202, 409 if a draft exists, 503 envelope on refusal), `PATCH {revision, edits}`, `DELETE` (discard; aborts a running job) |
| `app/api/anki/export/route.ts` | `POST {revision, deliver:"preview"}` → `{fileName, text, counts}` (no writes). `POST {revision, deliver:"commit", fileName}` → commit, `{ok, counts}`. `POST {revision, deliver:"download"}` → commit + `text/plain` attachment. 409 on a stale revision. |
| `app/api/anki/settings/route.ts` | `GET` / `PUT` (replace-whole, house discipline) |
| `components/anki/anki-client.ts` | Fetch helpers + `saveExport()` (desktop: `window.lh.anki.saveFile`; web: blob download) |
| `components/anki/anki-button.tsx` | The "Anki…" chrome pill + the modal host |
| `components/anki/anki-picker.tsx`, `anki-review.tsx` | The picker and the review list |
| `components/settings/anki-section.tsx` | Settings › Anki |
| `components/settings/card-curator-row.tsx` | The Agent › Models row (reuses `MenuTrigger`/`ModelMenuList`/`ThinkingMenuList`) |
| `electron/anki.cjs` | `registerAnkiIpc(ipcMain, app, dialog)`: `lh:anki:save {fileName, text}` → `showSaveDialog` (defaultPath = last folder / file name, filter `.txt`) → write → remember folder → `{saved:true, path}` / `{saved:false}` |
| `tests/anki-*.test.ts(x)` | §Tests |

### Edits to upstream-owned files (registration points)

| File | Edit | Why it can't live in a fork file |
|---|---|---|
| `config.ts` | `ModelRole` union `+ "cardCurator"` | A15: a real role. `runSubagent`/`ROLE_SLOT` are typed on it. |
| `src/core/settings.ts` | `BACKGROUND_MODEL_ROLES + "cardCurator"`. `ROLE_SLOT.cardCurator: "cheap"`, commented "= extractor's slot (A15)" and pinned by a test. | This makes the override sanitizer, the settings PUT, resolution and catalog pins all accept the role with no further edits. |
| `src/core/index.ts` | `export * from "./anki/index.ts";` | Layer law: `components/` may only import `@/src/core`. |
| `src/server/index.ts` | `export * from "./anki.ts";` | Layer law: `app/` may only import `@/src/server`. |
| `src/server/observability.ts` | Feed gains `curations: curationActivity()` | I15 dock |
| `components/activity-dock.tsx` | `FeedCuration` wire type; `toBlobs` maps it (`process: "curation"`, icon, live cost, abort kind) | I15 dock |
| `app/api/activity/abort/route.ts` | Accept `kind: "curation"` → `abortCuration(id)` | I15 dock abort |
| `src/core/cost-summary.ts` | Optional input `curations: AnkiCurationRun[]` → stage `curation` + `RecentRun.kind` `"curation"`. Absent input = today's output byte-for-byte. | I15 cost |
| `src/server/graph.ts` | `graphCosts()` passes `curations: ankiCostRuns()` | I15 cost |
| `components/graph-view.tsx` | (a) `<AnkiButton />` after Import notes. (b) Cost pill: `["Anki cards", costs.stages.curation]` row + totals include it. | A16, I15 |
| `components/minimal-home.tsx` | `<AnkiButton />` after Import notes | A16 (both homes) |
| `components/settings/settings-dialog.tsx` | `SECTIONS + {id:"anki", label:"Anki"}` + the section render | A23 |
| `components/settings/agent-section.tsx` | `<CardCuratorRow … />` after the slot rows | I14 |
| `electron/main.cjs` | `require("./anki.cjs").registerAnkiIpc(ipcMain, app, dialog)` | A20 native dialog |
| `electron/preload.cjs` | `anki: { saveFile: (fileName, text) => ipcRenderer.invoke("lh:anki:save", { fileName, text }) }` | A20 |
| `components/sidebar.tsx` | `window.lh` type gains `anki?` | The global type's only home |
| `tests/settings.test.ts` (+ any role-set pins) | Mechanical: the role list includes `cardCurator` | Existing pin |

Not touched: the graph ledgers, `graph.ts` merger, extraction pipeline, `ports.ts`, `stores.ts`, `settings-body.ts` (it iterates `BACKGROUND_MODEL_ROLES`), `events.ts` (the existing `activity-changed` event is reused).

## Data contracts

```ts
// src/core/contracts/anki.ts

export const ANKI_DECK = "LearnHarness";

/** One line of data/anki/cards.jsonl. APPEND-ONLY. The last line per nodeId
 *  is the card's state. Transitions: (none) → exported | declined;
 *  declined → exported (re-ticked via "show declined"). exported is
 *  terminal (A14: an exported GUID never goes into a file again). */
export interface AnkiCardRecord {
  nodeId: string;
  guid: string;                       // "lh_" + nodeId [confirm]
  state: "exported" | "declined";
  /** The session the card was curated under (= birth session then). */
  sessionId: string;
  sessionTitle: string;               // at the time of this line
  deck: string;                       // ANKI_DECK
  type: "basic" | "reversed";
  context: string;
  front: string;
  back: string;
  coverageReason?: string;
  at: string;                         // ISO
  exportFile?: string;                // exported lines: the file name
}

export interface AnkiCuratorCard {     // curator output, one per card
  nodeId: string;
  type: "basic" | "reversed";
  context: string;
  front: string;
  back: string;
  coverageReason?: string;            // required past the normal budget
}

export interface AnkiDraftCard extends AnkiCuratorCard {
  origin: "curator" | "declined";     // "declined" = re-shown from the ledger
  ticked: boolean;                    // curator cards: true by default (A19)
  edited: boolean;
}

export interface AnkiDraftGroup {
  sessionId: string;
  kind: "chat" | "file";
  title: string;                      // at curation time (display only)
  status: "queued" | "curating" | "done" | "failed" | "skipped";
  error?: string;                     // failed/skipped: human line
  budget: { normal: number; max: number; exportedBefore: number };
  /** Candidate node ids at curation time (to detect "new since draft"). */
  candidateIds: string[];
  cards: AnkiDraftCard[];
}

/** data/anki/draft.json. At most one (I8). */
export interface AnkiDraft {
  version: 1;
  id: string;                         // "anki_" + 12 hex
  revision: number;                   // bumped by every write; export checks it
  createdAt: string;
  updatedAt: string;
  status: "curating" | "ready";       // ready = every group settled
  groups: AnkiDraftGroup[];
}

/** One line of data/anki/runs.jsonl: one curator call (money channel). */
export interface AnkiCurationRun {
  startedAt: number;                  // ms, idempotency key
  at: string;
  durationMs: number;
  draftId: string;
  sessionId: string;
  title: string;
  outcome: "done" | "failed" | "aborted";
  usage: { model: string; steps: CallUsage[] };   // = ExtractionStageUsage
}

/** Picker row (GET /api/anki/sessions). */
export interface AnkiPickerRow {
  id: string;                         // chatId | src_…
  kind: "chat" | "file";
  title: string;                      // chat title | file base name
  date: string | null;                // chat createdAt | importedAt
  updatedAt: string | null;
  propositions: number;               // born here
  candidates: number;                 // born, no ledger line
  exported: number;
  declined: number;
  lastExportAt: string | null;
  extraction: "complete" | "pending" | "none" | "running";
  pendingTurns: number;               // chats: uncoveredCount
  remaining: number;                  // max − exported (≥ 0)
}

/** data/anki/settings.json: delta record, absent = factory. */
export interface AnkiSettings {
  version: 1;
  normalCardsPerSession?: number;     // factory 8
  maxCardsPerSession?: number;        // factory 15
  basicNoteType?: string;             // factory "Basic"
  reversedNoteType?: string;          // factory "Basic (and reversed card)"
}

export interface AnkiStore {
  readCards(): AnkiCardRecord[];
  appendCards(lines: AnkiCardRecord[]): void;   // one write for the batch
  readDraft(): AnkiDraft | null;
  writeDraft(draft: AnkiDraft): void;           // tmp + rename
  deleteDraft(): void;
  appendRun(run: AnkiCurationRun): void;
  readRuns(): AnkiCurationRun[];
  readSettings(): AnkiSettings | null;
  writeSettings(s: AnkiSettings): void;
  saveExportCopy(fileName: string, text: string): string;  // returns final name
}
```

The ledger is written **only** by export commit. No other code path writes `cards.jsonl`, and nothing rewrites it.

## Curator

### Per-session input (built by `candidates.ts`, rendered by `curatorPrompt`)

- **Candidates:** propositions born in the session with no ledger line.
- **Chains:** every chain whose conclusion or any premise is a candidate or a born proposition of the session.
- **Context:** propositions in those chains that aren't candidates (born elsewhere, or already carded/declined).
- **Already carded:** the session's `exported` cards (front → back), so the curator avoids cards that follow trivially (A11).
- **Budget:** `remaining` and `normalRemaining` (I5).
- If `remaining == 0`, the group is `skipped` ("limit reached") with no call. If there are no candidates, it's `skipped` ("nothing new to card").

### Output schema (TypeBox, tool `submit_cards`)

```ts
{
  cards: Array<{
    nodeId: string,            // "The id of ONE candidate proposition this card anchors."
    type: "basic" | "reversed",// "reversed only for a genuine term ↔ definition pair."
    context: string,           // "One short concrete line placing the card: Topic › subtopic — what this is about."
    front: string,             // "The question/cue. Must make sense alone, months later."
    back: string,              // "The answer only: shortest complete form."
    coverageReason?: string    // "Required for every card past the normal budget."
  }>
}
```

`validate` (an error makes the model retry within `maxTurns`):
- every `nodeId` is a candidate, with no duplicates
- `cards.length ≤ remaining`
- cards at index ≥ `normalRemaining` have a non-empty `coverageReason`
- `context`/`front`/`back` are non-empty after trim

`fill`: trims strings and drops `coverageReason` when empty. An empty `cards` array is valid.

### `CARD_CURATOR_INSTRUCTIONS` (full text)

```
You are the card curator of a learning application. A learner was taught one session (or imported
one notes file). What it taught is stored as PROPOSITIONS — true, self-contained statements — joined
by REASONING CHAINS: premises that jointly entail a conclusion. Anki will schedule spaced review of
the cards you write, over months. Your job: choose the session's long-term ANCHORS, and word each one
as a flashcard.

WHAT A CARD TRAINS. One retrieval. When the card comes up, the proposition is inactive in the
learner's mind; only the cue on the front can bring it back. A card earns its place when losing that
proposition would leave the learner unable to rebuild the session's ideas.

CARD-WORTHY (anchors):
- a term and its definition
- a named result, law, principle or formula
- a key condition, threshold or value that a result depends on
- a premise that the session's central chains rest on

NOT CARD-WORTHY:
- why/explain questions, derivations, proofs, worked examples
- anything whose answer needs more than one short sentence or one formula
- anything that follows trivially from another card — in your set or ALREADY CARDED
- examples, notation glosses, history and narrative

COVERAGE. Choose the SMALLEST set from which the learner could rebuild the whole idea. Work through
the session's main chains. For each chain, find the load-bearing propositions: premises that many
chains use, and conclusions that later reasoning builds on. A proposition that follows from carded
ones in one obvious step needs no card. When two candidates say nearly the same thing, card the one
more chains use. Fewer cards are better when fewer suffice; an empty list is a valid answer.

LIMIT. Propose at most {remaining} cards. Aim for at most {normalRemaining}. Order the cards from most
to least load-bearing. Every card after the first {normalRemaining} must carry a coverageReason: one
sentence naming which part of the idea could not be rebuilt without it. A reversed card counts as one.

ONE CARD PER PROPOSITION. Each card anchors exactly one CANDIDATE, named by its id. Never card a
CONTEXT proposition or an ALREADY CARDED one; they are there so you can see the structure.

WRITING THE CARD. Write in the language the propositions are written in.
- context: one short, concrete line that places the card, e.g.
  "Thermodynamics › Carnot cycle — ideal reversible heat engine". More specific than the session
  title. It orients; it never gives the answer away.
- front: a question or cue that makes sense on its own, months later, to someone who does not
  remember this session. Ask for exactly one thing. No "as discussed", no "in this session", no
  references to the source's numbering or labels.
- back: the answer only, in its shortest complete form — a term, a definition, a formula, a value
  with its unit. No explanation, no restating the question.
- type: "reversed" only for a genuine term ↔ definition pair, where recalling the term from the
  definition is as useful as the reverse; then front is the term and back is the definition.
  Everything else is "basic".
- Formulas: LaTeX inside \( … \) (inline) or \[ … \] (display). Plain text otherwise — no
  Markdown, no HTML.

SUBMIT with one submit_cards call. The tool's field descriptions carry the details.
```

### Prompt (user message) template

```
SESSION: "{title}" — {teaching session | notes file}, {YYYY-MM-DD}
BUDGET: at most {remaining} cards; aim for {normalRemaining}; cards past {normalRemaining} need a coverageReason.

CANDIDATES (propositions this session introduced; card from these only):
  n_… | {name} | {statement}

CONTEXT (other propositions the chains use; do not card):
  n_… | {name} | {statement}

ALREADY CARDED from this session (do not duplicate, skip what follows trivially from these):
  n_… | {front} → {back}

CHAINS (premises jointly ⇒ conclusion):
  [n_a + n_b ⇒ n_c]  {nameA} ∧ {nameB} ⇒ {nameC}
```

Empty sections print `(none)`. The vocabulary (retrieval, inactive, cue, load-bearing, premises chains rest on) matches `practice/10-doctrine.md`.

## Export file format

Headers (Anki ≥ 2.1.55 text import):

```
#separator:tab
#html:true
#guid column:1
#notetype column:2
#deck column:3
#tags column:6
```

Columns: `guid`, `notetype`, `deck`, `Front`, `Back`, `tags`. Rules:
- Only ticked, non-stale cards with **no `exported` ledger line** (A14, re-checked at commit).
- Every field is HTML-escaped (`& < > "`), tabs become a space, newlines become `<br>`. Math delimiters pass through untouched, after `$`-normalization [confirm].
- Front = `<div class="lh-context" style="font-size:0.8em;opacity:0.65;margin-bottom:0.6em">{context}</div>{front}`
- Back (basic) = `{back}<div class="lh-source" style="font-size:0.7em;opacity:0.5;margin-top:1em">LearnHarness · {title} · {date}</div>`
- Back (reversed, I18) = context div + `{back}` + source div
- notetype = the `basicNoteType` / `reversedNoteType` setting (I11)
- tags = `learnharness learnharness::{slug}`. Slug: lowercase, whitespace → `_`, keep letters (any script), digits, `_` and `-`, drop the rest, collapse `_`, cut to 60 chars, fallback `session` (I12).
- Rows are ordered by group order, then card order. The file ends with `\n` and is UTF-8 without BOM.

Example (`learnharness-anki-2026-10-27.txt`, tabs shown as `⇥`):

```
#separator:tab
#html:true
#guid column:1
#notetype column:2
#deck column:3
#tags column:6
lh_n_3fa2c1d9e0b4⇥Basic⇥LearnHarness⇥<div class="lh-context" style="font-size:0.8em;opacity:0.65;margin-bottom:0.6em">Thermodynamics › Carnot cycle — ideal reversible heat engine</div>What is the efficiency of a Carnot engine between reservoirs at \(T_h\) and \(T_c\)?⇥\(\eta = 1 - T_c/T_h\)<div class="lh-source" style="font-size:0.7em;opacity:0.5;margin-top:1em">LearnHarness · Carnot cycle and heat engines · 2026-10-21</div>⇥learnharness learnharness::carnot_cycle_and_heat_engines
lh_n_91be07aa5c3d⇥Basic (and reversed card)⇥LearnHarness⇥<div class="lh-context" style="font-size:0.8em;opacity:0.65;margin-bottom:0.6em">Thermodynamics › Entropy — state function</div>Entropy⇥<div class="lh-context" style="font-size:0.8em;opacity:0.65;margin-bottom:0.6em">Thermodynamics › Entropy — state function</div>The state function whose change in a reversible process is \(dS = \delta Q_{rev}/T\)<div class="lh-source" style="font-size:0.7em;opacity:0.5;margin-top:1em">LearnHarness · Carnot cycle and heat engines · 2026-10-21</div>⇥learnharness learnharness::carnot_cycle_and_heat_engines
```

## Lifecycle

```
picker ──POST /api/anki/draft──▶ draft{status:curating}, groups queued
   (409 if a draft exists; 503 envelope if no cardCurator model / key)
        │  per group, in parallel under withBgLlmSlot:
        │  queued → curating → done | failed | skipped   (each write: revision++, emit activity-changed)
        ▼
draft{status:ready} ──PATCH edits (revision check)──▶ draft
        │
        ├─ Discard ─▶ DELETE: aborts a running job, deletes draft.json. Ledger untouched.
        │
        └─ Export:
             desktop: preview → lh.anki.saveFile → (cancelled: nothing) → commit
             web:     download (commit + attachment in one response)
           commit = revalidate (I16) + ledger re-check → appendCards([exported…, declined…])
                    → saveExportCopy → deleteDraft → emit activity-changed
           (runs.jsonl is written per curator call, never at export)
```

- **Abort** (dock or Discard): running/queued groups → `failed` with "aborted". The draft becomes `ready` with whatever finished, and an aborted run's usage is still appended to `runs.jsonl`.
- **Server restart mid-curation:** on the first draft read, groups still `queued`/`curating` with no live registry entry → `failed` ("interrupted — discard and try again"), and the draft becomes `ready`.
- **Export of a partly failed draft:** allowed. Failed/skipped groups contribute nothing.
- **What an export records:** ticked cards → `exported`. Unticked `origin:"curator"` cards → `declined`. Unticked `origin:"declined"` cards → nothing (already declined). Stale cards → nothing.
- **Zero ticked cards:** the export button reads "Decline all and close". It records the declines and writes no file.

## UI

**Entry (A16):** an `Anki…` pill right after `Import notes…` in both `graph-view.tsx` and `minimal-home.tsx`, with the same 36px chrome and the hint "Make Anki cards from your sessions". When a draft exists, the pill reads `Anki · draft`.

**Modal** (centred, the settings-dialog shell style, Esc/backdrop per the existing layering helpers). Four states:

1. **Picker** (no draft). Title "Make Anki cards". Each row: checkbox, title, kind (session / notes), date, and one status line:
   - `never carded` / `{N} cards · last export {date}`
   - `not extracted yet` → disabled + `Extract first` button
   - `{N} turns pending — cards only from what's extracted so far` + `Extract first`
   - `extracting…`
   - `limit reached` (disabled) / `all carded` (disabled when no candidates)

   `Extract first` POSTs `/api/graph/coverage/extract`. The row refreshes on `activity-changed`. Footer: `Make cards ({n} selected)`, disabled at 0. A refusal shows the envelope text with a "Settings" link (same tone as notes import).
2. **Curating:** one line per group (title + `queued` / `curating…` / `done · {n} cards` / `failed: …` / `skipped: …`). Note: "Runs in the background — you can close this." Buttons: `Discard`.
3. **Review** (A19). Group header: `{title} · {used} of {max} used`. Each card row: checkbox (ticked by default), Basic/Reversed toggle, editable `context` / `front` / `back` (textareas, saved on blur via PATCH). A card past the normal budget shows `Extra: {coverageReason}`. Stale cards are greyed out: `source deleted`. A group note reads `{n} new propositions since this draft`. Failed/skipped groups show their line. Footer: `Show declined` toggle (declined rows appear unticked, `origin:"declined"`, also editable), `Discard draft`, `Export {n} cards…`. Ticks past the cap are disabled with the tooltip `limit reached — raise it in Settings › Anki` (I6).
4. **Done:** `Exported {n} cards to {path | your downloads}.` + `In Anki: File › Import…, choose the file. Cards go to the "LearnHarness" deck.` + `Close`.

**Settings › Anki (A23):** "Cards per session" (number, hint "Normal amount; extra cards need a reason"), "Maximum per session" (number), "Basic note type" (text, hint "Must match the note type's name in your Anki"), "Reversed note type" (text). Same row controls as the Graph section.

**Agent › Models (I14):** a row "Card curator", hint "Writes Anki cards", with model and thinking menus. Unset shows `Same as Cheap`, plus a `Reset` link when set.

**Dock (I15):** blob title `Anki cards · {n} sessions`, a card icon, elapsed time, live cost, activity `{done}/{n} sessions`, and the END button → `kind:"curation"`.

## Settings shape and defaults

`data/anki/settings.json`, delta semantics like upstream: `{ "version": 1 }` plus explicit values only. Resolved: `{ normalCardsPerSession: 8, maxCardsPerSession: 15, basicNoteType: "Basic", reversedNoteType: "Basic (and reversed card)" }`. `GET /api/anki/settings` → `{ settings (raw), effective }`. `PUT` is replace-whole with validation per [confirm] 5.

## Tests (node:test + tsx, existing style; faux engines and in-memory ports, no network)

| File | Covers |
|---|---|
| `tests/anki-ledger.test.ts` | Last-wins fold. `exported` is terminal (a later `declined` line for the same node is ignored). Per-session counts and last export date. Budget math incl. I5. |
| `tests/anki-candidates.test.ts` | Born-only candidates (I3). Ledger exclusion. Context and chain selection. **A22 pin:** after `mergeFindings` links a new extraction to a carded node, the id survives and the node is not a candidate. Stale-draft revalidation (I16). |
| `tests/anki-export-format.test.ts` | Headers. Column order. Escaping (tab, newline, `& < > "`). `$` → `\(` normalization. Slug (spaces, umlauts, punctuation, length, fallback). GUID. Basic vs reversed layout (I18). Note type names from settings. Determinism. Golden output = the example above. |
| `tests/anki-settings.test.ts` | Sanitizer clamps/drops. PUT parser rejects normal > max, out-of-range values and bad names. Factory resolution. |
| `tests/anki-curator.test.ts` | Faux-engine submit → cards. `validate` rejects unknown/duplicate ids, over budget and missing reasons (the model retries). Prompt carries the budget numbers and sections. Role is `cardCurator`. |
| `tests/anki-curation.test.ts` | Job lifecycle on an in-memory store: groups settle independently (one failure, others done). Skipped groups (limit/no candidates). Abort. Single draft (409). Restart recovery. `runs.jsonl` usage. `curationActivity()` rows. `activity-changed` emitted. |
| `tests/anki-export-commit.test.ts` | Commit appends exported + declined in one write, saves the export copy, deletes the draft. Stale revision → 409. A deleted source is skipped. An already exported node is skipped. Re-ticked declined → exported. Zero ticks → declines only, no file. Picker rows: extraction states + counts. |
| `tests/anki-ui.test.tsx` | Picker row status lines and disabled states. Review: ticked by default, extra reason shown, cap disables ticks, show declined, stale row. Card-curator row "Same as Cheap". |
| Updates | `settings.test.ts` role pin (+ `ROLE_SLOT.cardCurator === ROLE_SLOT.extractor`). `cost-summary.test.ts` (curation stage, unchanged output without input). `activity-feed` test (curation blobs). Abort route kind. |

Run: `npm test`, `npm run lint`, `npm run typecheck`, all green.

## Verification (after tests pass)

1. `npm run dev` in the worktree (dev data copy, I19). Configure the cheap slot if the copy has none.
2. Picker → pick 1–2 real sessions → watch the dock blob + cost → review → edit one card, untick one → export (web download). Also check `desktop:dev` for the native Save dialog and last-folder memory.
3. Check `data/anki/cards.jsonl` (exported + declined lines) and `data/anki/exports/`. Re-open the picker: the counts show, and a second curation suggests only new propositions.
4. Show you the produced file. You import it into a **scratch Anki profile** and report what Anki says (I19).

Never touched: `~/Library/Application Support/LearnHarness/`, your Anki profile, git commits/pushes (only on request).
