/**
 * AnkiStore — the fs adapter for everything under data/anki/ (FORK-ONLY,
 * docs/fork/anki-export-implementation.md). Same idioms as the graph store:
 * sync fs, JSONL ledgers append-only, corrupt lines skipped, JSON records
 * replaced through tmp + rename.
 *
 *   cards.jsonl   AnkiCardRecord   — the card ledger (A6). Written ONLY by
 *                                    an export commit, never rewritten.
 *   runs.jsonl    AnkiCurationRun  — one line per curator call (money).
 *   draft.json    AnkiDraft        — at most one draft (I8).
 *   settings.json AnkiSettings     — the delta record (I10).
 *   exports/      every exported file, as a recoverable copy (I9).
 *
 * The directory derives from PATHS.data (the LH_DATA_DIR seam), so the
 * desktop app writes under userData and dev under the repo's data/.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import { sanitizeAnkiSettings } from "../core/anki/settings.ts";
import type { AnkiCardRecord, AnkiCurationRun, AnkiDraft, AnkiSettings, AnkiStore } from "../core/contracts/anki.ts";

export function ankiPaths(dataDir: string = PATHS.data) {
	const dir = path.join(dataDir, "anki");
	return {
		dir,
		cards: path.join(dir, "cards.jsonl"),
		runs: path.join(dir, "runs.jsonl"),
		draft: path.join(dir, "draft.json"),
		settings: path.join(dir, "settings.json"),
		exports: path.join(dir, "exports"),
	};
}

function readLines(file: string): unknown[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	const out: unknown[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// a torn append never takes the whole ledger down
		}
	}
	return out;
}

function appendLines(file: string, records: readonly unknown[]): void {
	if (records.length === 0) return;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf-8");
}

function writeAtomic(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${randomUUID().slice(0, 8)}`;
	try {
		fs.writeFileSync(tmp, text, "utf-8");
		fs.renameSync(tmp, file);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* already renamed or never written */
		}
		throw err;
	}
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isCardRecord(v: unknown): v is AnkiCardRecord {
	return (
		isRecord(v) &&
		typeof v.nodeId === "string" &&
		typeof v.guid === "string" &&
		(v.state === "exported" || v.state === "declined") &&
		typeof v.sessionId === "string" &&
		typeof v.front === "string" &&
		typeof v.back === "string"
	);
}

function isRun(v: unknown): v is AnkiCurationRun {
	return isRecord(v) && typeof v.startedAt === "number" && typeof v.sessionId === "string" && isRecord(v.usage);
}

function isDraft(v: unknown): v is AnkiDraft {
	return isRecord(v) && v.version === 1 && typeof v.id === "string" && typeof v.revision === "number" && Array.isArray(v.groups);
}

export function createAnkiStore(dataDir?: string): AnkiStore {
	const p = () => ankiPaths(dataDir);
	return {
		readCards: () => readLines(p().cards).filter(isCardRecord),
		appendCards: (lines) => appendLines(p().cards, lines),
		readDraft: () => {
			const draft = readJson(p().draft);
			return isDraft(draft) ? draft : null;
		},
		writeDraft: (draft) => writeAtomic(p().draft, JSON.stringify(draft, null, "\t")),
		deleteDraft: () => {
			try {
				fs.unlinkSync(p().draft);
			} catch {
				/* no draft — nothing to delete */
			}
		},
		appendRun: (run) => appendLines(p().runs, [run]),
		readRuns: () => readLines(p().runs).filter(isRun),
		readSettings: (): AnkiSettings | null => sanitizeAnkiSettings(readJson(p().settings)),
		writeSettings: (settings) => {
			const clean = sanitizeAnkiSettings(settings);
			if (!clean) throw new Error("anki settings must be a JSON object");
			writeAtomic(p().settings, JSON.stringify(clean, null, "\t"));
		},
		saveExportCopy: (fileName, text) => {
			const dir = p().exports;
			fs.mkdirSync(dir, { recursive: true });
			const base = path.basename(fileName);
			let name = base;
			for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = base.replace(/(\.txt)?$/, `-${i}.txt`);
			fs.writeFileSync(path.join(dir, name), text, "utf-8");
			return name;
		},
	};
}

/** The live store (data dir resolved per call — the LH_DATA_DIR seam). */
export const ankiStore: AnkiStore = createAnkiStore();
