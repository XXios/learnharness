/** Claude Code's supportedModels() joined with pi-ai's anthropic catalog
 * metadata (context window, thinking levels). Rows pi does not know are not offered. */
import type { Api, Model } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { CLAUDE_CODE_PROVIDER_ID, type ClaudeCodeModelInfo } from "../../core/contracts/claude-code.ts";

const ALIAS_NAMES = new Set(["default"]);
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function claudeCodeModels(rows: readonly ClaudeCodeModelInfo[]): Model<Api>[] {
	const byId = new Map<string, { row: ClaudeCodeModelInfo; model: Model<Api> }>();
	for (const row of rows) {
		const id = row.resolvedModel ?? row.value;
		const base = anthropicModel(id);
		if (!base) continue;
		const existing = byId.get(id);
		// Prefer a named alias row ("Opus 5.5") over "Default (recommended)".
		if (existing && !ALIAS_NAMES.has(existing.row.value)) continue;
		byId.set(id, { row, model: { ...base, provider: CLAUDE_CODE_PROVIDER_ID, name: ALIAS_NAMES.has(row.value) ? base.name : row.displayName, baseUrl: "", cost: { ...ZERO_COST }, headers: undefined } as Model<Api> });
	}
	return [...byId.values()].map((entry) => entry.model).sort((a, b) => a.id.localeCompare(b.id));
}

let anthropic: Model<Api>[] | undefined;
function anthropicModel(id: string): Model<Api> | undefined {
	anthropic ??= anthropicProvider().getModels() as Model<Api>[];
	return anthropic.find((m) => m.id === id);
}
