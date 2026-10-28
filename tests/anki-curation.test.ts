import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { runningCurations } from "../src/agent/anki/curation.ts";
import { subscribe } from "../src/core/events.ts";
import { ankiDraftView, ankiPickerRows, curationActivity, discardAnkiDraft, startAnkiCuration, type AnkiDeps } from "../src/server/anki.ts";
import { ankiDeps, chain, node } from "./fixtures/anki.ts";

/**
 * The curation job (fork A17/A18, I7/I8/I17): picker rows, start gates,
 * per-session groups settling independently, abort/discard, restart
 * recovery, usage records, activity rows.
 */

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

const submitFor = (byPrompt: Record<string, unknown[]>): FauxResponseStep => (context) => {
	const prompt = JSON.stringify(context.messages);
	const key = Object.keys(byPrompt).find((k) => prompt.includes(k));
	if (!key) return fauxAssistantMessage("no matching session");
	return fauxAssistantMessage([fauxToolCall("submit_cards", { cards: byPrompt[key] } as ToolCall["arguments"], { id: `c-${key}` })], { stopReason: "toolUse" });
};

const card = (nodeId: string) => ({ nodeId, type: "basic", context: "Ctx › x", front: `${nodeId}?`, back: `${nodeId}!` });

async function settled(deps: AnkiDeps): Promise<void> {
	for (let i = 0; i < 400; i++) {
		const draft = deps.ankiStore.readDraft();
		if (draft && draft.status === "ready" && runningCurations().length === 0) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("curation never settled");
}

const chats = [
	{ id: "chat_a", title: "Carnot", createdAt: "2026-10-20T10:00:00Z" },
	{ id: "chat_b", title: "Entropy", createdAt: "2026-10-21T10:00:00Z" },
	{ id: "chat_new", title: "Fresh", createdAt: "2026-10-22T10:00:00Z", uncoveredProse: ["Some teaching."] },
	{ id: "chat_p", title: "Practice", createdAt: "2026-10-23T10:00:00Z", kind: "practice" as const },
];
const nodes = [node("n_a1", "chat_a"), node("n_a2", "chat_a"), node("n_b1", "chat_b")];

describe("anki curation", () => {
	it("picker rows: teaching chats + notes files, extraction states, counts; practice hidden", () => {
		const { deps } = ankiDeps({
			nodes: [...nodes, node("n_f1", "src_1")],
			chats: [...chats, { id: "chat_pend", title: "Pending", createdAt: "2026-10-24T10:00:00Z", uncoveredProse: ["More."] }],
			sources: [{ id: "src_1", filePath: "/notes/thermo.md", importedAt: "2026-10-19T10:00:00Z" }],
		});
		const rows = ankiPickerRows(deps);
		assert.deepEqual(rows.map((r) => r.id), ["chat_pend", "chat_new", "chat_b", "chat_a", "src_1"]);
		const byId = new Map(rows.map((r) => [r.id, r]));
		assert.equal(byId.get("chat_new")!.extraction, "none");
		assert.equal(byId.get("chat_pend")!.extraction, "none", "uncovered + no propositions");
		assert.equal(byId.get("chat_a")!.extraction, "complete");
		assert.equal(byId.get("chat_a")!.candidates, 2);
		assert.equal(byId.get("chat_a")!.remaining, 15);
		assert.equal(byId.get("src_1")!.title, "thermo.md");
		assert.equal(byId.get("src_1")!.kind, "file");
	});

	it("a chat with propositions and uncovered turns is 'pending'", () => {
		const { deps } = ankiDeps({ nodes: [node("n_x", "chat_x")], chats: [{ id: "chat_x", title: "X", createdAt: "2026-10-20T10:00:00Z", uncoveredProse: ["later turn"] }] });
		const row = ankiPickerRows(deps)[0]!;
		assert.equal(row.extraction, "pending");
		assert.equal(row.pendingTurns, 1);
	});

	it("start gates: bad body 400, unknown session 400, refusal 503", () => {
		const { deps } = ankiDeps({ nodes, chats, refuse: true });
		assert.deepEqual(startAnkiCuration([], deps), { ok: false, status: 400, error: "Body must be {sessionIds: string[]} with at least one id" });
		assert.equal((startAnkiCuration(["nope"], deps) as { status: number }).status, 400);
		const refused = startAnkiCuration(["chat_a"], deps);
		assert.equal(refused.ok, false);
		assert.equal((refused as { status: number }).status, 503);
		assert.equal(deps.ankiStore.readDraft(), null, "a refusal writes no draft");
	});

	it("one job, one draft: groups settle independently; skipped groups make no call; usage is recorded", async () => {
		const engine = fauxEngine([
			// Steps are consumed in call order across the parallel sessions, so
			// every step answers by session title. Entropy keeps citing a
			// non-candidate id until its turn budget (4) is gone.
			submitFor({ Carnot: [card("n_a1"), card("n_a2")], Entropy: [card("n_bogus")] }),
			submitFor({ Carnot: [card("n_a1"), card("n_a2")], Entropy: [card("n_bogus")] }),
			submitFor({ Entropy: [card("n_bogus")] }),
			submitFor({ Entropy: [card("n_bogus")] }),
			submitFor({ Entropy: [card("n_bogus")] }),
		]);
		const { deps, anki } = ankiDeps({ nodes, chats, engine });
		const events: string[] = [];
		const off = subscribe((e) => events.push(e.type));
		const started = startAnkiCuration(["chat_a", "chat_b", "chat_new"], deps);
		assert.equal(started.ok, true);
		assert.equal(startAnkiCuration(["chat_a"], deps).ok, false, "at most one draft (I8)");
		await settled(deps);
		off();
		const draft = deps.ankiStore.readDraft()!;
		const group = (id: string) => draft.groups.find((g) => g.sessionId === id)!;
		assert.equal(group("chat_a").status, "done");
		assert.deepEqual(group("chat_a").cards.map((c) => [c.nodeId, c.ticked, c.origin]), [["n_a1", true, "curator"], ["n_a2", true, "curator"]]);
		assert.equal(group("chat_b").status, "failed", "a curator that keeps breaking the laws fails its group only");
		assert.equal(group("chat_new").status, "skipped");
		assert.equal(group("chat_new").error, "not extracted yet");
		assert.ok(anki.store.readRuns().some((r) => r.sessionId === "chat_a" && r.outcome === "done" && r.usage.steps.length > 0));
		assert.ok(events.includes("activity-changed"));
	});

	it("limit reached / nothing new: the group is skipped without a model call", async () => {
		const { deps, anki } = ankiDeps({ nodes, chats, settings: { version: 1, maxCardsPerSession: 1, normalCardsPerSession: 1 }, engine: fauxEngine([]) });
		anki.store.appendCards([{ nodeId: "n_b1", guid: "lh_n_b1", state: "exported", sessionId: "chat_b", sessionTitle: "Entropy", deck: "LearnHarness", type: "basic", context: "c", front: "f", back: "b", at: "2026-10-25T00:00:00Z" }]);
		const started = startAnkiCuration(["chat_b"], deps);
		assert.equal(started.ok, true);
		const draft = deps.ankiStore.readDraft()!;
		assert.equal(draft.status, "ready");
		assert.equal(draft.groups[0]!.status, "skipped");
		assert.equal(draft.groups[0]!.error, "limit reached");
	});

	it("discard aborts the running job and deletes the draft; activity shows it while running", async () => {
		// A provider call that only ends when its abort signal fires (the
		// extraction suite's hangingModel).
		const engine = fauxEngine([
			(_context, options) =>
				new Promise((resolve) => {
					const sig = options?.signal;
					if (sig?.aborted) return resolve(fauxAssistantMessage("late"));
					sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
				}),
		]);
		const { deps } = ankiDeps({ nodes, chats, engine });
		assert.equal(startAnkiCuration(["chat_a"], deps).ok, true);
		for (let i = 0; i < 100 && curationActivity().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
		const activity = curationActivity();
		assert.equal(activity.length, 1);
		assert.equal(activity[0]!.title, "Anki cards · 1 session");
		assert.equal(discardAnkiDraft(deps), true);
		for (let i = 0; i < 200 && runningCurations().length > 0; i++) await new Promise((r) => setTimeout(r, 5));
		assert.equal(runningCurations().length, 0);
		assert.equal(deps.ankiStore.readDraft(), null);
	});

	it("restart recovery: a curating draft with no live job becomes ready with failed groups", () => {
		const { deps } = ankiDeps({ nodes, chats });
		deps.ankiStore.writeDraft({
			version: 1,
			id: "anki_orphan",
			revision: 3,
			createdAt: "2026-10-27T00:00:00Z",
			updatedAt: "2026-10-27T00:00:00Z",
			status: "curating",
			groups: [{ sessionId: "chat_a", kind: "chat", title: "Carnot", status: "curating", budget: { normal: 8, max: 15, exportedBefore: 0 }, candidateIds: [], cards: [] }],
		});
		const view = ankiDraftView(false, deps)!;
		assert.equal(view.draft.status, "ready");
		assert.equal(view.draft.groups[0]!.status, "failed");
		assert.match(view.draft.groups[0]!.error!, /interrupted/);
		assert.equal(view.draft.revision, 4);
	});

	it("uses the chains: the curator prompt includes context from other sessions", async () => {
		let seen = "";
		const engine = fauxEngine([
			(context) => {
				seen = JSON.stringify(context.messages);
				return fauxAssistantMessage([fauxToolCall("submit_cards", { cards: [] } as ToolCall["arguments"], { id: "x" })], { stopReason: "toolUse" });
			},
		]);
		const { deps } = ankiDeps({ nodes, chains: [chain("arg_1", ["n_b1"], "n_a1", "chat_a")], chats, engine });
		startAnkiCuration(["chat_a"], deps);
		await settled(deps);
		assert.match(seen, /CONTEXT[^"]*n_b1/);
		assert.equal(deps.ankiStore.readDraft()!.groups[0]!.status, "done");
	});
});
