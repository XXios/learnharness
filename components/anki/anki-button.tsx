"use client";

/**
 * The Anki entry point (fork, docs/fork/anki-export.md A16): an "Anki…"
 * pill beside "Import notes…" on both homes, and the modal it opens —
 * picker → curation job (background, A18) → review list (A19) → export
 * (A20). At most one draft exists (I8): while it does, the pill reads
 * "Anki · draft" and opens it.
 *
 * Truth moves on the events channel: the curation job, extraction runs and
 * the export all announce "activity-changed", which refetches whatever the
 * modal shows.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LayersIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { useNotifyHub } from "@/components/server-events";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import type { AnkiPickerRow } from "@/src/core";
import {
	AnkiRequestError,
	discardAnkiDraft,
	exportAnkiDraft,
	extractSession,
	fetchAnkiDraft,
	fetchAnkiSessions,
	patchAnkiDraft,
	startAnkiCuration,
	type AnkiCardEdit,
	type AnkiDraftView,
	type AnkiExportResult,
} from "./anki-client.ts";
import { AnkiPickerBody } from "./anki-picker.tsx";
import { AnkiCuratingBody, AnkiDoneBody, AnkiReviewBody } from "./anki-review.tsx";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function AnkiButton() {
	const [open, setOpen] = useState(false);
	const [view, setView] = useState<AnkiDraftView | null>(null);
	const [rows, setRows] = useState<AnkiPickerRow[] | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [showDeclined, setShowDeclined] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** The settings section a 503 refusal points at (no model → Agent,
	 *  no provider key → Providers); null when not refused. */
	const [refused, setRefused] = useState<"agent" | "keys" | null>(null);
	const [result, setResult] = useState<AnkiExportResult | null>(null);
	const settings = useSettingsDialog();

	const refresh = useCallback(async () => {
		try {
			const next = await fetchAnkiDraft(showDeclined);
			setView(next);
			if (!next && open) {
				const sessions = await fetchAnkiSessions();
				setRows(sessions.rows);
				// Drop picks that stopped being selectable (extraction ran, limit hit…).
				setSelected((prev) => new Set([...prev].filter((id) => sessions.rows.some((r) => r.id === id))));
			}
		} catch {
			// transport blip: keep what's shown; the next event refetches
		}
	}, [open, showDeclined]);

	useEffect(() => {
		void refresh();
	}, [refresh]);
	// The events hub is optional here: the home chrome also renders in
	// isolation (render pins mount it without a provider).
	const hub = useNotifyHub();
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;
	useEffect(() => {
		const off = hub?.subscribe("activity-changed", () => void refreshRef.current());
		return () => {
			off?.();
		};
	}, [hub]);

	const close = useCallback(() => {
		if (busy) return;
		setOpen(false);
		setResult(null);
		setError(null);
		setRefused(null);
	}, [busy]);
	const backdropDismiss = useBackdropDismiss(close);

	// Esc closes (the one-Esc law: claim at the document level).
	useEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			close();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open, close]);

	const run = async (work: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		setRefused(null);
		try {
			await work();
		} catch (err) {
			setError(message(err));
			if (err instanceof AnkiRequestError && err.status === 503) {
				setRefused((err.body as { code?: string } | null)?.code === "provider_key_missing" ? "keys" : "agent");
			}
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	const start = () =>
		run(async () => {
			await startAnkiCuration([...selected]);
			setSelected(new Set());
			await refresh();
		});
	const edit = (change: AnkiCardEdit) =>
		run(async () => {
			if (!view) return;
			await patchAnkiDraft(view.draft.revision, [change]);
			await refresh();
		});
	const discard = () =>
		run(async () => {
			await discardAnkiDraft();
			await refresh();
		});
	const doExport = () =>
		run(async () => {
			if (!view) return;
			const done = await exportAnkiDraft(view.draft.revision);
			if (done.cancelled) return; // nothing recorded; the draft stays
			setResult(done);
			await refresh();
		});
	const extract = (id: string) => run(() => extractSession(id));

	const title = result ? "Anki cards" : view ? "Anki cards" : "Make Anki cards";

	return (
		<>
			<div className="shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
				<Hint label="Make Anki cards from your sessions" side="bottom">
					<button
						type="button"
						onClick={() => setOpen(true)}
						data-testid="anki-open"
						className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
					>
						<LayersIcon className="size-3" />
						{view ? "Anki · draft" : "Anki…"}
					</button>
				</Hint>
			</div>
			{open &&
				createPortal(
					<div className="lh-no-drag fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
						<div
							role="dialog"
							aria-modal="true"
							aria-label={title}
							data-testid="anki-dialog"
							onClick={(e) => e.stopPropagation()}
							className="flex max-h-[80vh] w-[44rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-card shadow-xl"
						>
							<h2 className="px-5 pb-2 pt-4 text-sm font-semibold text-foreground">{title}</h2>
							{result ? (
								<AnkiDoneBody result={result} onClose={close} />
							) : view && view.draft.status === "curating" ? (
								<AnkiCuratingBody view={view} onDiscard={() => void discard()} busy={busy} />
							) : view ? (
								<AnkiReviewBody
									view={view}
									showDeclined={showDeclined}
									busy={busy}
									error={error}
									onEdit={(change) => void edit(change)}
									onToggleDeclined={() => setShowDeclined((v) => !v)}
									onDiscard={() => void discard()}
									onExport={() => void doExport()}
								/>
							) : (
								<>
									<AnkiPickerBody
										rows={rows}
										selected={selected}
										busy={busy}
										error={error}
										onToggle={(id) =>
											setSelected((prev) => {
												const next = new Set(prev);
												if (next.has(id)) next.delete(id);
												else next.add(id);
												return next;
											})
										}
										onExtract={(id) => void extract(id)}
										onStart={() => void start()}
										onClose={close}
									/>
									{refused && (
										<button
											type="button"
											onClick={() => {
												const section = refused;
												close();
												settings.open(section);
											}}
											className="mx-5 mb-3 self-start text-xs text-foreground underline-offset-2 hover:underline"
										>
											Open Settings
										</button>
									)}
								</>
							)}
						</div>
					</div>,
					document.body,
				)}
		</>
	);
}
