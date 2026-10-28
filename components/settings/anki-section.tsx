"use client";

/**
 * Settings › Anki (fork, docs/fork/anki-export.md A23, I10/I11): the card
 * limits and the note type names. Its own record (data/anki/settings.json,
 * GET/PUT /api/anki/settings) — the upstream settings record stays
 * untouched. The AnkiConnect switch lands here later.
 */
import { useEffect, useState } from "react";
import { ANKI_FACTORY_SETTINGS, type AnkiSettings, type EffectiveAnkiSettings } from "@/src/core";
import { CommitInput, SettingsGroup, SettingsRow } from "./controls.tsx";

type Field = "normalCardsPerSession" | "maxCardsPerSession" | "basicNoteType" | "reversedNoteType";

/** The pure body — exported for render pins. */
export function AnkiSectionBody({
	settings,
	effective,
	error,
	onCommit,
}: {
	settings: AnkiSettings;
	effective: EffectiveAnkiSettings;
	error: string | null;
	onCommit: (field: Field, raw: string) => void;
}) {
	const shown = (field: Field) => (settings[field] === undefined ? "" : String(settings[field]));
	return (
		<>
			<SettingsGroup label="Cards" testid="group-anki-cards">
				<SettingsRow label="Cards per session" hint="Normal amount; extra cards need a reason" testid="anki-normal-row">
					<CommitInput
						type="number"
						value={shown("normalCardsPerSession")}
						placeholder={String(ANKI_FACTORY_SETTINGS.normalCardsPerSession)}
						ariaLabel="Cards per session"
						testid="anki-normal"
						onCommit={(raw) => onCommit("normalCardsPerSession", raw)}
					/>
				</SettingsRow>
				<SettingsRow label="Maximum per session" hint={`Currently ${effective.maxCardsPerSession}`} testid="anki-max-row">
					<CommitInput
						type="number"
						value={shown("maxCardsPerSession")}
						placeholder={String(ANKI_FACTORY_SETTINGS.maxCardsPerSession)}
						ariaLabel="Maximum per session"
						testid="anki-max"
						onCommit={(raw) => onCommit("maxCardsPerSession", raw)}
					/>
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup label="Note types" testid="group-anki-note-types">
				<SettingsRow label="Basic note type" hint="Must match the note type's name in your Anki" testid="anki-basic-row">
					<CommitInput
						value={shown("basicNoteType")}
						placeholder={ANKI_FACTORY_SETTINGS.basicNoteType}
						ariaLabel="Basic note type"
						testid="anki-basic"
						onCommit={(raw) => onCommit("basicNoteType", raw)}
					/>
				</SettingsRow>
				<SettingsRow label="Reversed note type" hint="Must match the note type's name in your Anki" testid="anki-reversed-row">
					<CommitInput
						value={shown("reversedNoteType")}
						placeholder={ANKI_FACTORY_SETTINGS.reversedNoteType}
						ariaLabel="Reversed note type"
						testid="anki-reversed"
						onCommit={(raw) => onCommit("reversedNoteType", raw)}
					/>
				</SettingsRow>
			</SettingsGroup>
			{error && (
				<p role="alert" className="text-xs text-red-500" data-testid="anki-settings-error">
					{error}
				</p>
			)}
		</>
	);
}

/** "" clears the field (factory default); numbers parse as numbers. */
export function nextAnkiSettings(current: AnkiSettings, field: Field, raw: string): AnkiSettings {
	const next: AnkiSettings = { ...current, version: 1 };
	if (raw === "") delete next[field];
	else if (field === "normalCardsPerSession" || field === "maxCardsPerSession") next[field] = Number(raw);
	else next[field] = raw;
	return next;
}

export function AnkiSection() {
	const [settings, setSettings] = useState<AnkiSettings | null>(null);
	const [effective, setEffective] = useState<EffectiveAnkiSettings>(ANKI_FACTORY_SETTINGS);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		fetch("/api/anki/settings")
			.then((res) => res.json() as Promise<{ settings: AnkiSettings | null; effective: EffectiveAnkiSettings }>)
			.then((body) => {
				setSettings(body.settings ?? { version: 1 });
				setEffective(body.effective);
			})
			.catch(() => setError("Anki settings could not be loaded — refresh to retry."));
	}, []);

	if (!settings) return error ? <p className="text-xs text-red-500">{error}</p> : <p className="text-xs text-muted-foreground/70">Loading…</p>;

	const commit = async (field: Field, raw: string) => {
		setError(null);
		const res = await fetch("/api/anki/settings", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(nextAnkiSettings(settings, field, raw)),
		});
		const body = (await res.json().catch(() => ({}))) as { settings?: AnkiSettings; effective?: EffectiveAnkiSettings; error?: string };
		if (!res.ok || !body.settings || !body.effective) {
			setError(body.error ?? `Save failed (HTTP ${res.status})`);
			return;
		}
		setSettings(body.settings);
		setEffective(body.effective);
	};

	return <AnkiSectionBody settings={settings} effective={effective} error={error} onCommit={(field, raw) => void commit(field, raw)} />;
}
