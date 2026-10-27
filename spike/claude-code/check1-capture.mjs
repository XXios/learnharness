// Check 1: capture-and-stop. Usage: node check1-capture.mjs <mechanism> [model]
// mechanisms: deny-interrupt | deny-only | maxturns1 | abort-on-stop | interrupt-on-stop
import { baseOptions, handlerCalls, makeToolServer, run, summarize } from "./lib.mjs";

const mech = process.argv[2] ?? "deny-interrupt";
const model = process.argv[3] ?? "haiku";
const prompt = process.env.SPIKE_PROMPT ??
	"Call get_weather for Paris, get_weather for Tokyo and get_time for Paris, all three in parallel in a single response. Do not write any text before the tool calls.";

const permissionCalls = [];
const abort = new AbortController();
const extra = { model, abortController: abort, mcpServers: { lh: makeToolServer() } };

if (mech === "deny-interrupt" || mech === "deny-only") {
	extra.canUseTool = async (name, input, opts) => {
		permissionCalls.push({ name, input, toolUseID: opts.toolUseID, at: performance.now() });
		return { behavior: "deny", message: "captured by host", interrupt: mech === "deny-interrupt" };
	};
}
if (mech === "maxturns1" || mech === "maxturns1-deny") extra.maxTurns = 1;
if (mech === "maxturns1-deny") {
	extra.canUseTool = async (name, input, opts) => {
		permissionCalls.push({ name, input, toolUseID: opts.toolUseID, at: performance.now() });
		return { behavior: "deny", message: "captured by host" };
	};
}
if (process.env.SPIKE_EFFORT) extra.effort = process.env.SPIKE_EFFORT;
if (process.env.SPIKE_THINKING) extra.thinking = JSON.parse(process.env.SPIKE_THINKING);

// hold-*: canUseTool never answers; we stop the run once the first message_stop arrives.
let messageStopped = false;
if (mech.startsWith("hold-")) {
	extra.canUseTool = (name, input, opts) => {
		permissionCalls.push({ name, input, toolUseID: opts.toolUseID, at: performance.now() });
		return new Promise((resolve) => {
			opts.signal.addEventListener("abort", () => resolve({ behavior: "deny", message: "aborted" }), { once: true });
			holds.push(resolve);
		});
	};
}
const holds = [];

let stopSent = false;
const r = await run({
	prompt,
	options: baseOptions(extra),
	onMessage: async (m, q) => {
		if (stopSent) return;
		const isToolStop = m.type === "stream_event" && m.event.type === "message_delta" && m.event.delta.stop_reason === "tool_use";
		if (isToolStop && mech === "abort-on-stop") {
			stopSent = true;
			abort.abort();
		}
		if (isToolStop && mech === "interrupt-on-stop") {
			stopSent = true;
			await q.interrupt();
		}
		const isMsgStop = m.type === "stream_event" && m.event.type === "message_stop";
		if (isMsgStop && mech.startsWith("hold-")) {
			messageStopped = true;
			stopSent = true;
			if (mech === "hold-abort") abort.abort();
			if (mech === "hold-interrupt") await q.interrupt();
			if (mech === "hold-deny-interrupt") for (const h of holds) h({ behavior: "deny", message: "captured by host", interrupt: true });
		}
	},
});

// Reassemble the assistant message from SDKAssistantMessage frames (grouped by message.id).
const byId = new Map();
for (const { m } of r.msgs) {
	if (m.type !== "assistant") continue;
	const cur = byId.get(m.message.id) ?? { blocks: [], usage: m.message.usage, stop: null };
	cur.blocks.push(...m.message.content);
	cur.stop = m.message.stop_reason ?? cur.stop;
	byId.set(m.message.id, cur);
}

console.log(summarize(r.msgs).join("\n"));
console.log(JSON.stringify({
	mech,
	model,
	marks: Object.fromEntries(Object.entries(r.marks).map(([k, v]) => [k, typeof v === "number" ? Math.round(v) : v])),
	permissionCalls: permissionCalls.map((p) => ({ name: p.name, input: p.input, toolUseID: p.toolUseID })),
	handlerCalls,
	assistantMessages: [...byId.entries()].map(([id, v]) => ({ id, stop: v.stop, blocks: v.blocks.map((b) => (b.type === "tool_use" ? { tool_use: b.name, id: b.id, input: b.input } : { [b.type]: (b.text ?? b.thinking ?? "").slice(0, 80) })) })),
}, null, 2));
process.exit(0);
