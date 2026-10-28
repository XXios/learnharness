/**
 * Anki settings (FORK-ONLY, I10/I11): data/anki/settings.json — a DELTA
 * record in the upstream settings discipline (src/core/settings.ts):
 * absent keys resolve to the factory defaults compiled here, the
 * sanitizer clamps-never-throws on disk input, and the PUT parser is
 * strict (400 with a reason). Browser-safe.
 */
import type { AnkiSettings, EffectiveAnkiSettings } from "../contracts/anki.ts";

export const ANKI_FACTORY_SETTINGS: EffectiveAnkiSettings = {
	normalCardsPerSession: 8,
	maxCardsPerSession: 15,
	basicNoteType: "Basic",
	reversedNoteType: "Basic (and reversed card)",
};

/** Both limits live in [ANKI_LIMIT_MIN, ANKI_LIMIT_MAX]. */
export const ANKI_LIMIT_MIN = 1;
export const ANKI_LIMIT_MAX = 50;
export const ANKI_NOTE_TYPE_MAX_CHARS = 100;

const clampLimit = (n: number): number => Math.min(ANKI_LIMIT_MAX, Math.max(ANKI_LIMIT_MIN, Math.floor(n)));

/** A note type name as Anki matches it: trimmed, non-empty, bounded, no
 *  tab/newline (they would break the tab-separated file). */
export function validNoteTypeName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.trim().length <= ANKI_NOTE_TYPE_MAX_CHARS &&
		!/[\t\r\n]/.test(value)
	);
}

/** Disk input → a valid delta record. Never throws; non-objects → null.
 *  Numbers clamp into range; wrong types drop; a normal above the
 *  (resolved) max clamps down to it. */
export function sanitizeAnkiSettings(raw: unknown): AnkiSettings | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const out: AnkiSettings = { version: 1 };
	if (typeof r.maxCardsPerSession === "number" && Number.isFinite(r.maxCardsPerSession)) {
		out.maxCardsPerSession = clampLimit(r.maxCardsPerSession);
	}
	if (typeof r.normalCardsPerSession === "number" && Number.isFinite(r.normalCardsPerSession)) {
		const max = out.maxCardsPerSession ?? ANKI_FACTORY_SETTINGS.maxCardsPerSession;
		out.normalCardsPerSession = Math.min(clampLimit(r.normalCardsPerSession), max);
	}
	if (validNoteTypeName(r.basicNoteType)) out.basicNoteType = r.basicNoteType.trim();
	if (validNoteTypeName(r.reversedNoteType)) out.reversedNoteType = r.reversedNoteType.trim();
	return out;
}

/** The record (or null on first boot) → every knob concrete. */
export function resolveAnkiSettings(record: AnkiSettings | null): EffectiveAnkiSettings {
	const max = record?.maxCardsPerSession ?? ANKI_FACTORY_SETTINGS.maxCardsPerSession;
	const normal = record?.normalCardsPerSession ?? ANKI_FACTORY_SETTINGS.normalCardsPerSession;
	return {
		normalCardsPerSession: Math.min(normal, max),
		maxCardsPerSession: max,
		basicNoteType: record?.basicNoteType ?? ANKI_FACTORY_SETTINGS.basicNoteType,
		reversedNoteType: record?.reversedNoteType ?? ANKI_FACTORY_SETTINGS.reversedNoteType,
	};
}

export type AnkiSettingsBodyResult = { ok: true; settings: AnkiSettings } | { ok: false; error: string };

/** The PUT body parser — replace-whole, strict. Absent fields are absent
 *  overrides ({} resets everything to factory). */
export function parseAnkiSettingsBody(body: unknown): AnkiSettingsBodyResult {
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "Invalid JSON body" };
	}
	const b = body as Record<string, unknown>;
	const out: AnkiSettings = { version: 1 };
	for (const key of ["normalCardsPerSession", "maxCardsPerSession"] as const) {
		const value = b[key];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isInteger(value) || value < ANKI_LIMIT_MIN || value > ANKI_LIMIT_MAX) {
			return { ok: false, error: `${key} must be a whole number from ${ANKI_LIMIT_MIN} to ${ANKI_LIMIT_MAX}` };
		}
		out[key] = value;
	}
	const resolved = resolveAnkiSettings(out);
	if ((out.normalCardsPerSession ?? ANKI_FACTORY_SETTINGS.normalCardsPerSession) > resolved.maxCardsPerSession) {
		return { ok: false, error: "normalCardsPerSession cannot exceed maxCardsPerSession" };
	}
	for (const key of ["basicNoteType", "reversedNoteType"] as const) {
		const value = b[key];
		if (value === undefined) continue;
		if (!validNoteTypeName(value)) {
			return { ok: false, error: `${key} must be a non-empty name of at most ${ANKI_NOTE_TYPE_MAX_CHARS} characters, without tabs or line breaks` };
		}
		out[key] = value.trim();
	}
	return { ok: true, settings: out };
}
