import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { fillCards, runCardCurator, validateCards } from "../src/agent/anki/curator.ts";
import { cardCuratorInstructions, curatorPrompt, type CuratorPromptInput } from "../src/agent/anki/curator-prompt.ts";
import { ROLE_SLOT } from "../src/core/settings.ts";
import { chain, node } from "./fixtures/anki.ts";

/** The card curator (fork A9–A13, A15): prompt, submit validation, role. */

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

const submit = (cards: unknown[]): FauxResponseStep => () =>
	fauxAssistantMessage([fauxToolCall("submit_cards", { cards } as ToolCall["arguments"], { id: `c-${Math.random()}` })], { stopReason: "toolUse" });

const input: CuratorPromptInput = {
	title: "Carnot cycle",
	kind: "chat",
	day: "2026-10-21",
	budget: { remaining: 3, normalRemaining: 2 },
	candidates: [node("n_a", "chat_a", "Carnot efficiency", "η = 1 − Tc/Th."), node("n_b", "chat_a", "Entropy"), node("n_c", "chat_a", "Reversible")],
	context: [node("n_x", "chat_b", "Second law")],
	carded: [],
	chains: [chain("arg_1", ["n_x", "n_c"], "n_a", "chat_a")],
	nameOf: (id) => ({ n_a: "Carnot efficiency", n_b: "Entropy", n_c: "Reversible", n_x: "Second law" })[id] ?? id,
};

const card = (nodeId: string, extra: Record<string, unknown> = {}) => ({ nodeId, type: "basic", context: "Thermo › x", front: `${nodeId}?`, back: `${nodeId}!`, ...extra });

describe("anki curator", () => {
	it("cardCurator draws from the extractor's slot (A15)", () => {
		assert.equal(ROLE_SLOT.cardCurator, ROLE_SLOT.extractor);
	});

	it("the system prompt carries the session's budget numbers", () => {
		const text = cardCuratorInstructions({ remaining: 7, normalRemaining: 4 });
		assert.match(text, /Propose at most 7 cards\. Aim for at most 4\./);
		assert.match(text, /Every card after the first 4 must carry a coverageReason/);
		assert.doesNotMatch(text, /\{remaining\}|\{normalRemaining\}/);
	});

	it("the prompt lists every section, ids verbatim", () => {
		const text = curatorPrompt(input);
		assert.match(text, /^SESSION: "Carnot cycle" — teaching session, 2026-10-21$/m);
		assert.match(text, /BUDGET: at most 3 cards; aim for 2; cards past 2 need a coverageReason\./);
		assert.match(text, /^ {2}n_a \| Carnot efficiency \| η = 1 − Tc\/Th\.$/m);
		assert.match(text, /CONTEXT[^\n]*\n {2}n_x \| Second law/);
		assert.match(text, /ALREADY CARDED[^\n]*\n {2}\(none\)/);
		assert.match(text, /\[n_x \+ n_c ⇒ n_a\] {2}Second law ∧ Reversible ⇒ Carnot efficiency/);
	});

	it("validation: candidates only, no duplicates, budget, reasons past the normal budget", () => {
		const ids = new Set(["n_a", "n_b", "n_c"]);
		const budget = { remaining: 3, normalRemaining: 2 };
		const fill = (cards: unknown[]) => fillCards({ cards } as never);
		assert.equal(validateCards(fill([card("n_a"), card("n_b")]), ids, budget), null);
		assert.equal(validateCards(fill([]), ids, budget), null);
		assert.match(validateCards(fill([card("n_x")]), ids, budget)!, /not a CANDIDATE/);
		assert.match(validateCards(fill([card("n_a"), card("n_a")]), ids, budget)!, /twice/);
		assert.match(validateCards(fill([card("n_a"), card("n_b"), card("n_c")]), ids, budget)!, /needs a coverageReason/);
		assert.equal(validateCards(fill([card("n_a"), card("n_b"), card("n_c", { coverageReason: "the condition" })]), ids, budget), null);
		assert.match(validateCards(fill([card("n_a"), card("n_b"), card("n_c", { coverageReason: "r" })]), ids, { remaining: 2, normalRemaining: 2 })!, /exceed the budget/);
		assert.match(validateCards(fill([card("n_a", { front: "  " })]), ids, budget)!, /must not be empty/);
	});

	it("a schema-valid but law-breaking submit is retried; the clean one is returned", async () => {
		const engine = fauxEngine([submit([card("n_zzz")]), submit([card("n_a", { type: "reversed", coverageReason: "  " })])]);
		const steps: string[] = [];
		const cards = await runCardCurator({ input, engine, signal: undefined, onStep: (_u, model) => steps.push(model) });
		assert.deepEqual(cards, [{ nodeId: "n_a", type: "reversed", context: "Thermo › x", front: "n_a?", back: "n_a!" }]);
		assert.equal(steps.length, 2, "both model calls billed");
	});

	it("a curator that never submits fails honestly", async () => {
		const engine = fauxEngine([() => fauxAssistantMessage("no tools today"), () => fauxAssistantMessage("still none")]);
		await assert.rejects(runCardCurator({ input, engine, signal: undefined, onStep: () => {} }), /never submitted/);
	});
});
