import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { latestCardStates } from "../src/core/anki/ledger.ts";
import type { AnkiDraft, AnkiDraftCard } from "../src/core/contracts/anki.ts";
import { ankiDraftView, ankiExportPreview, ankiPickerRows, commitAnkiExport, patchAnkiDraft } from "../src/server/anki.ts";
import { ankiDeps, node } from "./fixtures/anki.ts";

/**
 * Review edits + the export commit (fork A7/A13/A14/A19, I5/I6/I9/I16):
 * the ONLY ledger write — exported + declined in one append, the file
 * copy, the draft deleted; stale revisions refused; deleted sources and
 * already-exported nodes skipped; the hard cap enforced.
 */

const curated = (nodeId: string, extra: Partial<AnkiDraftCard> = {}): AnkiDraftCard => ({
	nodeId,
	type: "basic",
	context: `Ctx › ${nodeId}`,
	front: `${nodeId}?`,
	back: `${nodeId}!`,
	origin: "curator",
	ticked: true,
	edited: false,
	...extra,
});

function draftWith(cards: AnkiDraftCard[], sessionId = "chat_a"): AnkiDraft {
	return {
		version: 1,
		id: "anki_test",
		revision: 1,
		createdAt: "2026-10-27T00:00:00Z",
		updatedAt: "2026-10-27T00:00:00Z",
		status: "ready",
		groups: [
			{ sessionId, kind: "chat", title: "Old title", status: "done", budget: { normal: 8, max: 15, exportedBefore: 0 }, candidateIds: cards.map((c) => c.nodeId), cards },
		],
	};
}

const chats = [{ id: "chat_a", title: "Carnot cycle", createdAt: "2026-10-21T10:00:00Z" }];

function setup(cards: AnkiDraftCard[], nodeIds = ["n_1", "n_2", "n_3"], settings = null as null | { version: 1; maxCardsPerSession?: number; normalCardsPerSession?: number }) {
	const fixture = ankiDeps({ nodes: nodeIds.map((id) => node(id, "chat_a")), chats, settings });
	fixture.deps.ankiStore.writeDraft(draftWith(cards));
	return fixture;
}

describe("anki export commit", () => {
	it("ticked → exported, unticked curator cards → declined, one append; copy saved; draft deleted", () => {
		const { deps, anki } = setup([curated("n_1"), curated("n_2", { ticked: false }), curated("n_3")]);
		const result = commitAnkiExport(1, undefined, deps);
		assert.equal(result.ok, true);
		const plan = (result as { plan: { fileName: string; exported: number; declined: number; text: string } }).plan;
		assert.equal(plan.fileName, "learnharness-anki-2026-10-27.txt");
		assert.equal(plan.exported, 2);
		assert.equal(plan.declined, 1);
		assert.equal(anki.cardWrites(), 1, "one append for the batch");
		const states = latestCardStates(anki.store.readCards());
		assert.equal(states.get("n_1")?.state, "exported");
		assert.equal(states.get("n_1")?.exportFile, "learnharness-anki-2026-10-27.txt");
		assert.equal(states.get("n_1")?.sessionTitle, "Carnot cycle", "the CURRENT title, not the draft's");
		assert.equal(states.get("n_2")?.state, "declined");
		assert.equal(states.get("n_3")?.guid, "lh_n_3");
		assert.equal(anki.exports.get("learnharness-anki-2026-10-27.txt"), plan.text);
		assert.match(plan.text, /lh_n_1\tBasic\tLearnHarness\t/);
		assert.match(plan.text, /LearnHarness · Carnot cycle · 2026-10-21/);
		assert.doesNotMatch(plan.text, /lh_n_2/);
		assert.equal(deps.ankiStore.readDraft(), null);
		const row = ankiPickerRows(deps)[0]!;
		assert.equal(row.exported, 2);
		assert.equal(row.declined, 1);
		assert.equal(row.candidates, 0);
		assert.equal(row.remaining, 13);
	});

	it("preview writes nothing and matches the commit byte-for-byte", () => {
		const { deps, anki } = setup([curated("n_1"), curated("n_2")]);
		const preview = ankiExportPreview(1, deps);
		assert.equal(preview.ok, true);
		assert.equal(anki.cardWrites(), 0);
		assert.ok(deps.ankiStore.readDraft());
		const commit = commitAnkiExport(1, "/Users/me/Desktop/my-cards.txt", deps);
		assert.equal((commit as { plan: { text: string } }).plan.text, (preview as { plan: { text: string } }).plan.text);
		assert.equal(latestCardStates(anki.store.readCards()).get("n_1")?.exportFile, "my-cards.txt", "the name the dialog actually saved");
	});

	it("a stale revision or a missing draft is refused", () => {
		const { deps } = setup([curated("n_1")]);
		assert.deepEqual(commitAnkiExport(7, undefined, deps), { ok: false, status: 409, error: "The draft changed — reload it" });
		deps.ankiStore.deleteDraft();
		assert.equal((commitAnkiExport(1, undefined, deps) as { status: number }).status, 404);
	});

	it("a deleted source and an already-exported node are skipped (I16, A14)", () => {
		const { deps, anki } = setup([curated("n_1"), curated("n_2"), curated("n_gone")]);
		anki.store.appendCards([{ nodeId: "n_2", guid: "lh_n_2", state: "exported", sessionId: "chat_a", sessionTitle: "x", deck: "LearnHarness", type: "basic", context: "c", front: "f", back: "b", at: "2026-10-26T00:00:00Z" }]);
		const view = ankiDraftView(false, deps)!;
		assert.deepEqual(view.groups[0]!.stale, { n_2: "exported", n_gone: "deleted" });
		const result = commitAnkiExport(view.draft.revision, undefined, deps) as { plan: { text: string; exported: number } };
		assert.equal(result.plan.exported, 1);
		assert.doesNotMatch(result.plan.text, /lh_n_2|lh_n_gone/);
		assert.equal(anki.store.readCards().filter((l) => l.nodeId === "n_2").length, 1, "no second line for the exported node");
	});

	it("zero ticked cards: declines recorded, no file written", () => {
		const { deps, anki } = setup([curated("n_1", { ticked: false })]);
		const result = commitAnkiExport(1, undefined, deps) as { plan: { fileName: string | null; text: string; declined: number } };
		assert.equal(result.plan.fileName, null);
		assert.equal(result.plan.text, "");
		assert.equal(result.plan.declined, 1);
		assert.equal(anki.exports.size, 0);
		assert.equal(deps.ankiStore.readDraft(), null);
	});

	it("show declined: a declined card can be re-ticked through PATCH and exported", () => {
		const { deps, anki } = setup([curated("n_1")]);
		anki.store.appendCards([{ nodeId: "n_3", guid: "lh_n_3", state: "declined", sessionId: "chat_a", sessionTitle: "x", deck: "LearnHarness", type: "reversed", context: "c3", front: "Term", back: "Definition", at: "2026-10-26T00:00:00Z" }]);
		const view = ankiDraftView(true, deps)!;
		assert.deepEqual(view.groups[0]!.declined!.map((c) => [c.nodeId, c.ticked, c.origin]), [["n_3", false, "declined"]]);
		const patched = patchAnkiDraft(1, [{ sessionId: "chat_a", nodeId: "n_3", ticked: true }], deps);
		assert.equal(patched.ok, true);
		const result = commitAnkiExport(2, undefined, deps) as { plan: { text: string; exported: number } };
		assert.equal(result.plan.exported, 2);
		assert.match(result.plan.text, /lh_n_3\tBasic \(and reversed card\)/);
		assert.equal(latestCardStates(anki.store.readCards()).get("n_3")?.state, "exported");
	});

	it("an untouched declined card gets no second ledger line", () => {
		const { deps, anki } = setup([curated("n_1")]);
		anki.store.appendCards([{ nodeId: "n_3", guid: "lh_n_3", state: "declined", sessionId: "chat_a", sessionTitle: "x", deck: "LearnHarness", type: "basic", context: "c", front: "f", back: "b", at: "2026-10-26T00:00:00Z" }]);
		patchAnkiDraft(1, [{ sessionId: "chat_a", nodeId: "n_3", front: "edited but unticked" }], deps);
		commitAnkiExport(2, undefined, deps);
		assert.equal(anki.store.readCards().filter((l) => l.nodeId === "n_3").length, 1);
	});

	it("edits: text and type mark the card edited; empty text is refused; stale revision 409", () => {
		const { deps } = setup([curated("n_1")]);
		const ok = patchAnkiDraft(1, [{ sessionId: "chat_a", nodeId: "n_1", front: "Better question?", type: "reversed" }], deps);
		assert.equal(ok.ok, true);
		const card = deps.ankiStore.readDraft()!.groups[0]!.cards[0]!;
		assert.deepEqual([card.front, card.type, card.edited], ["Better question?", "reversed", true]);
		assert.equal((patchAnkiDraft(2, [{ sessionId: "chat_a", nodeId: "n_1", back: " " }], deps) as { status: number }).status, 400);
		assert.equal((patchAnkiDraft(1, [{ sessionId: "chat_a", nodeId: "n_1", ticked: false }], deps) as { status: number }).status, 409);
	});

	it("the hard cap (I6): ticking past the max is refused, and commit re-checks it", () => {
		const { deps, anki } = setup([curated("n_1"), curated("n_2", { ticked: false })], ["n_1", "n_2", "n_3"], { version: 1, maxCardsPerSession: 2, normalCardsPerSession: 1 });
		anki.store.appendCards([{ nodeId: "n_9", guid: "lh_n_9", state: "exported", sessionId: "chat_a", sessionTitle: "x", deck: "LearnHarness", type: "basic", context: "c", front: "f", back: "b", at: "2026-10-26T00:00:00Z" }]);
		const refused = patchAnkiDraft(1, [{ sessionId: "chat_a", nodeId: "n_2", ticked: true }], deps);
		assert.deepEqual(refused, { ok: false, status: 409, error: "limit reached — raise it in Settings › Anki" });
		// The settings shrank under a ticked draft: the commit refuses too.
		deps.ankiStore.writeSettings({ version: 1, maxCardsPerSession: 1, normalCardsPerSession: 1 });
		assert.equal((commitAnkiExport(1, undefined, deps) as { status: number }).status, 409);
		assert.equal(anki.cardWrites(), 1, "only the fixture line — the refused commit wrote nothing");
	});

	it("the picker counts declined cards without using budget (I5)", () => {
		const { deps } = setup([curated("n_1", { ticked: false }), curated("n_2", { ticked: false })]);
		commitAnkiExport(1, undefined, deps);
		const row = ankiPickerRows(deps)[0]!;
		assert.equal(row.declined, 2);
		assert.equal(row.remaining, 15);
		assert.equal(row.candidates, 1);
	});
});
