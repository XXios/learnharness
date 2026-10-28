import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getGraph, mergeFindings } from "../src/core/graph.ts";
import { revalidateGroup, sessionCurationInput } from "../src/core/anki/candidates.ts";
import { ankiGuid, latestCardStates } from "../src/core/anki/ledger.ts";
import type { AnkiCardRecord } from "../src/core/contracts/anki.ts";
import type { ChatStore } from "../src/core/ports.ts";
import { chain, memoryGraphStore, node } from "./fixtures/anki.ts";

/**
 * What the curator sees for one session (fork I3) + stale-draft
 * revalidation (I16) + the A22 pin (I2): a carded node re-encountered by a
 * later extraction keeps its id and is never suggested again.
 */

function record(nodeId: string, state: AnkiCardRecord["state"], sessionId = "chat_a"): AnkiCardRecord {
	return {
		nodeId,
		guid: ankiGuid(nodeId),
		state,
		sessionId,
		sessionTitle: "A",
		deck: "LearnHarness",
		type: "basic",
		context: "c",
		front: `${nodeId} front`,
		back: `${nodeId} back`,
		at: "2026-10-02T00:00:00Z",
	};
}

describe("anki candidates", () => {
	const graph = {
		nodes: [node("n_a1", "chat_a"), node("n_a2", "chat_a"), node("n_a3", "chat_a"), node("n_b1", "chat_b"), node("n_b2", "chat_b")],
		chains: [
			chain("arg_1", ["n_a1", "n_b1"], "n_a2", "chat_a"), // born-elsewhere premise → context
			chain("arg_2", ["n_b1"], "n_b2", "chat_b"), // unrelated to chat_a
		],
	};

	it("candidates are the session's birth propositions without a ledger line", () => {
		const input = sessionCurationInput(graph, latestCardStates([record("n_a3", "declined")]), "chat_a");
		assert.deepEqual(input.candidates.map((n) => n.id), ["n_a1", "n_a2"]);
	});

	it("chains touching a born proposition are included; their foreign members are context", () => {
		const input = sessionCurationInput(graph, new Map(), "chat_a");
		assert.deepEqual(input.chains.map((c) => c.id), ["arg_1"]);
		assert.deepEqual(input.context.map((n) => n.id), ["n_b1"]);
	});

	it("carded/declined born propositions used by chains become context; exported ones are listed as carded", () => {
		const states = latestCardStates([record("n_a1", "exported"), record("n_a2", "declined")]);
		const input = sessionCurationInput(graph, states, "chat_a");
		assert.deepEqual(input.candidates.map((n) => n.id), ["n_a3"]);
		assert.deepEqual(input.context.map((n) => n.id), ["n_a1", "n_a2", "n_b1"]);
		assert.deepEqual(input.carded.map((r) => r.nodeId), ["n_a1"]);
	});

	it("A22: a carded node re-encountered by a later extraction keeps its id and is not suggested again", () => {
		const graphStore = memoryGraphStore();
		const deps = { graphStore, chatStore: {} as ChatStore };
		mergeFindings("chat_a", { propositions: [{ id: "p1", name: "Carnot", statement: "Carnot efficiency is 1 − Tc/Th.", aliases: [] }], chains: [] }, { links: [] }, deps, { foldedAt: "t1" });
		const carnotId = getGraph(graphStore).nodes[0]!.id;
		const states = latestCardStates([record(carnotId, "exported")]);

		// A later session re-teaches the same idea; the auditor links it to the existing node.
		mergeFindings(
			"chat_b",
			{ propositions: [{ id: "p1", name: "Carnot limit", statement: "The Carnot engine's efficiency equals 1 − Tc/Th.", aliases: [] }], chains: [] },
			{ links: [{ id: "p1", linkTo: carnotId }] },
			deps,
			{ foldedAt: "t2" },
		);
		const after = getGraph(graphStore);
		assert.equal(after.nodes.length, 1, "the link created no new node");
		assert.equal(after.nodes[0]!.id, carnotId, "the carded node id survives");
		for (const session of ["chat_a", "chat_b"]) {
			assert.equal(sessionCurationInput(after, states, session).candidates.length, 0, session);
		}
	});

	it("revalidation: deleted and since-exported cards are stale; new candidates are only counted", () => {
		const group = {
			sessionId: "chat_a",
			candidateIds: ["n_a1", "n_a2", "n_gone"],
			cards: [
				{ nodeId: "n_a1", type: "basic" as const, context: "c", front: "f", back: "b", origin: "curator" as const, ticked: true, edited: false },
				{ nodeId: "n_a2", type: "basic" as const, context: "c", front: "f", back: "b", origin: "curator" as const, ticked: true, edited: false },
				{ nodeId: "n_gone", type: "basic" as const, context: "c", front: "f", back: "b", origin: "curator" as const, ticked: true, edited: false },
			],
		};
		const live = new Set(["n_a1", "n_a2", "n_a9"]);
		const result = revalidateGroup(group, live, latestCardStates([record("n_a2", "exported")]), ["n_a1", "n_a9"]);
		assert.deepEqual([...result.stale], [["n_a2", "exported"], ["n_gone", "deleted"]]);
		assert.equal(result.newSinceDraft, 1);
	});
});
