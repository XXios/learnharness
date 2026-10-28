/**
 * /api/anki/draft — the one saved draft (fork,
 * docs/fork/anki-export-implementation.md I7/I8/I16):
 *
 *   GET    [?declined=1]       → { view } (null when no draft); revalidated
 *                                 against the live graph + ledger
 *   POST   {sessionIds}        → 202 { draft }: starts the curation job.
 *                                 409 when a draft exists; 503 + the refusal
 *                                 envelope when no cardCurator model/key
 *   PATCH  {revision, edits}   → { draft }: review edits (409 stale / cap)
 *   DELETE                     → discard (aborts a running job)
 */
import { ankiDraftView, discardAnkiDraft, patchAnkiDraft, startAnkiCuration } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const declined = new URL(request.url).searchParams.get("declined") === "1";
	return Response.json({ view: ankiDraftView(declined) });
}

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { sessionIds?: unknown } | null;
	const outcome = startAnkiCuration(body?.sessionIds);
	if (outcome.ok) return Response.json({ draft: outcome.draft }, { status: 202 });
	if (outcome.status === 503) return Response.json(outcome.envelope, { status: 503 });
	return Response.json({ error: outcome.error }, { status: outcome.status });
}

export async function PATCH(request: Request) {
	const body = (await request.json().catch(() => null)) as { revision?: unknown; edits?: unknown } | null;
	const outcome = patchAnkiDraft(body?.revision, body?.edits);
	if (outcome.ok) return Response.json({ draft: outcome.draft });
	return Response.json({ error: outcome.error }, { status: outcome.status });
}

export async function DELETE() {
	return Response.json({ discarded: discardAnkiDraft() });
}
