/**
 * The Anki `.txt` export (FORK-ONLY, A10/A14, I11–I13, I18). Pure and
 * deterministic: the same rows and settings always build the same bytes,
 * and GUIDs derive from node ids — rebuilding a file never mints new ones.
 *
 * Anki's text import (≥ 2.1.55) reads the header lines; re-importing a
 * GUID UPDATES that note, so the caller passes only cards that were never
 * exported (A14 — the commit re-checks the ledger).
 */
import { ANKI_DECK, type AnkiCuratorCard, type EffectiveAnkiSettings } from "../contracts/anki.ts";
import { ankiGuid } from "./ledger.ts";

export const ANKI_EXPORT_HEADER = [
	"#separator:tab",
	"#html:true",
	"#guid column:1",
	"#notetype column:2",
	"#deck column:3",
	"#tags column:6",
].join("\n");

export const ANKI_ROOT_TAG = "learnharness";
const SLUG_MAX_CHARS = 60;

/** One exportable card plus the session facts its source line and tag
 *  need — read at EXPORT time (a rename after curation lands here). */
export interface AnkiExportRow {
	card: AnkiCuratorCard;
	/** The current session title (notes: the file's base name). */
	sessionTitle: string;
	/** The session's start day (notes: the import day), local YYYY-MM-DD;
	 *  null when nothing can date it. */
	sessionDay: string | null;
}

/** The session tag's slug (I12): lowercase, whitespace → "_", letters of
 *  any script, digits, "_" and "-" kept, the rest dropped, runs of "_"
 *  collapsed, cut to 60 chars; "session" when nothing is left. */
export function ankiTagSlug(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFC")
		.replace(/\s+/g, "_")
		.replace(/[^\p{L}\p{N}_-]/gu, "")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, SLUG_MAX_CHARS)
		.replace(/_+$/g, "");
	return slug.length > 0 ? slug : "session";
}

/** Stray Markdown math → Anki's MathJax delimiters: `$$…$$` → `\[…\]`,
 *  `$…$` → `\(…\)` (the curator is told to write `\(…\)` already; this is
 *  the safety net). A single-dollar span must hug its content and must not
 *  be followed by a digit, so prices ("$5 and $6") stay text. */
export function normalizeAnkiMath(text: string): string {
	return text
		.replace(/\$\$([\s\S]+?)\$\$/g, (_m, body: string) => `\\[${body}\\]`)
		.replace(/(?<![\\$])\$(?=\S)([^$\n]*?\S)\$(?!\d)/g, (_m, body: string) => `\\(${body}\\)`);
}

/** One field for `#html:true`: math normalized, HTML-escaped, tabs → space,
 *  line breaks → <br>. */
export function ankiFieldText(text: string): string {
	return normalizeAnkiMath(text.trim())
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/\t/g, " ")
		.replace(/\r\n|\r|\n/g, "<br>");
}

const CONTEXT_STYLE = "font-size:0.8em;opacity:0.65;margin-bottom:0.6em";
const SOURCE_STYLE = "font-size:0.7em;opacity:0.5;margin-top:1em";

const contextDiv = (context: string): string =>
	`<div class="lh-context" style="${CONTEXT_STYLE}">${ankiFieldText(context)}</div>`;

/** `LearnHarness · <title> · <day>` (I13). */
export function ankiSourceLine(sessionTitle: string, sessionDay: string | null): string {
	return ["LearnHarness", sessionTitle.trim(), ...(sessionDay ? [sessionDay] : [])].join(" · ");
}

const sourceDiv = (row: AnkiExportRow): string =>
	`<div class="lh-source" style="${SOURCE_STYLE}">${ankiFieldText(ankiSourceLine(row.sessionTitle, row.sessionDay))}</div>`;

/** The note's two fields (A10, I18): the context line leads the Front; the
 *  Back is the answer plus the source line — and a reversed note's Back
 *  leads with the context too, so card 2's question carries its cue. */
export function ankiNoteFields(row: AnkiExportRow): { front: string; back: string } {
	const { card } = row;
	const front = `${contextDiv(card.context)}${ankiFieldText(card.front)}`;
	const back =
		card.type === "reversed"
			? `${contextDiv(card.context)}${ankiFieldText(card.back)}${sourceDiv(row)}`
			: `${ankiFieldText(card.back)}${sourceDiv(row)}`;
	return { front, back };
}

/** The whole file: header + one row per card (guid, notetype, deck, Front,
 *  Back, tags), "\n"-terminated, UTF-8 without BOM. */
export function buildAnkiExport(
	rows: readonly AnkiExportRow[],
	settings: Pick<EffectiveAnkiSettings, "basicNoteType" | "reversedNoteType">,
): string {
	const lines = [ANKI_EXPORT_HEADER];
	for (const row of rows) {
		const { front, back } = ankiNoteFields(row);
		const noteType = row.card.type === "reversed" ? settings.reversedNoteType : settings.basicNoteType;
		const tags = `${ANKI_ROOT_TAG} ${ANKI_ROOT_TAG}::${ankiTagSlug(row.sessionTitle)}`;
		lines.push([ankiGuid(row.card.nodeId), noteType, ANKI_DECK, front, back, tags].join("\t"));
	}
	return `${lines.join("\n")}\n`;
}

/** `learnharness-anki-<day>.txt` — the day is the caller's local date. */
export function ankiExportFileName(day: string): string {
	return `learnharness-anki-${day}.txt`;
}

/** A Date → its LOCAL calendar day, YYYY-MM-DD. */
export function localDay(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
