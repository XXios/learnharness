"use client";

/**
 * The Anki picker (fork, docs/fork/anki-export.md A16/A17, I4/I17): every
 * teaching chat and notes file, one status line each, an "Extract first"
 * action the user starts (extraction never runs automatically). Pure body
 * — the host (anki-button.tsx) owns state and transport.
 */
import { cn } from "@/lib/utils";
import type { AnkiPickerRow } from "@/src/core";

/** A row's status line + whether it can be picked (exported for pins). */
export function pickerRowStatus(row: AnkiPickerRow): { line: string; selectable: boolean; extract: boolean } {
	if (row.extraction === "running") return { line: "extracting…", selectable: false, extract: false };
	if (row.extraction === "none") return { line: "not extracted yet", selectable: false, extract: true };
	if (row.remaining === 0) return { line: "limit reached", selectable: false, extract: false };
	if (row.candidates === 0) return { line: "all carded", selectable: false, extract: false };
	if (row.extraction === "pending") {
		return {
			line: `${row.pendingTurns} ${row.pendingTurns === 1 ? "turn" : "turns"} pending — cards only from what's extracted so far`,
			selectable: true,
			extract: true,
		};
	}
	const carded = row.exported === 0 ? "never carded" : `${row.exported} ${row.exported === 1 ? "card" : "cards"} · last export ${formatDay(row.lastExportAt)}`;
	return { line: carded, selectable: true, extract: false };
}

export function formatDay(iso: string | null): string {
	if (!iso) return "—";
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function AnkiPickerBody({
	rows,
	selected,
	busy,
	error,
	onToggle,
	onExtract,
	onStart,
	onClose,
}: {
	rows: AnkiPickerRow[] | null;
	selected: ReadonlySet<string>;
	busy: boolean;
	error: string | null;
	onToggle: (id: string) => void;
	onExtract: (id: string) => void;
	onStart: () => void;
	onClose: () => void;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="anki-picker">
			<div className="min-h-0 flex-1 overflow-y-auto px-5">
				{rows === null ? (
					<p className="py-6 text-sm text-muted-foreground">Loading…</p>
				) : rows.length === 0 ? (
					<p className="py-6 text-sm text-muted-foreground">No sessions or notes yet.</p>
				) : (
					<ul className="flex flex-col divide-y divide-border/60">
						{rows.map((row) => {
							const status = pickerRowStatus(row);
							const checked = selected.has(row.id);
							return (
								<li key={row.id} data-testid={`anki-row-${row.id}`} className={cn("flex items-start gap-3 py-2.5", !status.selectable && "opacity-70")}>
									<input
										type="checkbox"
										aria-label={`Select ${row.title}`}
										checked={checked}
										disabled={!status.selectable || busy}
										onChange={() => onToggle(row.id)}
										className="mt-1 size-3.5 shrink-0 accent-foreground"
									/>
									<div className="min-w-0 flex-1">
										<div className="flex items-baseline gap-2">
											<span className="truncate text-sm text-foreground">{row.title}</span>
											<span className="shrink-0 text-[11px] text-muted-foreground">
												{row.kind === "file" ? "notes" : "session"} · {formatDay(row.date)}
											</span>
										</div>
										<p className="text-xs text-muted-foreground" data-testid={`anki-row-status-${row.id}`}>{status.line}</p>
									</div>
									{status.extract && (
										<button
											type="button"
											onClick={() => onExtract(row.id)}
											data-testid={`anki-extract-${row.id}`}
											className="shrink-0 rounded-sm border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
										>
											Extract first
										</button>
									)}
								</li>
							);
						})}
					</ul>
				)}
			</div>
			{error && (
				<p role="alert" className="whitespace-pre-wrap px-5 pt-2 text-xs text-red-400">
					{error}
				</p>
			)}
			<div className="flex justify-end gap-2 border-t border-border/60 px-5 py-3">
				<button type="button" onClick={onClose} className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
					Close
				</button>
				<button
					type="button"
					data-testid="anki-start"
					disabled={selected.size === 0 || busy}
					onClick={onStart}
					className="rounded-sm border border-border bg-accent px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent/70 disabled:opacity-40"
				>
					Make cards ({selected.size} selected)
				</button>
			</div>
		</div>
	);
}
