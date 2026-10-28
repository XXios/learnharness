/**
 * GET /api/anki/sessions — the Anki picker's rows (fork,
 * docs/fork/anki-export-implementation.md I4/I17): every teaching chat and
 * imported notes file with its card counts, extraction state and remaining
 * budget, plus the effective Anki settings.
 */
import { ankiPickerRows, ankiSettingsView } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ rows: ankiPickerRows(), settings: ankiSettingsView().effective });
}
