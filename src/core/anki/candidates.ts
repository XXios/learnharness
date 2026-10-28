/**
 * What the card curator sees for ONE session (FORK-ONLY, A2/A5/A11, I3),
 * and the stale-draft revalidation (I16). Pure over the derived graph +
 * the current card states.
 *
 * Candidates are the session's BIRTH propositions (core/session-clusters.ts
 * — the session that first created them) with no ledger line. Propositions
 * born elsewhere that the session's chains use go to the curator as
 * context only.
 *
 * A22 holds by construction: the auditor never merges two existing nodes —
 * it links a NEW proposition to an EXISTING node id, which survives
 * (core/graph.ts mergeFindings). A card keyed by node id therefore stays
 * attached to its node and is never suggested twice.
 */
import type { GraphChain, GraphNode } from "../contracts/graph.ts";
import type { AnkiCardRecord, AnkiDraftGroup } from "../contracts/anki.ts";
import { birthSessionOf } from "../session-clusters.ts";

export interface SessionCurationInput {
	/** Born in the session, no ledger line — the only cards the curator may write. */
	candidates: GraphNode[];
	/** Other propositions the relevant chains use (born elsewhere, or
	 *  already carded/declined) — structure only, never carded. */
	context: GraphNode[];
	/** Every chain with a born proposition as conclusion or premise. */
	chains: GraphChain[];
	/** The session's exported cards — so the curator skips what follows
	 *  trivially from them (A11). */
	carded: AnkiCardRecord[];
}

/** The propositions born in one session. */
export function bornIn(nodes: readonly GraphNode[], sessionId: string): GraphNode[] {
	return nodes.filter((node) => birthSessionOf(node) === sessionId);
}

export function sessionCurationInput(
	graph: { nodes: readonly GraphNode[]; chains: readonly GraphChain[] },
	states: ReadonlyMap<string, AnkiCardRecord>,
	sessionId: string,
): SessionCurationInput {
	const born = bornIn(graph.nodes, sessionId);
	const bornIds = new Set(born.map((node) => node.id));
	const candidates = born.filter((node) => !states.has(node.id));
	const candidateIds = new Set(candidates.map((node) => node.id));
	const chains = graph.chains.filter(
		(chain) => bornIds.has(chain.conclusion) || chain.premises.some((premise) => bornIds.has(premise)),
	);
	const used = new Set<string>();
	for (const chain of chains) {
		used.add(chain.conclusion);
		for (const premise of chain.premises) used.add(premise);
	}
	const byId = new Map(graph.nodes.map((node) => [node.id, node]));
	const context: GraphNode[] = [];
	for (const id of used) {
		if (candidateIds.has(id)) continue;
		const node = byId.get(id);
		if (node) context.push(node);
	}
	context.sort((a, b) => (a.id < b.id ? -1 : 1));
	const carded = [...states.values()]
		.filter((record) => record.state === "exported" && record.sessionId === sessionId)
		.sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
	return { candidates, context, chains, carded };
}

/** Why a draft card can no longer be exported (I16). */
export type AnkiStaleReason = "deleted" | "exported";

export interface AnkiGroupRevalidation {
	/** nodeId → why the card is not exportable. */
	stale: Map<string, AnkiStaleReason>;
	/** Candidates of the session that did not exist when the draft was curated. */
	newSinceDraft: number;
}

/** Revalidate one draft group against the live graph + ledger: a card whose
 *  proposition is gone, or that has been exported since, is stale. New
 *  candidates are only counted — the draft is never re-curated (I16). */
export function revalidateGroup(
	group: Pick<AnkiDraftGroup, "sessionId" | "candidateIds" | "cards">,
	liveNodeIds: ReadonlySet<string>,
	states: ReadonlyMap<string, AnkiCardRecord>,
	currentCandidateIds: readonly string[],
): AnkiGroupRevalidation {
	const stale = new Map<string, AnkiStaleReason>();
	for (const card of group.cards) {
		if (!liveNodeIds.has(card.nodeId)) stale.set(card.nodeId, "deleted");
		else if (states.get(card.nodeId)?.state === "exported") stale.set(card.nodeId, "exported");
	}
	const known = new Set(group.candidateIds);
	const newSinceDraft = currentCandidateIds.filter((id) => !known.has(id)).length;
	return { stale, newSinceDraft };
}
