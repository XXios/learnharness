/**
 * Shared in-memory doubles for the Anki suites (fork): a GraphStore and an
 * AnkiStore that never touch data/. Not a test file (the runner globs
 * tests/*.test.ts only).
 */
import type {
	CoverageEntry,
	ExtractionRunUsage,
	GraphChain,
	GraphNode,
	NotesSource,
	SessionCheckpoint,
} from "../../src/core/contracts.ts";
import type { GraphStore } from "../../src/core/ports.ts";
import type { AnkiCardRecord, AnkiCurationRun, AnkiDraft, AnkiSettings, AnkiStore } from "../../src/core/contracts/anki.ts";

export function memoryGraphStore() {
	const nodes: GraphNode[] = [];
	const chains: GraphChain[] = [];
	const checkpoints: SessionCheckpoint[] = [];
	const coverage: CoverageEntry[] = [];
	const sources = new Map<string, NotesSource>();
	let positions: Record<string, { x: number; y: number }> = {};
	return {
		appendNode: (n: GraphNode) => void nodes.push(structuredClone(n)),
		readNodes: () => nodes.map((n) => structuredClone(n)),
		appendChain: (c: GraphChain) => void chains.push(structuredClone(c)),
		readChains: () => chains.map((c) => structuredClone(c)),
		appendCheckpoint: (c: SessionCheckpoint) => void checkpoints.push({ ...c }),
		readCheckpoints: () => checkpoints.map((c) => ({ ...c })),
		appendCoverage: (e: CoverageEntry) => void coverage.push({ ...e }),
		readCoverage: () => coverage.map((e) => ({ ...e })),
		upsertSource: (s: NotesSource) => void sources.set(s.id, structuredClone(s)),
		readSources: () => [...sources.values()].map((s) => structuredClone(s)),
		appendSourceUsage: (id: string, entry: ExtractionRunUsage) => {
			const source = sources.get(id);
			if (source) source.extractions = [...(source.extractions ?? []), entry];
		},
		readPositions: () => ({ ...positions }),
		writePositions: (next: Record<string, { x: number; y: number }>) => void (positions = { ...next }),
		rewriteLedgers: (next: { nodes?: GraphNode[]; chains?: GraphChain[]; coverage?: CoverageEntry[]; checkpoints?: SessionCheckpoint[] }) => {
			if (next.nodes) nodes.splice(0, nodes.length, ...next.nodes.map((n) => structuredClone(n)));
			if (next.chains) chains.splice(0, chains.length, ...next.chains.map((c) => structuredClone(c)));
			if (next.coverage) coverage.splice(0, coverage.length, ...next.coverage);
			if (next.checkpoints) checkpoints.splice(0, checkpoints.length, ...next.checkpoints);
		},
	} satisfies GraphStore;
}

export function memoryAnkiStore(init: { settings?: AnkiSettings | null } = {}) {
	const cards: AnkiCardRecord[] = [];
	const runs: AnkiCurationRun[] = [];
	const exports = new Map<string, string>();
	let draft: AnkiDraft | null = null;
	let settings: AnkiSettings | null = init.settings ?? null;
	let cardWrites = 0;
	const store = {
		readCards: () => cards.map((c) => ({ ...c })),
		appendCards: (lines: AnkiCardRecord[]) => {
			cardWrites++;
			cards.push(...lines.map((c) => ({ ...c })));
		},
		readDraft: () => (draft ? structuredClone(draft) : null),
		writeDraft: (next: AnkiDraft) => void (draft = structuredClone(next)),
		deleteDraft: () => void (draft = null),
		appendRun: (run: AnkiCurationRun) => void runs.push(structuredClone(run)),
		readRuns: () => runs.map((r) => structuredClone(r)),
		readSettings: () => (settings ? { ...settings } : null),
		writeSettings: (next: AnkiSettings) => void (settings = { ...next }),
		saveExportCopy: (fileName: string, text: string) => {
			let name = fileName;
			for (let i = 2; exports.has(name); i++) name = fileName.replace(/\.txt$/, `-${i}.txt`);
			exports.set(name, text);
			return name;
		},
	} satisfies AnkiStore;
	return { store, exports, cardWrites: () => cardWrites };
}

/** A node line born in `sessionId` (provenance[0] is the birth point). */
export function node(id: string, sessionId: string, name = id, statement = `${id} statement`): GraphNode {
	return { id, name, statement, aliases: [], createdAt: "2026-10-01T00:00:00Z", provenance: [{ chatId: sessionId, messageId: "" }] };
}

export function chain(id: string, premises: string[], conclusion: string, sessionId: string): GraphChain {
	return { id, premises, conclusion, createdAt: "2026-10-01T00:00:00Z", provenance: [{ chatId: sessionId, messageId: "" }] };
}

// ─── AnkiDeps for the server composition (src/server/anki.ts) ────────────────

import type { ChatRecord, ChatSummary } from "../../src/core/contracts.ts";
import type { AnkiDeps } from "../../src/server/anki.ts";
import type { PiEngine } from "../../src/agent/models.ts";

export interface FakeChat {
	id: string;
	title: string;
	createdAt: string;
	kind?: "teach" | "practice";
	/** Teacher prose messages with NO coverage → uncovered turns. */
	uncoveredProse?: string[];
}

export function ankiDeps(opts: {
	nodes?: GraphNode[];
	chains?: GraphChain[];
	chats?: FakeChat[];
	sources?: NotesSource[];
	engine?: PiEngine;
	refuse?: boolean;
	settings?: AnkiSettings | null;
	now?: Date;
}) {
	const graphStore = memoryGraphStore();
	for (const n of opts.nodes ?? []) graphStore.appendNode(n);
	for (const c of opts.chains ?? []) graphStore.appendChain(c);
	for (const s of opts.sources ?? []) graphStore.upsertSource(s);
	const anki = memoryAnkiStore({ settings: opts.settings ?? null });
	const chats = opts.chats ?? [];
	const record = (chat: FakeChat): ChatRecord =>
		({
			id: chat.id,
			title: chat.title,
			createdAt: chat.createdAt,
			updatedAt: chat.createdAt,
			kind: chat.kind,
			messages: (chat.uncoveredProse ?? []).map((text, i) => ({ id: `${chat.id}_m${i}`, role: "assistant", content: [{ type: "text", text }] })),
		}) as unknown as ChatRecord;
	const deps: AnkiDeps = {
		ankiStore: anki.store,
		graphStore,
		chatStore: {
			listChats: () =>
				chats.map((chat) => ({ id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.createdAt, kind: chat.kind ?? "teach" }) as ChatSummary),
			getChat: (id: string) => {
				const chat = chats.find((c) => c.id === id);
				return chat ? record(chat) : null;
			},
		},
		extractingIds: () => new Set<string>(),
		curatorEngine: () =>
			opts.refuse
				? { ok: false, envelope: { error: "No model configured — set up your models first", code: "models_not_configured", missing: ["cheap"] } }
				: { ok: true, engine: () => opts.engine },
		now: () => opts.now ?? new Date(2026, 9, 27, 12, 0),
	};
	return { deps, anki, graphStore };
}
