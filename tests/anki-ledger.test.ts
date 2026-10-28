import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ankiBudget, ankiGuid, latestCardStates, sessionCardStats } from "../src/core/anki/ledger.ts";
import type { AnkiCardRecord } from "../src/core/contracts/anki.ts";

/**
 * The card ledger fold (fork: docs/fork/anki-export-implementation.md):
 * last line per node wins, `exported` is terminal (A14), the limit counts
 * exported cards only (I5).
 */

function line(nodeId: string, state: AnkiCardRecord["state"], at: string, sessionId = "chat_a"): AnkiCardRecord {
	return {
		nodeId,
		guid: ankiGuid(nodeId),
		state,
		sessionId,
		sessionTitle: "Session",
		deck: "LearnHarness",
		type: "basic",
		context: "ctx",
		front: "Q",
		back: "A",
		at,
	};
}

describe("anki ledger", () => {
	it("GUIDs are deterministic from the node id", () => {
		assert.equal(ankiGuid("n_3fa2c1d9e0b4"), "lh_n_3fa2c1d9e0b4");
	});

	it("the last line per node wins: declined → exported", () => {
		const states = latestCardStates([line("n_1", "declined", "2026-10-01T00:00:00Z"), line("n_1", "exported", "2026-10-02T00:00:00Z")]);
		assert.equal(states.get("n_1")?.state, "exported");
	});

	it("exported is terminal: a later declined line is ignored", () => {
		const states = latestCardStates([line("n_1", "exported", "2026-10-01T00:00:00Z"), line("n_1", "declined", "2026-10-02T00:00:00Z")]);
		assert.equal(states.get("n_1")?.state, "exported");
		assert.equal(states.get("n_1")?.at, "2026-10-01T00:00:00Z");
	});

	it("per-session counts and the last export date", () => {
		const states = latestCardStates([
			line("n_1", "exported", "2026-10-01T00:00:00Z"),
			line("n_2", "exported", "2026-10-03T00:00:00Z"),
			line("n_3", "declined", "2026-10-04T00:00:00Z"),
			line("n_4", "exported", "2026-10-05T00:00:00Z", "chat_b"),
		]);
		assert.deepEqual(sessionCardStats(states, "chat_a"), { exported: 2, declined: 1, lastExportAt: "2026-10-03T00:00:00Z" });
		assert.deepEqual(sessionCardStats(states, "chat_none"), { exported: 0, declined: 0, lastExportAt: null });
	});

	it("the budget counts exported cards only and never goes negative", () => {
		const settings = { normalCardsPerSession: 8, maxCardsPerSession: 15 };
		assert.deepEqual(ankiBudget(settings, 0), { normal: 8, max: 15, exportedBefore: 0, remaining: 15, normalRemaining: 8 });
		assert.deepEqual(ankiBudget(settings, 10), { normal: 8, max: 15, exportedBefore: 10, remaining: 5, normalRemaining: 0 });
		assert.deepEqual(ankiBudget(settings, 20), { normal: 8, max: 15, exportedBefore: 20, remaining: 0, normalRemaining: 0 });
	});
});
