"use client";

/**
 * The Anki draft's three faces (fork, docs/fork/anki-export.md A18/A19,
 * I6/I16): curating progress, the review list, and the done note. Pure
 * bodies — the host (anki-button.tsx) owns state and transport.
 */
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { AnkiDraftCard, AnkiDraftGroup } from "@/src/core";
import type { AnkiCardEdit, AnkiDraftView, AnkiExportResult, AnkiGroupView } from "./anki-client.ts";

export const LIMIT_REACHED_HINT = "limit reached — raise it in Settings › Anki";

/** One group's derived numbers (exported for pins). */
export function groupCounts(group: AnkiDraftGroup, view: AnkiGroupView): { ticked: number; used: number; canTickMore: boolean } {
	const ticked = group.cards.filter((card) => card.ticked && !view.stale[card.nodeId]).length;
	return { ticked, used: view.exported + ticked, canTickMore: ticked < view.remaining };
}

/** Cards the export will write (ticked, not stale), across all groups. */
export function exportCount(view: AnkiDraftView): number {
	return view.draft.groups.reduce((sum, group, i) => sum + groupCounts(group, view.groups[i]!).ticked, 0);
}

function groupStatusLine(group: AnkiDraftGroup): string {
	switch (group.status) {
		case "queued":
			return "queued";
		case "curating":
			return "curating…";
		case "done":
			return `done · ${group.cards.length} ${group.cards.length === 1 ? "card" : "cards"}`;
		case "failed":
			return `failed: ${group.error ?? "unknown error"}`;
		case "skipped":
			return `skipped: ${group.error ?? ""}`;
	}
}

export function AnkiCuratingBody({ view, onDiscard, busy }: { view: AnkiDraftView; onDiscard: () => void; busy: boolean }) {
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="anki-curating">
			<ul className="flex flex-col gap-1.5 px-5 py-3">
				{view.draft.groups.map((group) => (
					<li key={group.sessionId} className="flex items-baseline justify-between gap-3 text-sm">
						<span className="truncate text-foreground">{group.title}</span>
						<span className="shrink-0 text-xs text-muted-foreground">{groupStatusLine(group)}</span>
					</li>
				))}
			</ul>
			<p className="px-5 text-xs text-muted-foreground">Runs in the background — you can close this.</p>
			<div className="mt-auto flex justify-end gap-2 border-t border-border/60 px-5 py-3">
				<button type="button" disabled={busy} onClick={onDiscard} data-testid="anki-discard" className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">
					Discard
				</button>
			</div>
		</div>
	);
}

/** A textarea that commits on blur (settings pace — every commit is a PATCH). */
function CardField({ label, value, disabled, onCommit }: { label: string; value: string; disabled: boolean; onCommit: (next: string) => void }) {
	const [draft, setDraft] = useState<string | null>(null);
	return (
		<label className="flex flex-col gap-0.5">
			<span className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
			<textarea
				aria-label={label}
				rows={label === "Context" ? 1 : 2}
				disabled={disabled}
				value={draft ?? value}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={() => {
					if (draft === null) return;
					const next = draft.trim();
					setDraft(null);
					if (next && next !== value) onCommit(next);
				}}
				className="resize-y rounded-sm border border-border bg-background px-2 py-1 font-prose text-sm text-foreground outline-none disabled:opacity-60"
			/>
		</label>
	);
}

function CardRow({
	card,
	stale,
	canTick,
	busy,
	onEdit,
}: {
	card: AnkiDraftCard;
	stale: "deleted" | "exported" | undefined;
	canTick: boolean;
	busy: boolean;
	onEdit: (edit: Omit<AnkiCardEdit, "sessionId" | "nodeId">) => void;
}) {
	const tickDisabled = busy || !!stale || (!card.ticked && !canTick);
	return (
		<li data-testid={`anki-card-${card.nodeId}`} className={cn("flex gap-3 py-3", stale && "opacity-50")}>
			<input
				type="checkbox"
				aria-label={`Include card ${card.nodeId}`}
				checked={card.ticked && !stale}
				disabled={tickDisabled}
				title={!stale && !card.ticked && !canTick ? LIMIT_REACHED_HINT : undefined}
				onChange={() => onEdit({ ticked: !card.ticked })}
				className="mt-1 size-3.5 shrink-0 accent-foreground"
			/>
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
					{(["basic", "reversed"] as const).map((type) => (
						<button
							key={type}
							type="button"
							disabled={busy || !!stale}
							onClick={() => type !== card.type && onEdit({ type })}
							className={cn("rounded-sm px-1.5 py-0.5", card.type === type ? "bg-accent text-foreground" : "hover:text-foreground")}
						>
							{type === "basic" ? "Basic" : "Reversed"}
						</button>
					))}
					{card.origin === "declined" && <span>declined earlier</span>}
					{stale && <span data-testid={`anki-stale-${card.nodeId}`}>{stale === "deleted" ? "source deleted" : "already exported"}</span>}
					{!stale && !card.ticked && !canTick && <span>{LIMIT_REACHED_HINT}</span>}
				</div>
				<CardField label="Context" value={card.context} disabled={busy || !!stale} onCommit={(context) => onEdit({ context })} />
				<CardField label="Front" value={card.front} disabled={busy || !!stale} onCommit={(front) => onEdit({ front })} />
				<CardField label="Back" value={card.back} disabled={busy || !!stale} onCommit={(back) => onEdit({ back })} />
				{card.coverageReason && (
					<p className="text-xs text-muted-foreground" data-testid={`anki-extra-${card.nodeId}`}>
						Extra: {card.coverageReason}
					</p>
				)}
			</div>
		</li>
	);
}

export function AnkiReviewBody({
	view,
	showDeclined,
	busy,
	error,
	onEdit,
	onToggleDeclined,
	onDiscard,
	onExport,
}: {
	view: AnkiDraftView;
	showDeclined: boolean;
	busy: boolean;
	error: string | null;
	onEdit: (edit: AnkiCardEdit) => void;
	onToggleDeclined: () => void;
	onDiscard: () => void;
	onExport: () => void;
}) {
	const count = exportCount(view);
	const max = view.effective.maxCardsPerSession;
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="anki-review">
			<div className="min-h-0 flex-1 overflow-y-auto px-5">
				{view.draft.groups.map((group, i) => {
					const groupView = view.groups[i]!;
					const counts = groupCounts(group, groupView);
					const declined = showDeclined ? (groupView.declined ?? []) : [];
					return (
						<section key={group.sessionId} className="border-b border-border/60 py-3 last:border-b-0" data-testid={`anki-group-${group.sessionId}`}>
							<h3 className="flex items-baseline justify-between gap-3 text-sm">
								<span className="truncate text-foreground">{group.title}</span>
								<span className="shrink-0 text-xs text-muted-foreground" data-testid={`anki-used-${group.sessionId}`}>
									{counts.used} of {max} used
								</span>
							</h3>
							{group.status !== "done" && <p className="text-xs text-muted-foreground">{groupStatusLine(group)}</p>}
							{group.status === "done" && group.cards.length === 0 && declined.length === 0 && (
								<p className="text-xs text-muted-foreground">No card-worthy propositions.</p>
							)}
							{groupView.newSinceDraft > 0 && (
								<p className="text-xs text-muted-foreground">
									{groupView.newSinceDraft} new {groupView.newSinceDraft === 1 ? "proposition" : "propositions"} since this draft
								</p>
							)}
							<ul className="flex flex-col divide-y divide-border/40">
								{[...group.cards, ...declined].map((card) => (
									<CardRow
										key={card.nodeId}
										card={card}
										stale={groupView.stale[card.nodeId]}
										canTick={counts.canTickMore}
										busy={busy}
										onEdit={(edit) => onEdit({ sessionId: group.sessionId, nodeId: card.nodeId, ...edit })}
									/>
								))}
							</ul>
						</section>
					);
				})}
			</div>
			{error && (
				<p role="alert" className="whitespace-pre-wrap px-5 pt-2 text-xs text-red-400">
					{error}
				</p>
			)}
			<div className="flex items-center justify-between gap-2 border-t border-border/60 px-5 py-3">
				<label className="flex items-center gap-2 text-xs text-muted-foreground">
					<input type="checkbox" checked={showDeclined} onChange={onToggleDeclined} className="size-3.5 accent-foreground" data-testid="anki-show-declined" />
					Show declined
				</label>
				<div className="flex gap-2">
					<button type="button" disabled={busy} onClick={onDiscard} data-testid="anki-discard" className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">
						Discard draft
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={onExport}
						data-testid="anki-export"
						className="rounded-sm border border-border bg-accent px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent/70 disabled:opacity-40"
					>
						{count === 0 ? "Decline all and close" : `Export ${count} ${count === 1 ? "card" : "cards"}…`}
					</button>
				</div>
			</div>
		</div>
	);
}

export function AnkiDoneBody({ result, onClose }: { result: AnkiExportResult; onClose: () => void }) {
	const where = result.savedTo === "download" ? "your downloads" : result.savedTo;
	return (
		<div className="flex flex-col gap-2 px-5 py-4" data-testid="anki-done">
			{result.exported > 0 ? (
				<>
					<p className="text-sm text-foreground">
						Exported {result.exported} {result.exported === 1 ? "card" : "cards"} to {where}.
					</p>
					<p className="text-xs text-muted-foreground">
						In Anki: File › Import…, choose the file. Cards go to the &ldquo;LearnHarness&rdquo; deck.
					</p>
				</>
			) : (
				<p className="text-sm text-foreground">
					Declined {result.declined} {result.declined === 1 ? "card" : "cards"}. No file was written.
				</p>
			)}
			<div className="flex justify-end">
				<button type="button" onClick={onClose} className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
					Close
				</button>
			</div>
		</div>
	);
}
