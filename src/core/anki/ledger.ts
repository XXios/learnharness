/**
 * The card ledger fold (FORK-ONLY, A6/A7/A12–A14, I5): pure reads over
 * data/anki/cards.jsonl lines. The ledger is append-only; the LAST line
 * per node is its state — except that `exported` is TERMINAL (A14: once a
 * GUID has gone into a file it must never go into another one), so a
 * later line can never pull an exported card back.
 */
import type { AnkiCardRecord, EffectiveAnkiSettings } from "../contracts/anki.ts";

/** The card's Anki GUID — deterministic from the node id, so rebuilding a
 *  file always yields the same GUIDs. */
export function ankiGuid(nodeId: string): string {
	return `lh_${nodeId}`;
}

/** nodeId → its current card state (the last line, exported terminal). */
export function latestCardStates(lines: readonly AnkiCardRecord[]): Map<string, AnkiCardRecord> {
	const out = new Map<string, AnkiCardRecord>();
	for (const line of lines) {
		if (out.get(line.nodeId)?.state === "exported") continue;
		out.set(line.nodeId, line);
	}
	return out;
}

export interface AnkiSessionCardStats {
	exported: number;
	declined: number;
	/** ISO of the newest exported line for the session; null before any. */
	lastExportAt: string | null;
}

/** Per-session counts over the CURRENT states (a card counts under the
 *  session it was curated under). */
export function sessionCardStats(states: ReadonlyMap<string, AnkiCardRecord>, sessionId: string): AnkiSessionCardStats {
	let exported = 0;
	let declined = 0;
	let lastExportAt: string | null = null;
	for (const record of states.values()) {
		if (record.sessionId !== sessionId) continue;
		if (record.state === "exported") {
			exported++;
			if (lastExportAt === null || record.at > lastExportAt) lastExportAt = record.at;
		} else declined++;
	}
	return { exported, declined, lastExportAt };
}

export interface AnkiBudget {
	normal: number;
	max: number;
	exportedBefore: number;
	/** Cards this session may still get (max − exported, ≥ 0). */
	remaining: number;
	/** Cards that need no coverage reason (normal − exported, ≥ 0). */
	normalRemaining: number;
}

/** A12 + I5: the limit counts the session's EXPORTED total over all
 *  exports; declined cards use no budget. */
export function ankiBudget(settings: Pick<EffectiveAnkiSettings, "normalCardsPerSession" | "maxCardsPerSession">, exportedBefore: number): AnkiBudget {
	const normal = settings.normalCardsPerSession;
	const max = settings.maxCardsPerSession;
	return {
		normal,
		max,
		exportedBefore,
		remaining: Math.max(0, max - exportedBefore),
		normalRemaining: Math.max(0, Math.min(normal, max) - exportedBefore),
	};
}
