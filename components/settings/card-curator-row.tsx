"use client";

/**
 * Agent › Models › "Card curator" (fork, docs/fork/anki-export.md A15, I14):
 * the Anki card curator's own model + thinking. Unset = "Same as Cheap"
 * (ROLE_SLOT.cardCurator is the extractor's slot). Stored as the existing
 * per-role override `agent.models.cardCurator` — written through the agent
 * section's replace-whole PUT. The trigger component is the section's own
 * (passed in — no import cycle); the menus are the shared ones.
 */
import { useEffect, useRef, useState, type ComponentType } from "react";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { MenuShell } from "@/components/menu-shell";
import { defaultOrderLevel, populateLevel } from "@/components/thinking-default";
import { prettyModel } from "@/components/usage-format";
import type { AgentSettings, ModelCatalogEntry, ModelSlot } from "@/src/core";
import { SettingsRow } from "./controls.tsx";
import { ModelMenuList, ThinkingMenuList } from "./model-menu";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const CARD_CURATOR_UNSET = "Same as Cheap";

/** The agent section with the curator override set (or cleared with null). */
export function composeCuratorOverride(
	agent: AgentSettings | undefined,
	override: { provider: string; id: string; thinkingLevel?: ThinkingLevel } | null,
): AgentSettings {
	const models = { ...(agent?.models ?? {}) };
	if (override === null) delete models.cardCurator;
	else
		models.cardCurator = {
			model: { provider: override.provider, id: override.id },
			...(override.thinkingLevel ? { thinkingLevel: override.thinkingLevel } : {}),
		};
	const next: AgentSettings = { ...(agent ?? {}), models };
	if (Object.keys(models).length === 0) delete next.models;
	return next;
}

export interface MenuTriggerProps {
	value: string;
	emptyLabel: string;
	ariaLabel: string;
	testid: string;
	open: boolean;
	onClick: () => void;
	widthClass: string;
}

export function CardCuratorRow({
	agent,
	cheap,
	catalog,
	Trigger,
	onSectionChange,
}: {
	agent: AgentSettings | undefined;
	/** The cheap slot as stored — its model governs the levels when unset. */
	cheap: ModelSlot | undefined;
	catalog: ModelCatalogEntry[] | null;
	Trigger: ComponentType<MenuTriggerProps>;
	onSectionChange: (next: AgentSettings) => void;
}) {
	const [openMenu, setOpenMenu] = useState<"model" | "thinking" | null>(null);
	const anchorRef = useRef<HTMLSpanElement>(null);
	const override = agent?.models?.cardCurator;
	const modelId = override?.model?.id ?? "";
	const provider = override?.model?.provider ?? "";
	const coord = override?.model ?? cheap?.model;
	const chosen = coord ? catalog?.find((m) => m.id === coord.id && m.provider === coord.provider) : undefined;
	const levels = chosen ? chosen.supportedLevels : THINKING_LEVELS;
	const thinking = override?.thinkingLevel ?? "";

	// The section's dropdown contract: outside click inside the dialog or
	// Esc (claimed) closes the menu.
	useEffect(() => {
		if (openMenu === null) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (anchorRef.current?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (target instanceof Element && target.closest('[role="dialog"]')) setOpenMenu(null);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpenMenu(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [openMenu]);

	return (
		<SettingsRow
			label="Card curator"
			hint={
				<>
					Writes Anki cards
					{override && (
						<>
							{" · "}
							<button
								type="button"
								data-testid="card-curator-reset"
								onClick={() => onSectionChange(composeCuratorOverride(agent, null))}
								className="underline-offset-2 hover:text-foreground hover:underline"
							>
								Reset
							</button>
						</>
					)}
				</>
			}
			testid="role-row-cardCurator"
		>
			<span ref={openMenu ? anchorRef : undefined} className="relative flex items-center gap-2">
				<Trigger
					value={modelId ? prettyModel(modelId) : ""}
					emptyLabel={CARD_CURATOR_UNSET}
					ariaLabel="Card curator model"
					testid="role-model-cardCurator"
					open={openMenu === "model"}
					onClick={() => setOpenMenu(openMenu === "model" ? null : "model")}
					widthClass="min-w-20"
				/>
				<Trigger
					value={thinking || (override && chosen ? defaultOrderLevel(levels) : "")}
					emptyLabel={override ? "—" : CARD_CURATOR_UNSET}
					ariaLabel="Card curator thinking"
					testid="role-thinking-cardCurator"
					open={openMenu === "thinking"}
					onClick={() => setOpenMenu(openMenu === "thinking" ? null : "thinking")}
					widthClass="w-20"
				/>
				{openMenu === "model" && (
					<MenuShell
						preferredSide="down"
						anchorTestid="role-model-cardCurator"
						testid="role-model-menu-cardCurator"
						menuClass="flex w-[22rem] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
					>
						<ModelMenuList
							models={catalog ?? undefined}
							effectiveId={modelId}
							effectiveProvider={provider}
							onPick={(entry) => {
								const level = populateLevel(thinking || undefined, entry.supportedLevels);
								onSectionChange(composeCuratorOverride(agent, { provider: entry.provider, id: entry.id, thinkingLevel: level as ThinkingLevel | undefined }));
								setOpenMenu(null);
							}}
							footer={catalog && catalog.length === 0 ? "No models — add a provider key in Keys" : "Runs the Anki card curator"}
						/>
					</MenuShell>
				)}
				{openMenu === "thinking" && (
					<MenuShell
						preferredSide="down"
						anchorTestid="role-thinking-cardCurator"
						testid="role-thinking-menu-cardCurator"
						menuClass="flex w-44 flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
					>
						<ThinkingMenuList
							levels={levels.map(String)}
							effectiveLevel={thinking || (chosen ? defaultOrderLevel(levels) : undefined)}
							onPick={(level) => {
								// A level needs a model to ride: without an override,
								// pin the cheap slot's model alongside it.
								const model = override?.model ?? cheap?.model;
								if (model) onSectionChange(composeCuratorOverride(agent, { ...model, thinkingLevel: level as ThinkingLevel }));
								setOpenMenu(null);
							}}
						/>
					</MenuShell>
				)}
			</span>
		</SettingsRow>
	);
}
