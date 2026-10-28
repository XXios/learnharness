// Check 6: auth probe without sending a model request and without a TTY.
// Usage: node check6-auth.mjs [label] (env overrides decide the scenario)
import { query } from "@anthropic-ai/claude-agent-sdk";
import { baseOptions, now } from "./lib.mjs";

const label = process.argv[2] ?? "default";
const abort = new AbortController();
const t0 = now();
const q = query({
	// Never yields, so no prompt reaches the API (t3code pattern).
	prompt: (async function* () {
		await new Promise((r) => abort.signal.addEventListener("abort", r, { once: true }));
	})(),
	options: baseOptions({ abortController: abort, includePartialMessages: false }),
});
const out = { label, stdinIsTTY: Boolean(process.stdin.isTTY) };
try {
	const init = await q.initializationResult();
	out.initMs = Math.round(now() - t0);
	out.account = await q.accountInfo();
	out.accountMs = Math.round(now() - t0);
	const models = await q.supportedModels();
	out.models = models.map((m) => ({
		value: m.value,
		resolvedModel: m.resolvedModel,
		displayName: m.displayName,
		effort: m.supportedEffortLevels,
		adaptive: m.supportsAdaptiveThinking,
	}));
	out.initKeys = Object.keys(init);
} catch (err) {
	out.error = String(err?.message ?? err);
	out.errorMs = Math.round(now() - t0);
}
abort.abort();
console.log(JSON.stringify(out, null, 2));
process.exit(0);
