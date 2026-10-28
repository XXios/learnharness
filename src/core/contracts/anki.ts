/**
 * Anki export contracts (FORK-ONLY — docs/fork/anki-export.md A1–A23,
 * docs/fork/anki-export-implementation.md I1–I19).
 *
 * Anki owns all scheduling (A1); LearnHarness only picks and words cards
 * from knowledge-graph propositions (A2). The graph is never written: the
 * card records live in their own append-only ledger (A6,
 * data/anki/cards.jsonl), written ONLY by an export commit.
 *
 * Pure types + constants, browser-safe.
 */
import type { CallUsage } from "./chat.ts";

/** The one deck every card goes to (A8). */
export const ANKI_DECK = "LearnHarness";

/** The card's Anki note shape (A10): stock `Basic`, or stock
 *  `Basic (and reversed card)` for real term ↔ definition pairs. */
export type AnkiCardType = "basic" | "reversed";

/** One line of data/anki/cards.jsonl — APPEND-ONLY. The LAST line per
 *  nodeId is the card's state. Transitions: (none) → exported | declined;
 *  declined → exported (re-ticked via "show declined"). `exported` is
 *  terminal (A14: an exported GUID never goes into a file again). */
export interface AnkiCardRecord {
	nodeId: string;
	/** "lh_" + nodeId — deterministic (ankiGuid). */
	guid: string;
	state: "exported" | "declined";
	/** The session the card was curated under (its birth session then). */
	sessionId: string;
	/** The session title at the time of this line. */
	sessionTitle: string;
	deck: string;
	type: AnkiCardType;
	context: string;
	front: string;
	back: string;
	coverageReason?: string;
	/** ISO — when this line was appended. */
	at: string;
	/** Exported lines: the export file's name. */
	exportFile?: string;
}

/** The curator's output — one card per candidate proposition. */
export interface AnkiCuratorCard {
	nodeId: string;
	type: AnkiCardType;
	/** A short concrete line placing the card (A9). */
	context: string;
	front: string;
	back: string;
	/** Required for every card past the normal budget (A12). */
	coverageReason?: string;
}

/** One card in the review list (A19). */
export interface AnkiDraftCard extends AnkiCuratorCard {
	/** "declined" = re-shown from the ledger through "show declined". */
	origin: "curator" | "declined";
	/** Curator cards start ticked (A19); declined rows start unticked. */
	ticked: boolean;
	edited: boolean;
}

export type AnkiGroupStatus = "queued" | "curating" | "done" | "failed" | "skipped";

/** One session's part of the draft. */
export interface AnkiDraftGroup {
	sessionId: string;
	kind: "chat" | "file";
	/** The session title at curation time (display only — the export
	 *  re-reads the current title). */
	title: string;
	status: AnkiGroupStatus;
	/** failed / skipped: a human line. */
	error?: string;
	budget: { normal: number; max: number; exportedBefore: number };
	/** Candidate node ids at curation time ("N new propositions since this
	 *  draft" compares against these). */
	candidateIds: string[];
	cards: AnkiDraftCard[];
}

/** data/anki/draft.json — at most one draft exists (I8). */
export interface AnkiDraft {
	version: 1;
	/** "anki_" + 12 hex. */
	id: string;
	/** Bumped by every write; edits and the export check it (409 on stale). */
	revision: number;
	createdAt: string;
	updatedAt: string;
	/** ready = every group settled (done / failed / skipped). */
	status: "curating" | "ready";
	groups: AnkiDraftGroup[];
}

/** One line of data/anki/runs.jsonl — one curator call (the money channel). */
export interface AnkiCurationRun {
	/** ms — the idempotency key. */
	startedAt: number;
	at: string;
	durationMs: number;
	draftId: string;
	sessionId: string;
	title: string;
	outcome: "done" | "failed" | "aborted";
	/** Same shape as an extraction stage's usage. */
	usage: { model: string; steps: CallUsage[] };
}

export type AnkiExtractionState = "complete" | "pending" | "none" | "running";

/** One picker row (GET /api/anki/sessions) — a teaching chat or an
 *  imported notes file (I4). */
export interface AnkiPickerRow {
	/** chatId | "src_…" */
	id: string;
	kind: "chat" | "file";
	/** Chat title | the notes file's base name. */
	title: string;
	/** Chat createdAt | the file's importedAt. */
	date: string | null;
	updatedAt: string | null;
	/** Propositions born in this session. */
	propositions: number;
	/** Born here, with no ledger line. */
	candidates: number;
	exported: number;
	declined: number;
	lastExportAt: string | null;
	extraction: AnkiExtractionState;
	/** Chats: uncovered teacher-prose messages. Files: 0. */
	pendingTurns: number;
	/** max − exported (≥ 0). */
	remaining: number;
}

/** data/anki/settings.json — a DELTA record: absent = factory (I10). */
export interface AnkiSettings {
	version: 1;
	normalCardsPerSession?: number;
	maxCardsPerSession?: number;
	basicNoteType?: string;
	reversedNoteType?: string;
}

/** The fully resolved settings. */
export interface EffectiveAnkiSettings {
	normalCardsPerSession: number;
	maxCardsPerSession: number;
	basicNoteType: string;
	reversedNoteType: string;
}

/** A running curation, as the activity dock sees it (I15). */
export interface AnkiCurationActivity {
	/** The draft id — the abort key. */
	id: string;
	title: string;
	sessions: number;
	settled: number;
	startedAt: number;
	costUsd: number | null;
	model?: string;
}

/** The storage port for everything under data/anki/ (fork-owned; the
 *  upstream ports.ts stays untouched). */
export interface AnkiStore {
	readCards(): AnkiCardRecord[];
	/** One write for the whole batch (an export commit). */
	appendCards(lines: AnkiCardRecord[]): void;
	readDraft(): AnkiDraft | null;
	/** Atomic (tmp + rename). */
	writeDraft(draft: AnkiDraft): void;
	deleteDraft(): void;
	appendRun(run: AnkiCurationRun): void;
	readRuns(): AnkiCurationRun[];
	readSettings(): AnkiSettings | null;
	writeSettings(settings: AnkiSettings): void;
	/** Saves a copy under data/anki/exports/; returns the final file name
	 *  (suffixed -2, -3… on collision). */
	saveExportCopy(fileName: string, text: string): string;
}
