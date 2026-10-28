import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnkiPickerBody, pickerRowStatus } from "../components/anki/anki-picker.tsx";
import { AnkiDoneBody, AnkiReviewBody, exportCount, groupCounts, LIMIT_REACHED_HINT } from "../components/anki/anki-review.tsx";
import type { AnkiDraftView } from "../components/anki/anki-client.ts";
import { AnkiSectionBody, nextAnkiSettings } from "../components/settings/anki-section.tsx";
import { CardCuratorRow, CARD_CURATOR_UNSET, composeCuratorOverride, type MenuTriggerProps } from "../components/settings/card-curator-row.tsx";
import { toBlobs } from "../components/activity-dock.tsx";
import { ANKI_FACTORY_SETTINGS, type AnkiDraftCard, type AnkiPickerRow } from "../src/core";

/** The Anki UI (fork A16/A17/A19/A23, I6/I14–I17): pure bodies, static render. */

const row = (over: Partial<AnkiPickerRow>): AnkiPickerRow => ({
	id: "chat_a",
	kind: "chat",
	title: "Carnot",
	date: "2026-10-21T10:00:00Z",
	updatedAt: "2026-10-21T10:00:00Z",
	propositions: 5,
	candidates: 5,
	exported: 0,
	declined: 0,
	lastExportAt: null,
	extraction: "complete",
	pendingTurns: 0,
	remaining: 15,
	...over,
});

const card = (nodeId: string, over: Partial<AnkiDraftCard> = {}): AnkiDraftCard => ({
	nodeId,
	type: "basic",
	context: `Ctx ${nodeId}`,
	front: `${nodeId}?`,
	back: `${nodeId}!`,
	origin: "curator",
	ticked: true,
	edited: false,
	...over,
});

function view(cards: AnkiDraftCard[], over: { remaining?: number; exported?: number; stale?: Record<string, "deleted" | "exported">; declined?: AnkiDraftCard[]; newSinceDraft?: number } = {}): AnkiDraftView {
	return {
		draft: {
			version: 1,
			id: "anki_x",
			revision: 2,
			createdAt: "",
			updatedAt: "",
			status: "ready",
			groups: [{ sessionId: "chat_a", kind: "chat", title: "Carnot", status: "done", budget: { normal: 8, max: 15, exportedBefore: 0 }, candidateIds: [], cards }],
		},
		groups: [{ sessionId: "chat_a", stale: over.stale ?? {}, newSinceDraft: over.newSinceDraft ?? 0, exported: over.exported ?? 0, remaining: over.remaining ?? 15, ...(over.declined ? { declined: over.declined } : {}) }],
		effective: ANKI_FACTORY_SETTINGS,
	};
}

const noop = () => {};

describe("anki picker", () => {
	it("status lines per row state (A17, I17)", () => {
		assert.deepEqual(pickerRowStatus(row({})), { line: "never carded", selectable: true, extract: false });
		assert.deepEqual(pickerRowStatus(row({ extraction: "none" })), { line: "not extracted yet", selectable: false, extract: true });
		assert.deepEqual(pickerRowStatus(row({ extraction: "pending", pendingTurns: 3 })), {
			line: "3 turns pending — cards only from what's extracted so far",
			selectable: true,
			extract: true,
		});
		assert.deepEqual(pickerRowStatus(row({ extraction: "running" })), { line: "extracting…", selectable: false, extract: false });
		assert.deepEqual(pickerRowStatus(row({ remaining: 0, exported: 15 })), { line: "limit reached", selectable: false, extract: false });
		assert.deepEqual(pickerRowStatus(row({ candidates: 0, exported: 4 })), { line: "all carded", selectable: false, extract: false });
		assert.match(pickerRowStatus(row({ exported: 4, lastExportAt: "2026-10-25T10:00:00Z" })).line, /^4 cards · last export /);
	});

	it("renders rows, the Extract first action, and the start count", () => {
		const html = renderToStaticMarkup(
			<AnkiPickerBody
				rows={[row({}), row({ id: "chat_b", title: "Fresh", extraction: "none" }), row({ id: "src_1", kind: "file", title: "thermo.md" })]}
				selected={new Set(["chat_a"])}
				busy={false}
				error={null}
				onToggle={noop}
				onExtract={noop}
				onStart={noop}
				onClose={noop}
			/>,
		);
		assert.match(html, /data-testid="anki-extract-chat_b"/);
		assert.doesNotMatch(html, /data-testid="anki-extract-chat_a"/);
		assert.match(html, /notes · /);
		assert.match(html, /Make cards \(1 selected\)/);
	});
});

describe("anki review", () => {
	it("ticked by default, extras show their reason, export count and usage", () => {
		const v = view([card("n_1"), card("n_2", { coverageReason: "the key condition" }), card("n_3", { ticked: false })], { exported: 2 });
		const html = renderToStaticMarkup(
			<AnkiReviewBody view={v} showDeclined={false} busy={false} error={null} onEdit={noop} onToggleDeclined={noop} onDiscard={noop} onExport={noop} />,
		);
		assert.match(html, /Extra: the key condition/);
		assert.match(html, /4 of 15 used/);
		assert.match(html, /Export 2 cards…/);
		assert.equal(exportCount(v), 2);
	});

	it("the hard cap disables unticked cards once the remaining budget is used (I6)", () => {
		const v = view([card("n_1"), card("n_2", { ticked: false })], { remaining: 1, exported: 14 });
		assert.deepEqual(groupCounts(v.draft.groups[0]!, v.groups[0]!), { ticked: 1, used: 15, canTickMore: false });
		const html = renderToStaticMarkup(
			<AnkiReviewBody view={v} showDeclined={false} busy={false} error={null} onEdit={noop} onToggleDeclined={noop} onDiscard={noop} onExport={noop} />,
		);
		assert.ok(html.includes(LIMIT_REACHED_HINT));
	});

	it("stale cards are greyed and not counted; new propositions are noted (I16)", () => {
		const v = view([card("n_1"), card("n_gone")], { stale: { n_gone: "deleted" }, newSinceDraft: 2 });
		const html = renderToStaticMarkup(
			<AnkiReviewBody view={v} showDeclined={false} busy={false} error={null} onEdit={noop} onToggleDeclined={noop} onDiscard={noop} onExport={noop} />,
		);
		assert.match(html, /data-testid="anki-stale-n_gone">source deleted/);
		assert.match(html, /2 new propositions since this draft/);
		assert.equal(exportCount(v), 1);
	});

	it("show declined appends the declined rows unticked; zero ticks offers decline-all", () => {
		const v = view([card("n_1", { ticked: false })], { declined: [card("n_9", { origin: "declined", ticked: false })] });
		const html = renderToStaticMarkup(
			<AnkiReviewBody view={v} showDeclined busy={false} error={null} onEdit={noop} onToggleDeclined={noop} onDiscard={noop} onExport={noop} />,
		);
		assert.match(html, /data-testid="anki-card-n_9"/);
		assert.match(html, /declined earlier/);
		assert.match(html, /Decline all and close/);
		const hidden = renderToStaticMarkup(
			<AnkiReviewBody view={v} showDeclined={false} busy={false} error={null} onEdit={noop} onToggleDeclined={noop} onDiscard={noop} onExport={noop} />,
		);
		assert.doesNotMatch(hidden, /anki-card-n_9/);
	});

	it("done: where the file went and how to import it", () => {
		const html = renderToStaticMarkup(<AnkiDoneBody result={{ savedTo: "/Users/me/cards.txt", exported: 3, declined: 1 }} onClose={noop} />);
		assert.match(html, /Exported 3 cards to \/Users\/me\/cards\.txt\./);
		assert.match(html, /File › Import…/);
		assert.match(renderToStaticMarkup(<AnkiDoneBody result={{ savedTo: "download", exported: 1, declined: 0 }} onClose={noop} />), /to your downloads/);
	});
});

describe("anki settings + curator row + dock", () => {
	it("the Anki section shows factory placeholders and composes deltas", () => {
		const html = renderToStaticMarkup(<AnkiSectionBody settings={{ version: 1 }} effective={ANKI_FACTORY_SETTINGS} error={null} onCommit={noop} />);
		assert.match(html, /placeholder="8"/);
		assert.match(html, /placeholder="15"/);
		assert.match(html, /placeholder="Basic \(and reversed card\)"/);
		assert.deepEqual(nextAnkiSettings({ version: 1, maxCardsPerSession: 20 }, "normalCardsPerSession", "6"), { version: 1, maxCardsPerSession: 20, normalCardsPerSession: 6 });
		assert.deepEqual(nextAnkiSettings({ version: 1, basicNoteType: "Einfach" }, "basicNoteType", ""), { version: 1 });
	});

	it("the card curator row reads 'Same as Cheap' when unset; overrides compose and reset (I14)", () => {
		const Trigger = ({ value, emptyLabel, testid }: MenuTriggerProps) => <button data-testid={testid}>{value || emptyLabel}</button>;
		const unset = renderToStaticMarkup(<CardCuratorRow agent={undefined} cheap={undefined} catalog={[]} Trigger={Trigger} onSectionChange={noop} />);
		assert.ok(unset.includes(`data-testid="role-model-cardCurator">${CARD_CURATOR_UNSET}`));
		assert.doesNotMatch(unset, /card-curator-reset/);
		const agent = composeCuratorOverride({ tools: { research: true } }, { provider: "openrouter", id: "x/model", thinkingLevel: "low" });
		assert.deepEqual(agent, { tools: { research: true }, models: { cardCurator: { model: { provider: "openrouter", id: "x/model" }, thinkingLevel: "low" } } });
		const set = renderToStaticMarkup(<CardCuratorRow agent={agent} cheap={undefined} catalog={[]} Trigger={Trigger} onSectionChange={noop} />);
		assert.match(set, /card-curator-reset/);
		assert.deepEqual(composeCuratorOverride(agent, null), { tools: { research: true } });
	});

	it("the dock folds curations into blobs with cost and progress (I15)", () => {
		const blobs = toBlobs({
			jobs: [],
			extractions: [],
			curations: [{ id: "anki_x", title: "Anki cards · 2 sessions", sessions: 2, settled: 1, startedAt: 5, costUsd: 0.012, model: "openrouter:x" }],
		});
		assert.equal(blobs.length, 1);
		assert.equal(blobs[0]!.process, "curation");
		assert.equal(blobs[0]!.id, "anki_x");
		assert.equal(blobs[0]!.cost, 0.012);
		assert.equal(blobs[0]!.activity, "1/2 sessions");
	});
});
