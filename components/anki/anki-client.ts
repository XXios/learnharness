/**
 * The Anki panel's transport (fork, docs/fork/anki-export-implementation.md):
 * fetch helpers over /api/anki/* plus the one desktop/web split — the
 * export's delivery (A20: the native Save dialog on desktop, a browser
 * download in web/dev). Client-safe mirrors of the server's view shapes
 * live here (the shell imports only @/src/core).
 */
import type {
	AnkiDraft,
	AnkiDraftCard,
	AnkiPickerRow,
	EffectiveAnkiSettings,
	ModelsNotConfigured,
	ProviderKeyMissing,
} from "@/src/core";

/** Mirror of src/server/anki.ts AnkiGroupView. */
export interface AnkiGroupView {
	sessionId: string;
	stale: Record<string, "deleted" | "exported">;
	newSinceDraft: number;
	exported: number;
	remaining: number;
	declined?: AnkiDraftCard[];
}

/** Mirror of src/server/anki.ts AnkiDraftView. */
export interface AnkiDraftView {
	draft: AnkiDraft;
	groups: AnkiGroupView[];
	effective: EffectiveAnkiSettings;
}

export interface AnkiCardEdit {
	sessionId: string;
	nodeId: string;
	ticked?: boolean;
	type?: "basic" | "reversed";
	context?: string;
	front?: string;
	back?: string;
}

async function json<T>(res: Response): Promise<T> {
	const body = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new AnkiRequestError(body.error ?? `Request failed (HTTP ${res.status})`, res.status, body);
	return body;
}

export class AnkiRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: unknown,
	) {
		super(message);
		this.name = "AnkiRequestError";
	}
}

export async function fetchAnkiSessions(): Promise<{ rows: AnkiPickerRow[]; settings: EffectiveAnkiSettings }> {
	return json(await fetch("/api/anki/sessions"));
}

export async function fetchAnkiDraft(declined: boolean): Promise<AnkiDraftView | null> {
	const body = await json<{ view: AnkiDraftView | null }>(await fetch(`/api/anki/draft${declined ? "?declined=1" : ""}`));
	return body.view;
}

/** A 503 refusal carries the models/key envelope. */
export type AnkiRefusal = ModelsNotConfigured | ProviderKeyMissing;

export async function startAnkiCuration(sessionIds: string[]): Promise<AnkiDraft> {
	const res = await fetch("/api/anki/draft", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ sessionIds }),
	});
	return (await json<{ draft: AnkiDraft }>(res)).draft;
}

export async function patchAnkiDraft(revision: number, edits: AnkiCardEdit[]): Promise<AnkiDraft> {
	const res = await fetch("/api/anki/draft", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ revision, edits }),
	});
	return (await json<{ draft: AnkiDraft }>(res)).draft;
}

export async function discardAnkiDraft(): Promise<void> {
	await json(await fetch("/api/anki/draft", { method: "DELETE" }));
}

export async function extractSession(chatId: string): Promise<void> {
	const res = await fetch("/api/graph/coverage/extract", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId }),
	});
	// 409 = already running: benign, the row shows "extracting…" anyway.
	if (!res.ok && res.status !== 409) await json(res);
}

export interface AnkiExportResult {
	/** Where the file went: a path (desktop), "download" (web), or null
	 *  when nothing was ticked (declines only, no file). */
	savedTo: string | "download" | null;
	exported: number;
	declined: number;
	/** Desktop only: the user cancelled the Save dialog — nothing recorded. */
	cancelled?: boolean;
}

const post = (body: unknown) =>
	fetch("/api/anki/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** The export (I9). Desktop: preview → native Save → commit (cancel =
 *  nothing recorded). Web: one request commits and returns the file,
 *  which the browser downloads. */
export async function exportAnkiDraft(revision: number): Promise<AnkiExportResult> {
	const bridge = typeof window !== "undefined" ? window.lh?.anki : undefined;
	if (bridge) {
		const preview = await json<{ fileName: string | null; text: string; exported: number; declined: number }>(
			await post({ revision, deliver: "preview" }),
		);
		let savedAs: string | undefined;
		if (preview.fileName !== null) {
			const saved = await bridge.saveFile(preview.fileName, preview.text);
			if (!saved.saved) return { savedTo: null, exported: 0, declined: 0, cancelled: true };
			savedAs = saved.path;
		}
		const done = await json<{ fileName: string | null; exported: number; declined: number }>(
			await post({ revision, deliver: "commit", savedAs }),
		);
		return { savedTo: savedAs ?? null, exported: done.exported, declined: done.declined };
	}
	const res = await post({ revision, deliver: "download" });
	if (!res.ok) await json(res);
	if ((res.headers.get("Content-Type") ?? "").startsWith("application/json")) {
		const done = (await res.json()) as { exported: number; declined: number };
		return { savedTo: null, exported: done.exported, declined: done.declined };
	}
	const fileName = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "learnharness-anki.txt";
	const blob = await res.blob();
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = fileName;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
	return {
		savedTo: "download",
		exported: Number(res.headers.get("X-Anki-Exported") ?? 0),
		declined: Number(res.headers.get("X-Anki-Declined") ?? 0),
	};
}
