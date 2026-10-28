/**
 * The curation JOB (FORK-ONLY, A18, I7/I8): one job per picker submit. The
 * curator runs once per session, in parallel, under the shared 3-permit
 * background semaphore; each session settles its own draft group (one
 * failure never takes the others down). Progress lives in the draft
 * (data/anki/draft.json) — the job registry only carries what the dock
 * needs while it runs (abort handle, live usage).
 *
 * Dependencies arrive injected (the agent-layer law): the AnkiStore and
 * the engine resolver come from the server composition (src/server/anki.ts).
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { CallUsage } from "../../core/contracts/chat.ts";
import type { AnkiCurationRun, AnkiDraft, AnkiDraftGroup, AnkiStore } from "../../core/contracts/anki.ts";
import { emit } from "../../core/events.ts";
import type { PiEngine } from "../models.ts";
import { withBgLlmSlot } from "../subagents/bg-llm-semaphore.ts";
import { callUsage } from "../subagents/extraction.ts";
import { runCardCurator } from "./curator.ts";
import type { CuratorPromptInput } from "./curator-prompt.ts";

/** One running curation, as the registry holds it. */
export interface RunningCuration {
	draftId: string;
	title: string;
	sessions: number;
	settled: number;
	startedAt: number;
	controller: AbortController;
	usage: { model?: string; steps: CallUsage[] };
}

interface LhAnkiGlobal {
	/** globalThis, not module level — Next dev compiles each route as its
	 *  own module instance (the extraction-registry lesson). */
	__lhAnkiCurations?: Map<string, RunningCuration>;
}

function registry(): Map<string, RunningCuration> {
	const g = globalThis as typeof globalThis & LhAnkiGlobal;
	return (g.__lhAnkiCurations ??= new Map());
}

export function runningCurations(): RunningCuration[] {
	return [...registry().values()].sort((a, b) => a.startedAt - b.startedAt);
}

export function isCurationRunning(draftId: string): boolean {
	return registry().has(draftId);
}

/** True cancellation: the in-flight curator calls receive the signal. */
export function abortCuration(draftId: string): boolean {
	const run = registry().get(draftId);
	if (!run) return false;
	run.controller.abort();
	return true;
}

export interface CurationDeps {
	ankiStore: AnkiStore;
	/** The settings-resolved cardCurator engine, read fresh per call. */
	engine: () => PiEngine | undefined;
}

/** sessionId → the curator's input (only groups that need a call). */
export type CurationTasks = Map<string, CuratorPromptInput>;

const isAbort = (err: unknown) => err instanceof Error && err.name === "AbortError";

/** Patch one group of the CURRENT draft (sync read-modify-write — atomic
 *  against the event loop). Returns false when the draft is gone or was
 *  replaced (discarded mid-run): the job stops writing. */
function patchDraft(store: AnkiStore, draftId: string, patch: (draft: AnkiDraft) => void): boolean {
	const draft = store.readDraft();
	if (!draft || draft.id !== draftId) return false;
	patch(draft);
	draft.revision++;
	draft.updatedAt = new Date().toISOString();
	store.writeDraft(draft);
	return true;
}

const settled = (group: AnkiDraftGroup) => group.status === "done" || group.status === "failed" || group.status === "skipped";

/** Run the job to completion (the caller fires and forgets). The draft is
 *  already written with every group queued or skipped. */
export async function runCuration(deps: CurationDeps, draft: AnkiDraft, tasks: CurationTasks): Promise<void> {
	const run: RunningCuration = {
		draftId: draft.id,
		title: `Anki cards · ${draft.groups.length} ${draft.groups.length === 1 ? "session" : "sessions"}`,
		sessions: draft.groups.length,
		settled: draft.groups.filter(settled).length,
		startedAt: Date.now(),
		controller: new AbortController(),
		usage: { steps: [] },
	};
	registry().set(draft.id, run);
	emit("activity-changed", {});
	const signal = run.controller.signal;
	try {
		await Promise.all(
			[...tasks].map(async ([sessionId, input]) => {
				const startedAt = Date.now();
				const steps: CallUsage[] = [];
				let model = "unknown";
				let outcome: AnkiCurationRun["outcome"] = "failed";
				try {
					const cards = await withBgLlmSlot(signal, async () => {
						if (!patchDraft(deps.ankiStore, draft.id, (d) => setGroup(d, sessionId, { status: "curating" }))) {
							run.controller.abort();
						}
						emit("activity-changed", {});
						return runCardCurator({
							input,
							engine: deps.engine(),
							signal,
							sessionId,
							onStep: (usage: Usage, stepModel: string) => {
								model = stepModel;
								const call = callUsage(usage);
								steps.push(call);
								run.usage.model = stepModel;
								run.usage.steps.push(call);
								emit("activity-changed", {});
							},
						});
					});
					outcome = "done";
					patchDraft(deps.ankiStore, draft.id, (d) =>
						setGroup(d, sessionId, {
							status: "done",
							cards: cards.map((card) => ({ ...card, origin: "curator", ticked: true, edited: false })),
						}),
					);
				} catch (err) {
					outcome = isAbort(err) || signal.aborted ? "aborted" : "failed";
					const message = outcome === "aborted" ? "aborted" : err instanceof Error ? err.message : String(err);
					patchDraft(deps.ankiStore, draft.id, (d) => setGroup(d, sessionId, { status: "failed", error: message }));
				} finally {
					run.settled++;
					if (steps.length > 0) {
						deps.ankiStore.appendRun({
							startedAt,
							at: new Date(startedAt).toISOString(),
							durationMs: Date.now() - startedAt,
							draftId: draft.id,
							sessionId,
							title: input.title,
							outcome,
							usage: { model, steps },
						});
					}
					emit("activity-changed", {});
				}
			}),
		);
	} finally {
		patchDraft(deps.ankiStore, draft.id, (d) => {
			for (const group of d.groups) {
				if (!settled(group)) Object.assign(group, { status: "failed", error: "aborted" });
			}
			d.status = "ready";
		});
		registry().delete(draft.id);
		emit("activity-changed", {});
	}
}

function setGroup(draft: AnkiDraft, sessionId: string, patch: Partial<AnkiDraftGroup>): void {
	const group = draft.groups.find((g) => g.sessionId === sessionId);
	if (group) Object.assign(group, patch);
}
