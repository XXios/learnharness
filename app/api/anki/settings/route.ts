/**
 * /api/anki/settings — the Anki section's record (fork,
 * docs/fork/anki-export-implementation.md I10/I11): data/anki/settings.json,
 * delta semantics. GET → { settings (raw delta), effective }; PUT is
 * replace-whole and strict (400 with the reason).
 */
import { ankiSettingsView, putAnkiSettings } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(ankiSettingsView());
}

export async function PUT(request: Request) {
	const body = await request.json().catch(() => null);
	const outcome = putAnkiSettings(body);
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: 400 });
	return Response.json({ settings: outcome.settings, effective: outcome.effective });
}
