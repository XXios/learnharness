/**
 * POST /api/anki/export — the export (fork,
 * docs/fork/anki-export-implementation.md I9):
 *
 *   {revision, deliver: "preview"}             → { fileName, text, exported, declined }
 *                                                 no writes (the desktop Save
 *                                                 dialog writes this text)
 *   {revision, deliver: "commit", savedAs?}    → { fileName, exported, declined }
 *                                                 THE ledger write, after the
 *                                                 desktop dialog saved the file
 *   {revision, deliver: "download"}            → commit + the file as a
 *                                                 text/plain attachment (web);
 *                                                 JSON when nothing was ticked
 *
 * 404 no draft, 409 stale revision / still curating / limit reached.
 */
import { ankiExportPreview, commitAnkiExport } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { revision?: unknown; deliver?: unknown; savedAs?: unknown } | null;
	const deliver = body?.deliver;
	if (deliver !== "preview" && deliver !== "commit" && deliver !== "download") {
		return Response.json({ error: 'Body must be {revision, deliver: "preview"|"commit"|"download"}' }, { status: 400 });
	}
	if (deliver === "preview") {
		const outcome = ankiExportPreview(body?.revision);
		if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
		const { fileName, text, exported, declined } = outcome.plan;
		return Response.json({ fileName, text, exported, declined });
	}
	const savedAs = typeof body?.savedAs === "string" ? body.savedAs : undefined;
	const outcome = commitAnkiExport(body?.revision, deliver === "commit" ? savedAs : undefined);
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
	const { fileName, text, exported, declined } = outcome.plan;
	if (deliver === "download" && fileName !== null) {
		return new Response(text, {
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Content-Disposition": `attachment; filename="${fileName}"`,
				"X-Anki-Exported": String(exported),
				"X-Anki-Declined": String(declined),
			},
		});
	}
	return Response.json({ fileName, exported, declined });
}
