/**
 * The card curator (FORK-ONLY, A15): one submit agent per session on the
 * `cardCurator` role — a single TypeBox-validated submit_cards call is the
 * whole deliverable (runSubmitAgent; schema-invalid or law-breaking calls
 * get an error result and the model retries within maxTurns).
 */
import type { Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { AnkiCuratorCard } from "../../core/contracts/anki.ts";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "../subagents/submit-agent.ts";
import { cardCuratorInstructions, curatorPrompt, type CuratorPromptInput } from "./curator-prompt.ts";

export const SUBMIT_CARDS_TOOL = "submit_cards";

export const cardsSchema = Type.Object({
	cards: Type.Array(
		Type.Object({
			nodeId: Type.String({ description: "The id of ONE candidate proposition this card anchors." }),
			type: Type.Union([Type.Literal("basic"), Type.Literal("reversed")], {
				description: "reversed only for a genuine term ↔ definition pair.",
			}),
			context: Type.String({ description: "One short concrete line placing the card: Topic › subtopic — what this is about." }),
			front: Type.String({ description: "The question/cue. Must make sense alone, months later." }),
			back: Type.String({ description: "The answer only: shortest complete form." }),
			coverageReason: Type.Optional(Type.String({ description: "Required for every card past the normal budget." })),
		}),
		{ description: "The cards, most load-bearing first. Pass [] when nothing in the session is card-worthy." },
	),
});

type CardsSubmit = Static<typeof cardsSchema>;

/** Weak-model heal: a cards array sent as one JSON string. */
function healCards(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return raw;
	const out = { ...(raw as Record<string, unknown>) };
	if (typeof out.cards === "string") {
		try {
			const parsed: unknown = JSON.parse(out.cards);
			if (Array.isArray(parsed)) out.cards = parsed;
		} catch {
			/* leave it for validation */
		}
	}
	return out;
}

/** The ??-fill at the submit seam: trimmed strings, empty reasons dropped. */
export function fillCards(raw: CardsSubmit): AnkiCuratorCard[] {
	return raw.cards.map((card) => {
		const reason = card.coverageReason?.trim();
		return {
			nodeId: card.nodeId.trim(),
			type: card.type,
			context: card.context.trim(),
			front: card.front.trim(),
			back: card.back.trim(),
			...(reason ? { coverageReason: reason } : {}),
		};
	});
}

/** The pipeline laws a schema can't express (A11/A12, I3). null = accept. */
export function validateCards(
	cards: readonly AnkiCuratorCard[],
	candidateIds: ReadonlySet<string>,
	budget: { remaining: number; normalRemaining: number },
): string | null {
	const seen = new Set<string>();
	for (const card of cards) {
		if (!candidateIds.has(card.nodeId)) return `${card.nodeId} is not a CANDIDATE id — card candidates only`;
		if (seen.has(card.nodeId)) return `${card.nodeId} appears twice — one card per proposition`;
		seen.add(card.nodeId);
		if (!card.context || !card.front || !card.back) return `${card.nodeId}: context, front and back must not be empty`;
	}
	if (cards.length > budget.remaining) return `${cards.length} cards exceed the budget of ${budget.remaining}`;
	for (let i = budget.normalRemaining; i < cards.length; i++) {
		if (!cards[i]!.coverageReason) {
			return `card ${i + 1} (${cards[i]!.nodeId}) is past the normal budget of ${budget.normalRemaining} and needs a coverageReason`;
		}
	}
	return null;
}

export interface RunCardCuratorOptions {
	input: CuratorPromptInput;
	engine: PiEngine | undefined;
	signal: AbortSignal | undefined;
	onStep: (usage: Usage, model: string) => void;
	/** Debug recorder key (LH_PROVIDER_EVENTS=1). */
	sessionId?: string;
}

export function runCardCurator(opts: RunCardCuratorOptions): Promise<AnkiCuratorCard[]> {
	const candidateIds = new Set(opts.input.candidates.map((n) => n.id));
	return runSubmitAgent<AnkiCuratorCard[]>({
		role: "cardCurator",
		chatId: opts.sessionId,
		toolName: SUBMIT_CARDS_TOOL,
		toolDescription: "Submit the session's Anki cards — candidates only, most load-bearing first.",
		parameters: cardsSchema,
		fill: fillCards,
		validate: (cards) => validateCards(cards, candidateIds, opts.input.budget),
		systemPrompt: cardCuratorInstructions(opts.input.budget),
		prompt: curatorPrompt(opts.input),
		engine: opts.engine,
		signal: opts.signal,
		onStep: (usage, model) => opts.onStep(usage, model),
		neverSubmitted: "the card curator never submitted its cards",
		prepareArguments: healCards,
	});
}
