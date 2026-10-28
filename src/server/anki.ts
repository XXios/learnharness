/**
 * The Anki export's server composition (FORK-ONLY — docs/fork/anki-export.md,
 * docs/fork/anki-export-implementation.md). Routes under app/api/anki/ are
 * thin transports over these functions; the pure logic lives in
 * src/core/anki/, the curator + job in src/agent/anki/, storage in
 * src/store/anki.ts.
 *
 * The card ledger (data/anki/cards.jsonl) is written in exactly one place:
 * commitAnkiExport. The graph is only ever read.
 */
import * as path from "node:path";
import { ankiStore as liveAnkiStore } from "../store/anki.ts";
import { stores } from "./stores.ts";
import { callCost } from "./pricing.ts";
import { providerKeyPresent } from "./keys.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { abortCuration, isCurationRunning, runCuration, runningCurations, type CurationTasks } from "../agent/anki/curation.ts";
import { getGraph, type DerivedGraph } from "../core/graph.ts";
import { birthSessionPartition } from "../core/session-clusters.ts";
import { coverageOf } from "../core/coverage.ts";
import { emit } from "../core/events.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { modelsNotConfigured, providerKeyMissing, type ModelsNotConfigured, type ProviderKeyMissing } from "../core/settings.ts";
import { resolveAnkiSettings, parseAnkiSettingsBody } from "../core/anki/settings.ts";
import { ankiBudget, ankiGuid, latestCardStates, sessionCardStats } from "../core/anki/ledger.ts";
import { revalidateGroup, sessionCurationInput, type AnkiStaleReason } from "../core/anki/candidates.ts";
import { ankiExportFileName, buildAnkiExport, localDay, type AnkiExportRow } from "../core/anki/export-format.ts";
import {
	ANKI_DECK,
	type AnkiCardRecord,
	type AnkiCurationActivity,
	type AnkiCurationRun,
	type AnkiDraft,
	type AnkiDraftCard,
	type AnkiDraftGroup,
	type AnkiPickerRow,
	type AnkiSettings,
	type AnkiStore,
	type EffectiveAnkiSettings,
} from "../core/contracts/anki.ts";
import type { ChatStore, GraphStore } from "../core/ports.ts";

export { abortCuration } from "../agent/anki/curation.ts";

/** Everything the Anki composition touches — injectable for tests. */
export interface AnkiDeps {
	ankiStore: AnkiStore;
	chatStore: Pick<ChatStore, "listChats" | "getChat">;
	graphStore: Pick<GraphStore, "readNodes" | "readChains" | "readSources" | "readCoverage">;
	/** "running" extraction source ids. */
	extractingIds: () => ReadonlySet<string>;
	/** The cardCurator engine gate + resolver (null engine = refused). */
	curatorEngine: () =>
		| { ok: true; engine: () => ReturnType<typeof piEngineForSpec> | undefined }
		| { ok: false; envelope: ModelsNotConfigured | ProviderKeyMissing };
	now: () => Date;
}

function liveCuratorEngine(): ReturnType<AnkiDeps["curatorEngine"]> {
	const spec = resolveRoleSpec("cardCurator", stores.settingsStore.readSettings());
	if (!spec) return { ok: false, envelope: modelsNotConfigured(["cheap"]) };
	if (!providerKeyPresent(spec.provider)) return { ok: false, envelope: providerKeyMissing(spec.provider, ["cheap"]) };
	return {
		ok: true,
		// Read FRESH per call (a settings PUT mid-job lands), like the job runner.
		engine: () => {
			const fresh = resolveRoleSpec("cardCurator", stores.settingsStore.readSettings());
			return fresh ? piEngineForSpec(fresh) : undefined;
		},
	};
}

export const liveAnkiDeps: AnkiDeps = {
	ankiStore: liveAnkiStore,
	chatStore: stores.chatStore,
	graphStore: stores.graphStore,
	extractingIds: () => new Set(extractionStatuses().map((run) => run.chatId)),
	curatorEngine: liveCuratorEngine,
	now: () => new Date(),
};

// ─── settings ────────────────────────────────────────────────────────────────

export function ankiSettingsView(deps: AnkiDeps = liveAnkiDeps): { settings: AnkiSettings | null; effective: EffectiveAnkiSettings } {
	const settings = deps.ankiStore.readSettings();
	return { settings, effective: resolveAnkiSettings(settings) };
}

export function putAnkiSettings(body: unknown, deps: AnkiDeps = liveAnkiDeps): { ok: true; settings: AnkiSettings; effective: EffectiveAnkiSettings } | { ok: false; error: string } {
	const parsed = parseAnkiSettingsBody(body);
	if (!parsed.ok) return parsed;
	deps.ankiStore.writeSettings(parsed.settings);
	return { ok: true, settings: parsed.settings, effective: resolveAnkiSettings(parsed.settings) };
}

// ─── sessions (the picker) ───────────────────────────────────────────────────

interface SessionFacts {
	id: string;
	kind: "chat" | "file";
	title: string;
	createdAt: string | null;
	updatedAt: string | null;
}

/** Every teaching chat + every imported notes file (I4). */
function sessionFacts(deps: AnkiDeps): SessionFacts[] {
	const chats: SessionFacts[] = deps.chatStore
		.listChats()
		.filter((chat) => (chat.kind ?? "teach") === "teach")
		.map((chat) => ({ id: chat.id, kind: "chat", title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt }));
	const files: SessionFacts[] = deps.graphStore.readSources().map((source) => ({
		id: source.id,
		kind: "file",
		title: path.basename(source.filePath),
		createdAt: source.importedAt,
		updatedAt: source.importedAt,
	}));
	return [...chats, ...files];
}

const dayOf = (iso: string | null): string | null => {
	if (!iso) return null;
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? null : localDay(date);
};

export function ankiPickerRows(deps: AnkiDeps = liveAnkiDeps): AnkiPickerRow[] {
	const graph = getGraph(deps.graphStore);
	const born = new Map(birthSessionPartition(graph.nodes).map((c) => [c.id, c.members]));
	const states = latestCardStates(deps.ankiStore.readCards());
	const settings = resolveAnkiSettings(deps.ankiStore.readSettings());
	const coverage = deps.graphStore.readCoverage();
	const extracting = deps.extractingIds();
	const rows = sessionFacts(deps).map((facts): AnkiPickerRow => {
		const members = born.get(facts.id) ?? [];
		const stats = sessionCardStats(states, facts.id);
		let extraction: AnkiPickerRow["extraction"] = "complete";
		let pendingTurns = 0;
		if (extracting.has(facts.id)) extraction = "running";
		else if (facts.kind === "chat") {
			const record = deps.chatStore.getChat(facts.id);
			pendingTurns = record ? coverageOf(record.messages, coverage, facts.id).uncoveredCount : 0;
			if (pendingTurns > 0) extraction = members.length === 0 ? "none" : "pending";
		}
		return {
			id: facts.id,
			kind: facts.kind,
			title: facts.title,
			date: facts.createdAt,
			updatedAt: facts.updatedAt,
			propositions: members.length,
			candidates: members.filter((id) => !states.has(id)).length,
			exported: stats.exported,
			declined: stats.declined,
			lastExportAt: stats.lastExportAt,
			extraction,
			pendingTurns,
			remaining: ankiBudget(settings, stats.exported).remaining,
		};
	});
	return rows.sort(
		(a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || (a.id < b.id ? -1 : 1),
	);
}

// ─── starting a curation ─────────────────────────────────────────────────────

export type AnkiStartOutcome =
	| { ok: true; draft: AnkiDraft }
	| { ok: false; status: 400 | 409; error: string }
	| { ok: false; status: 503; envelope: ModelsNotConfigured | ProviderKeyMissing };

export function startAnkiCuration(sessionIds: unknown, deps: AnkiDeps = liveAnkiDeps): AnkiStartOutcome {
	if (!Array.isArray(sessionIds) || sessionIds.length === 0 || !sessionIds.every((id) => typeof id === "string")) {
		return { ok: false, status: 400, error: "Body must be {sessionIds: string[]} with at least one id" };
	}
	const ids = [...new Set(sessionIds as string[])];
	if (deps.ankiStore.readDraft()) {
		return { ok: false, status: 409, error: "A draft already exists — export or discard it first" };
	}
	const rows = new Map(ankiPickerRows(deps).map((row) => [row.id, row]));
	const unknown = ids.find((id) => !rows.has(id));
	if (unknown) return { ok: false, status: 400, error: `Unknown session: ${unknown}` };
	const gate = deps.curatorEngine();
	if (!gate.ok) return { ok: false, status: 503, envelope: gate.envelope };

	const graph = getGraph(deps.graphStore);
	const states = latestCardStates(deps.ankiStore.readCards());
	const settings = resolveAnkiSettings(deps.ankiStore.readSettings());
	const nameOf = nameLookup(graph);
	const tasks: CurationTasks = new Map();
	const groups: AnkiDraftGroup[] = ids.map((id) => {
		const row = rows.get(id)!;
		const budget = ankiBudget(settings, row.exported);
		const input = sessionCurationInput(graph, states, id);
		const group: AnkiDraftGroup = {
			sessionId: id,
			kind: row.kind,
			title: row.title,
			status: "queued",
			budget: { normal: budget.normal, max: budget.max, exportedBefore: budget.exportedBefore },
			candidateIds: input.candidates.map((n) => n.id),
			cards: [],
		};
		if (row.extraction === "none") return { ...group, status: "skipped", error: "not extracted yet" };
		if (budget.remaining === 0) return { ...group, status: "skipped", error: "limit reached" };
		if (input.candidates.length === 0) return { ...group, status: "skipped", error: "nothing new to card" };
		tasks.set(id, {
			title: row.title,
			kind: row.kind,
			day: dayOf(row.date),
			budget: { remaining: budget.remaining, normalRemaining: budget.normalRemaining },
			candidates: input.candidates,
			context: input.context,
			carded: input.carded,
			chains: input.chains,
			nameOf,
		});
		return group;
	});
	const now = deps.now().toISOString();
	const draft: AnkiDraft = {
		version: 1,
		id: `anki_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
		revision: 1,
		createdAt: now,
		updatedAt: now,
		status: tasks.size > 0 ? "curating" : "ready",
		groups,
	};
	deps.ankiStore.writeDraft(draft);
	if (tasks.size > 0) {
		void runCuration({ ankiStore: deps.ankiStore, engine: gate.engine }, draft, tasks).catch((err: unknown) => {
			console.error(`[anki ${draft.id}] curation failed:`, err);
		});
	}
	emit("activity-changed", {});
	return { ok: true, draft };
}

function nameLookup(graph: DerivedGraph): (id: string) => string {
	const names = new Map(graph.nodes.map((n) => [n.id, n.name]));
	return (id) => names.get(id) ?? id;
}

// ─── the draft ───────────────────────────────────────────────────────────────

/** Per-group facts the review list derives at read time (never stored). */
export interface AnkiGroupView {
	sessionId: string;
	/** nodeId → why the card can't be exported (I16). */
	stale: Record<string, AnkiStaleReason>;
	newSinceDraft: number;
	/** Exported cards of the session NOW (the "N of max used" numerator). */
	exported: number;
	/** Cards the session may still get under the CURRENT settings. */
	remaining: number;
	/** "Show declined": the session's declined ledger cards not in the draft. */
	declined?: AnkiDraftCard[];
}

export interface AnkiDraftView {
	draft: AnkiDraft;
	groups: AnkiGroupView[];
	effective: EffectiveAnkiSettings;
}

/** The draft, with restart recovery: a "curating" draft whose job is not
 *  in this process's registry was interrupted (server restart). */
function readDraftRecovered(deps: AnkiDeps): AnkiDraft | null {
	const draft = deps.ankiStore.readDraft();
	if (!draft || draft.status !== "curating" || isCurationRunning(draft.id)) return draft;
	for (const group of draft.groups) {
		if (group.status === "queued" || group.status === "curating") {
			group.status = "failed";
			group.error = "interrupted — discard and try again";
		}
	}
	draft.status = "ready";
	draft.revision++;
	draft.updatedAt = deps.now().toISOString();
	deps.ankiStore.writeDraft(draft);
	return draft;
}

export function ankiDraftView(includeDeclined: boolean, deps: AnkiDeps = liveAnkiDeps): AnkiDraftView | null {
	const draft = readDraftRecovered(deps);
	if (!draft) return null;
	const graph = getGraph(deps.graphStore);
	const live = new Set(graph.nodes.map((n) => n.id));
	const states = latestCardStates(deps.ankiStore.readCards());
	const settings = resolveAnkiSettings(deps.ankiStore.readSettings());
	const groups = draft.groups.map((group): AnkiGroupView => {
		const current = sessionCurationInput(graph, states, group.sessionId).candidates.map((n) => n.id);
		const { stale, newSinceDraft } = revalidateGroup(group, live, states, current);
		const exported = sessionCardStats(states, group.sessionId).exported;
		const view: AnkiGroupView = {
			sessionId: group.sessionId,
			stale: Object.fromEntries(stale),
			newSinceDraft,
			exported,
			remaining: ankiBudget(settings, exported).remaining,
		};
		if (includeDeclined) {
			const inDraft = new Set(group.cards.map((c) => c.nodeId));
			view.declined = [...states.values()]
				.filter((r) => r.state === "declined" && r.sessionId === group.sessionId && !inDraft.has(r.nodeId) && live.has(r.nodeId))
				.map(declinedCard);
		}
		return view;
	});
	return { draft, groups, effective: settings };
}

function declinedCard(record: AnkiCardRecord): AnkiDraftCard {
	return {
		nodeId: record.nodeId,
		type: record.type,
		context: record.context,
		front: record.front,
		back: record.back,
		...(record.coverageReason ? { coverageReason: record.coverageReason } : {}),
		origin: "declined",
		ticked: false,
		edited: false,
	};
}

/** One review edit (A19): tick, type, or text. A nodeId not yet in the
 *  group but declined in the ledger joins it ("show declined"). */
export interface AnkiCardEdit {
	sessionId: string;
	nodeId: string;
	ticked?: boolean;
	type?: "basic" | "reversed";
	context?: string;
	front?: string;
	back?: string;
}

export type AnkiPatchOutcome = { ok: true; draft: AnkiDraft } | { ok: false; status: 400 | 404 | 409; error: string };

export function patchAnkiDraft(revision: unknown, edits: unknown, deps: AnkiDeps = liveAnkiDeps): AnkiPatchOutcome {
	const draft = readDraftRecovered(deps);
	if (!draft) return { ok: false, status: 404, error: "No draft" };
	if (revision !== draft.revision) return { ok: false, status: 409, error: "The draft changed — reload it" };
	if (draft.status !== "ready") return { ok: false, status: 409, error: "The draft is still being curated" };
	if (!Array.isArray(edits)) return { ok: false, status: 400, error: "Body must be {revision, edits: []}" };
	const states = latestCardStates(deps.ankiStore.readCards());
	const settings = resolveAnkiSettings(deps.ankiStore.readSettings());
	const live = new Set(getGraph(deps.graphStore).nodes.map((n) => n.id));
	for (const raw of edits as AnkiCardEdit[]) {
		if (!raw || typeof raw.sessionId !== "string" || typeof raw.nodeId !== "string") {
			return { ok: false, status: 400, error: "Each edit needs {sessionId, nodeId}" };
		}
		const group = draft.groups.find((g) => g.sessionId === raw.sessionId);
		if (!group) return { ok: false, status: 400, error: `Unknown session in draft: ${raw.sessionId}` };
		let card = group.cards.find((c) => c.nodeId === raw.nodeId);
		if (!card) {
			const record = states.get(raw.nodeId);
			if (!record || record.state !== "declined" || record.sessionId !== raw.sessionId) {
				return { ok: false, status: 400, error: `Unknown card: ${raw.nodeId}` };
			}
			card = declinedCard(record);
			group.cards.push(card);
		}
		for (const field of ["context", "front", "back"] as const) {
			const value = raw[field];
			if (value === undefined) continue;
			if (typeof value !== "string" || value.trim() === "") return { ok: false, status: 400, error: `${field} must be non-empty text` };
			if (value !== card[field]) {
				card[field] = value;
				card.edited = true;
			}
		}
		if (raw.type !== undefined) {
			if (raw.type !== "basic" && raw.type !== "reversed") return { ok: false, status: 400, error: "type must be basic or reversed" };
			if (raw.type !== card.type) {
				card.type = raw.type;
				card.edited = true;
			}
		}
		if (raw.ticked !== undefined) {
			if (typeof raw.ticked !== "boolean") return { ok: false, status: 400, error: "ticked must be a boolean" };
			card.ticked = raw.ticked;
		}
		// I6: the hard cap — ticked, exportable cards never exceed what the
		// session may still get.
		const remaining = ankiBudget(settings, sessionCardStats(states, group.sessionId).exported).remaining;
		const ticked = group.cards.filter((c) => c.ticked && live.has(c.nodeId) && states.get(c.nodeId)?.state !== "exported").length;
		if (ticked > remaining) return { ok: false, status: 409, error: "limit reached — raise it in Settings › Anki" };
	}
	draft.revision++;
	draft.updatedAt = deps.now().toISOString();
	deps.ankiStore.writeDraft(draft);
	return { ok: true, draft };
}

/** Discard (I8): aborts a running job, deletes the draft. Ledger untouched. */
export function discardAnkiDraft(deps: AnkiDeps = liveAnkiDeps): boolean {
	const draft = deps.ankiStore.readDraft();
	if (!draft) return false;
	abortCuration(draft.id);
	deps.ankiStore.deleteDraft();
	emit("activity-changed", {});
	return true;
}

// ─── export ──────────────────────────────────────────────────────────────────

export interface AnkiExportPlan {
	fileName: string | null;
	text: string;
	exported: number;
	declined: number;
	lines: AnkiCardRecord[];
}

export type AnkiExportOutcome = { ok: true; plan: AnkiExportPlan } | { ok: false; status: 404 | 409; error: string };

/** Build the export without writing anything — the preview and the commit
 *  share it, so the desktop's saved file and the committed ledger agree. */
function planExport(revision: unknown, deps: AnkiDeps): AnkiExportOutcome {
	const draft = readDraftRecovered(deps);
	if (!draft) return { ok: false, status: 404, error: "No draft" };
	if (revision !== draft.revision) return { ok: false, status: 409, error: "The draft changed — reload it" };
	if (draft.status !== "ready") return { ok: false, status: 409, error: "The draft is still being curated" };
	const graph = getGraph(deps.graphStore);
	const live = new Set(graph.nodes.map((n) => n.id));
	const states = latestCardStates(deps.ankiStore.readCards());
	const settings = resolveAnkiSettings(deps.ankiStore.readSettings());
	const facts = new Map(sessionFacts(deps).map((f) => [f.id, f]));
	const now = deps.now();
	const at = now.toISOString();
	const fileName = ankiExportFileName(localDay(now));
	const rows: AnkiExportRow[] = [];
	const lines: AnkiCardRecord[] = [];
	for (const group of draft.groups) {
		const session = facts.get(group.sessionId);
		const sessionTitle = session?.title ?? group.title;
		const remaining = ankiBudget(settings, sessionCardStats(states, group.sessionId).exported).remaining;
		const exportable = group.cards.filter((card) => live.has(card.nodeId) && states.get(card.nodeId)?.state !== "exported");
		if (exportable.filter((card) => card.ticked).length > remaining) {
			return { ok: false, status: 409, error: `${sessionTitle}: limit reached — raise it in Settings › Anki` };
		}
		for (const card of exportable) {
			if (!card.ticked && card.origin === "declined") continue; // already declined
			const { origin: _origin, ticked, edited: _edited, ...curated } = card;
			const line: AnkiCardRecord = {
				...curated,
				guid: ankiGuid(card.nodeId),
				state: ticked ? "exported" : "declined",
				sessionId: group.sessionId,
				sessionTitle,
				deck: ANKI_DECK,
				at,
			};
			if (ticked) {
				rows.push({ card: curated, sessionTitle, sessionDay: dayOf(session?.createdAt ?? null) });
			}
			lines.push(line);
		}
	}
	const exported = rows.length;
	return {
		ok: true,
		plan: {
			fileName: exported > 0 ? fileName : null,
			text: exported > 0 ? buildAnkiExport(rows, settings) : "",
			exported,
			declined: lines.length - exported,
			lines,
		},
	};
}

export function ankiExportPreview(revision: unknown, deps: AnkiDeps = liveAnkiDeps): AnkiExportOutcome {
	return planExport(revision, deps);
}

/** THE ledger write (I9): exported + declined lines in one append, the
 *  file copy under data/anki/exports/, then the draft goes. `savedAs` is
 *  the name the desktop Save dialog actually wrote (recorded on the lines). */
export function commitAnkiExport(revision: unknown, savedAs: string | undefined, deps: AnkiDeps = liveAnkiDeps): AnkiExportOutcome {
	const planned = planExport(revision, deps);
	if (!planned.ok) return planned;
	const { plan } = planned;
	let fileName = plan.fileName;
	if (fileName !== null) {
		const recorded = savedAs ? path.basename(savedAs) : fileName;
		deps.ankiStore.saveExportCopy(fileName, plan.text);
		fileName = recorded;
		for (const line of plan.lines) if (line.state === "exported") line.exportFile = recorded;
	}
	deps.ankiStore.appendCards(plan.lines);
	deps.ankiStore.deleteDraft();
	emit("activity-changed", {});
	return { ok: true, plan: { ...plan, fileName } };
}

// ─── dock + cost (I15) ───────────────────────────────────────────────────────

/** Running curations for the activity feed, cost joined server-side. */
export function curationActivity(): AnkiCurationActivity[] {
	return runningCurations().map((run) => {
		let cost: number | null = run.usage.steps.length > 0 ? 0 : null;
		for (const step of run.usage.steps) {
			const c = run.usage.model ? callCost(step, run.usage.model) : null;
			if (c === null) {
				cost = null;
				break;
			}
			cost! += c;
		}
		return {
			id: run.draftId,
			title: run.title,
			sessions: run.sessions,
			settled: run.settled,
			startedAt: run.startedAt,
			costUsd: cost,
			...(run.usage.model ? { model: run.usage.model } : {}),
		};
	});
}

/** Every curator call's usage — the cost pill's "Anki cards" stage. */
export function ankiCostRuns(deps: Pick<AnkiDeps, "ankiStore"> = liveAnkiDeps): AnkiCurationRun[] {
	return deps.ankiStore.readRuns();
}
