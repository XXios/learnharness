import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ANKI_FACTORY_SETTINGS,
	parseAnkiSettingsBody,
	resolveAnkiSettings,
	sanitizeAnkiSettings,
} from "../src/core/anki/settings.ts";

/** Anki settings (fork I10/I11): delta record, clamp-never-throw on disk,
 *  strict PUT parser. */

describe("anki settings", () => {
	it("factory defaults: 8 / 15 and the English stock note types", () => {
		assert.deepEqual(resolveAnkiSettings(null), {
			normalCardsPerSession: 8,
			maxCardsPerSession: 15,
			basicNoteType: "Basic",
			reversedNoteType: "Basic (and reversed card)",
		});
		assert.deepEqual(resolveAnkiSettings(null), ANKI_FACTORY_SETTINGS);
	});

	it("explicit values win over the factory", () => {
		assert.deepEqual(
			resolveAnkiSettings({ version: 1, normalCardsPerSession: 5, maxCardsPerSession: 9, basicNoteType: "Einfach", reversedNoteType: "Einfach (mit umgekehrter Karte)" }),
			{ normalCardsPerSession: 5, maxCardsPerSession: 9, basicNoteType: "Einfach", reversedNoteType: "Einfach (mit umgekehrter Karte)" },
		);
	});

	it("the sanitizer clamps numbers, drops bad names, and caps normal at max", () => {
		assert.deepEqual(sanitizeAnkiSettings({ normalCardsPerSession: 0, maxCardsPerSession: 99.7, basicNoteType: "  ", reversedNoteType: "a\tb" }), {
			version: 1,
			normalCardsPerSession: 1,
			maxCardsPerSession: 50,
		});
		assert.deepEqual(sanitizeAnkiSettings({ normalCardsPerSession: 12, maxCardsPerSession: 10 }), {
			version: 1,
			normalCardsPerSession: 10,
			maxCardsPerSession: 10,
		});
		assert.deepEqual(sanitizeAnkiSettings({ normalCardsPerSession: 20 }), { version: 1, normalCardsPerSession: 15 });
		assert.equal(sanitizeAnkiSettings("nope"), null);
		assert.equal(sanitizeAnkiSettings([]), null);
	});

	it("the PUT parser accepts a valid section and trims names", () => {
		assert.deepEqual(parseAnkiSettingsBody({ normalCardsPerSession: 6, maxCardsPerSession: 12, basicNoteType: " Einfach " }), {
			ok: true,
			settings: { version: 1, normalCardsPerSession: 6, maxCardsPerSession: 12, basicNoteType: "Einfach" },
		});
		assert.deepEqual(parseAnkiSettingsBody({}), { ok: true, settings: { version: 1 } });
	});

	it("the PUT parser rejects out-of-range, non-integer, normal > max, and bad names", () => {
		for (const body of [
			{ normalCardsPerSession: 0 },
			{ maxCardsPerSession: 51 },
			{ normalCardsPerSession: 2.5 },
			{ normalCardsPerSession: "8" },
			{ normalCardsPerSession: 10, maxCardsPerSession: 9 },
			{ normalCardsPerSession: 16 }, // above the factory max
			{ basicNoteType: "" },
			{ reversedNoteType: "line\nbreak" },
			{ basicNoteType: "x".repeat(101) },
			null,
			[],
		]) {
			const result = parseAnkiSettingsBody(body);
			assert.equal(result.ok, false, JSON.stringify(body));
		}
	});
});
