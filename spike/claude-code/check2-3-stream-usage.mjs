// Checks 2+3: thinking/text deltas, effort/thinking mapping, per-call usage.
// Usage: node check2-3-stream-usage.mjs <model> <configName>
import { baseOptions, run } from "./lib.mjs";

const model = process.argv[2] ?? "sonnet";
const configs = {
	"adaptive-summarized-low": { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
	"adaptive-summarized-high": { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
	"adaptive-summarized-max": { thinking: { type: "adaptive", display: "summarized" }, effort: "max" },
	"adaptive-default-display-high": { thinking: { type: "adaptive" }, effort: "high" },
	"adaptive-omitted-high": { thinking: { type: "adaptive", display: "omitted" }, effort: "high" },
	"disabled": { thinking: { type: "disabled" } },
	"enabled-budget": { thinking: { type: "enabled", budgetTokens: 4000, display: "summarized" } },
	"none": {},
	"adaptive-default-display-max": { thinking: { type: "adaptive" }, effort: "max" },
	"effort-max-only": { effort: "max" },
};
const name = process.argv[3] ?? "adaptive-summarized-high";
const prompt =
	"A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. A second bat costs twice the first. What do a second bat and three balls cost together? Reason carefully, then answer in one sentence.";

const r = await run({ prompt, options: baseOptions({ model, maxTurns: 1, ...configs[name], ...(process.env.SPIKE_TITLE ? { title: process.env.SPIKE_TITLE } : {}) }) });
const counts = {};
let thinkingChars = 0;
let textChars = 0;
let streamUsage = {};
let signature = false;
let redacted = 0;
for (const { m } of r.msgs) {
	if (m.type === "stream_event") {
		const e = m.event;
		const k = e.type + (e.delta?.type ? ":" + e.delta.type : "") + (e.content_block?.type ? ":" + e.content_block.type : "");
		counts[k] = (counts[k] ?? 0) + 1;
		if (e.delta?.type === "thinking_delta") thinkingChars += e.delta.thinking.length;
		if (e.delta?.type === "text_delta") textChars += e.delta.text.length;
		if (e.delta?.type === "signature_delta") signature = true;
		if (e.content_block?.type === "redacted_thinking") redacted++;
		if (e.type === "message_start") streamUsage.start = e.message.usage;
		if (e.type === "message_delta") streamUsage.delta = e.usage;
	}
	if (m.type === "system" && m.subtype === "thinking_tokens") counts["system/thinking_tokens"] = (counts["system/thinking_tokens"] ?? 0) + 1;
}
const result = r.msgs.find(({ m }) => m.type === "result")?.m;
const init = r.msgs.find(({ m }) => m.type === "system" && m.subtype === "init")?.m;
const finalText = r.msgs.filter(({ m }) => m.type === "assistant").flatMap(({ m }) => m.message.content).filter((b) => b.type === "text").map((b) => b.text).join("");
console.log(JSON.stringify({
	model,
	name,
	initModel: init?.model,
	initEffort: init?.effort,
	marks: Object.fromEntries(Object.entries(r.marks).map(([k, v]) => [k, typeof v === "number" ? Math.round(v) : v])),
	counts,
	thinkingChars,
	textChars,
	signature,
	redacted,
	streamUsage,
	result: result && { subtype: result.subtype, usage: result.usage, modelUsage: result.modelUsage, total_cost_usd: result.total_cost_usd, duration_ms: result.duration_ms, duration_api_ms: result.duration_api_ms, ttft_ms: result.ttft_ms, time_to_request_ms: result.time_to_request_ms },
	finalText: finalText.slice(0, 200),
}, null, 2));
process.exit(0);
