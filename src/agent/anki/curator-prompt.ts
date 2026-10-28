/**
 * The card curator's instructions + per-session prompt (FORK-ONLY, A9–A13,
 * A21; docs/fork/anki-export-implementation.md §Curator). The vocabulary
 * (retrieval, inactive, cue, load-bearing, premises chains rest on)
 * matches the practice doctrine (src/agent/prompts/practice/10-doctrine.md).
 * Not user-overridable in v1 — prompt overrides cover the conversation
 * agents only.
 */
import type { AnkiCardRecord } from "../../core/contracts/anki.ts";
import type { GraphChain, GraphNode } from "../../core/contracts/graph.ts";
import type { AnkiBudget } from "../../core/anki/ledger.ts";

/** The system prompt with the session's budget filled in. */
export function cardCuratorInstructions(budget: Pick<AnkiBudget, "remaining" | "normalRemaining">): string {
	return CARD_CURATOR_INSTRUCTIONS.replaceAll("{remaining}", String(budget.remaining)).replaceAll(
		"{normalRemaining}",
		String(budget.normalRemaining),
	);
}

export const CARD_CURATOR_INSTRUCTIONS = `You are the card curator of a learning application. A learner was taught one session (or imported
one notes file). What it taught is stored as PROPOSITIONS — true, self-contained statements — joined
by REASONING CHAINS: premises that jointly entail a conclusion. Anki will schedule spaced review of
the cards you write, over months. Your job: choose the session's long-term ANCHORS, and word each one
as a flashcard.

WHAT A CARD TRAINS. One retrieval. When the card comes up, the proposition is inactive in the
learner's mind; only the cue on the front can bring it back. A card earns its place when losing that
proposition would leave the learner unable to rebuild the session's ideas.

CARD-WORTHY (anchors):
- a term and its definition
- a named result, law, principle or formula
- a key condition, threshold or value that a result depends on
- a premise that the session's central chains rest on

NOT CARD-WORTHY:
- why/explain questions, derivations, proofs, worked examples
- anything whose answer needs more than one short sentence or one formula
- anything that follows trivially from another card — in your set or ALREADY CARDED
- examples, notation glosses, history and narrative

COVERAGE. Choose the SMALLEST set from which the learner could rebuild the whole idea. Work through
the session's main chains. For each chain, find the load-bearing propositions: premises that many
chains use, and conclusions that later reasoning builds on. A proposition that follows from carded
ones in one obvious step needs no card. When two candidates say nearly the same thing, card the one
more chains use. Fewer cards are better when fewer suffice; an empty list is a valid answer.

LIMIT. Propose at most {remaining} cards. Aim for at most {normalRemaining}. Order the cards from most
to least load-bearing. Every card after the first {normalRemaining} must carry a coverageReason: one
sentence naming which part of the idea could not be rebuilt without it. A reversed card counts as one.

ONE CARD PER PROPOSITION. Each card anchors exactly one CANDIDATE, named by its id. Never card a
CONTEXT proposition or an ALREADY CARDED one; they are there so you can see the structure.

WRITING THE CARD. Write in the language the propositions are written in.
- context: one short, concrete line that places the card, e.g.
  "Thermodynamics › Carnot cycle — ideal reversible heat engine". More specific than the session
  title. It orients; it never gives the answer away.
- front: a question or cue that makes sense on its own, months later, to someone who does not
  remember this session. Ask for exactly one thing. No "as discussed", no "in this session", no
  references to the source's numbering or labels.
- back: the answer only, in its shortest complete form — a term, a definition, a formula, a value
  with its unit. No explanation, no restating the question.
- type: "reversed" only for a genuine term ↔ definition pair, where recalling the term from the
  definition is as useful as the reverse; then front is the term and back is the definition.
  Everything else is "basic".
- Formulas: LaTeX inside \\( … \\) (inline) or \\[ … \\] (display). Plain text otherwise — no
  Markdown, no HTML.

SUBMIT with one submit_cards call. The tool's field descriptions carry the details.`;

export interface CuratorPromptInput {
	title: string;
	kind: "chat" | "file";
	/** YYYY-MM-DD, or null when nothing can date the session. */
	day: string | null;
	budget: Pick<AnkiBudget, "remaining" | "normalRemaining">;
	candidates: readonly GraphNode[];
	context: readonly GraphNode[];
	carded: readonly AnkiCardRecord[];
	chains: readonly GraphChain[];
	/** id → name for every node the chains mention. */
	nameOf: (id: string) => string;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const section = (lines: string[]) => (lines.length ? lines.join("\n") : "  (none)");

export function curatorPrompt(input: CuratorPromptInput): string {
	const { remaining, normalRemaining } = input.budget;
	const kind = input.kind === "chat" ? "teaching session" : "notes file";
	return [
		`SESSION: "${input.title}" — ${kind}${input.day ? `, ${input.day}` : ""}`,
		`BUDGET: at most ${remaining} cards; aim for ${normalRemaining}; cards past ${normalRemaining} need a coverageReason.`,
		"",
		"CANDIDATES (propositions this session introduced; card from these only):",
		section(input.candidates.map((n) => `  ${n.id} | ${oneLine(n.name)} | ${oneLine(n.statement)}`)),
		"",
		"CONTEXT (other propositions the chains use; do not card):",
		section(input.context.map((n) => `  ${n.id} | ${oneLine(n.name)} | ${oneLine(n.statement)}`)),
		"",
		"ALREADY CARDED from this session (do not duplicate, skip what follows trivially from these):",
		section(input.carded.map((r) => `  ${r.nodeId} | ${oneLine(r.front)} → ${oneLine(r.back)}`)),
		"",
		"CHAINS (premises jointly ⇒ conclusion):",
		section(
			input.chains.map(
				(c) =>
					`  [${c.premises.join(" + ")} ⇒ ${c.conclusion}]  ${c.premises.map(input.nameOf).join(" ∧ ")} ⇒ ${input.nameOf(c.conclusion)}`,
			),
		),
	].join("\n");
}
