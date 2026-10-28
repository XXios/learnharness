import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ankiExportFileName,
	ankiFieldText,
	ankiNoteFields,
	ankiTagSlug,
	buildAnkiExport,
	localDay,
	normalizeAnkiMath,
	type AnkiExportRow,
} from "../src/core/anki/export-format.ts";
import { ANKI_FACTORY_SETTINGS } from "../src/core/anki/settings.ts";

/**
 * The Anki .txt export (fork A10/A14, I11–I13, I18). The golden output is
 * the example file in docs/fork/anki-export-implementation.md.
 */

const CTX = '<div class="lh-context" style="font-size:0.8em;opacity:0.65;margin-bottom:0.6em">';
const SRC = '<div class="lh-source" style="font-size:0.7em;opacity:0.5;margin-top:1em">';

const carnot: AnkiExportRow = {
	card: {
		nodeId: "n_3fa2c1d9e0b4",
		type: "basic",
		context: "Thermodynamics › Carnot cycle — ideal reversible heat engine",
		front: "What is the efficiency of a Carnot engine between reservoirs at \\(T_h\\) and \\(T_c\\)?",
		back: "\\(\\eta = 1 - T_c/T_h\\)",
	},
	sessionTitle: "Carnot cycle and heat engines",
	sessionDay: "2026-10-21",
};

const entropy: AnkiExportRow = {
	card: {
		nodeId: "n_91be07aa5c3d",
		type: "reversed",
		context: "Thermodynamics › Entropy — state function",
		front: "Entropy",
		back: "The state function whose change in a reversible process is \\(dS = \\delta Q_{rev}/T\\)",
	},
	sessionTitle: "Carnot cycle and heat engines",
	sessionDay: "2026-10-21",
};

describe("anki export format", () => {
	it("golden file: header, column order, basic + reversed layout", () => {
		const expected = [
			"#separator:tab",
			"#html:true",
			"#guid column:1",
			"#notetype column:2",
			"#deck column:3",
			"#tags column:6",
			[
				"lh_n_3fa2c1d9e0b4",
				"Basic",
				"LearnHarness",
				`${CTX}Thermodynamics › Carnot cycle — ideal reversible heat engine</div>What is the efficiency of a Carnot engine between reservoirs at \\(T_h\\) and \\(T_c\\)?`,
				`\\(\\eta = 1 - T_c/T_h\\)${SRC}LearnHarness · Carnot cycle and heat engines · 2026-10-21</div>`,
				"learnharness learnharness::carnot_cycle_and_heat_engines",
			].join("\t"),
			[
				"lh_n_91be07aa5c3d",
				"Basic (and reversed card)",
				"LearnHarness",
				`${CTX}Thermodynamics › Entropy — state function</div>Entropy`,
				`${CTX}Thermodynamics › Entropy — state function</div>The state function whose change in a reversible process is \\(dS = \\delta Q_{rev}/T\\)${SRC}LearnHarness · Carnot cycle and heat engines · 2026-10-21</div>`,
				"learnharness learnharness::carnot_cycle_and_heat_engines",
			].join("\t"),
		].join("\n") + "\n";
		assert.equal(buildAnkiExport([carnot, entropy], ANKI_FACTORY_SETTINGS), expected);
	});

	it("is deterministic", () => {
		assert.equal(buildAnkiExport([carnot, entropy], ANKI_FACTORY_SETTINGS), buildAnkiExport([carnot, entropy], ANKI_FACTORY_SETTINGS));
	});

	it("note type names come from the settings (localized Anki)", () => {
		const text = buildAnkiExport([carnot, entropy], { basicNoteType: "Einfach", reversedNoteType: "Einfach (mit umgekehrter Karte)" });
		const rows = text.trimEnd().split("\n").slice(6).map((row) => row.split("\t"));
		assert.equal(rows[0]![1], "Einfach");
		assert.equal(rows[1]![1], "Einfach (mit umgekehrter Karte)");
		assert.ok(rows.every((cols) => cols.length === 6));
	});

	it("fields: HTML-escaped, tabs → space, line breaks → <br>", () => {
		assert.equal(ankiFieldText('a < b & "c" > d'), "a &lt; b &amp; &quot;c&quot; &gt; d");
		assert.equal(ankiFieldText("one\ttwo"), "one two");
		assert.equal(ankiFieldText("line 1\nline 2\r\nline 3"), "line 1<br>line 2<br>line 3");
		const row = { ...carnot, card: { ...carnot.card, front: "has\ttab" } };
		assert.equal(buildAnkiExport([row], ANKI_FACTORY_SETTINGS).trimEnd().split("\n")[6]!.split("\t").length, 6);
	});

	it("math: stray $…$ / $$…$$ become MathJax delimiters, prices stay text", () => {
		assert.equal(normalizeAnkiMath("energy $E = mc^2$ here"), "energy \\(E = mc^2\\) here");
		assert.equal(normalizeAnkiMath("$$\\int_0^1 x\\,dx$$"), "\\[\\int_0^1 x\\,dx\\]");
		assert.equal(normalizeAnkiMath("costs $5 and $6"), "costs $5 and $6");
		assert.equal(normalizeAnkiMath("already \\(x\\)"), "already \\(x\\)");
	});

	it("tag slug: lowercase, underscores, any script, bounded, fallback", () => {
		assert.equal(ankiTagSlug("Carnot cycle and heat engines"), "carnot_cycle_and_heat_engines");
		assert.equal(ankiTagSlug("Thermodynamik: Wärme & Arbeit!"), "thermodynamik_wärme_arbeit");
		assert.equal(ankiTagSlug("notes.md"), "notesmd");
		assert.equal(ankiTagSlug("???"), "session");
		assert.ok(ankiTagSlug("word ".repeat(40)).length <= 60);
		assert.ok(!ankiTagSlug("word ".repeat(40)).endsWith("_"));
	});

	it("a session without a date drops the date from the source line", () => {
		const { back } = ankiNoteFields({ ...carnot, sessionDay: null });
		assert.ok(back.endsWith(`${SRC}LearnHarness · Carnot cycle and heat engines</div>`));
	});

	it("file name and local day", () => {
		assert.equal(ankiExportFileName("2026-10-27"), "learnharness-anki-2026-10-27.txt");
		assert.equal(localDay(new Date(2026, 9, 7, 23, 59)), "2026-10-07");
	});
});
