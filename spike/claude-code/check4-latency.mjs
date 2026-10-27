// Check 4: latency. Usage: node check4-latency.mjs <cold|warm> <model> <n> [bundled|user]
import { startup } from "@anthropic-ai/claude-agent-sdk";
import { baseOptions, makeToolServer, now, run } from "./lib.mjs";

const [mode = "cold", model = "haiku", nStr = "5", bin = "bundled"] = process.argv.slice(2);
const n = Number(nStr);
const prompt = "Reply with exactly the word: ok";

function opts() {
	return baseOptions({
		model,
		maxTurns: 1,
		title: "lh",
		thinking: { type: "disabled" },
		mcpServers: { lh: makeToolServer() },
		...(bin === "user" ? { pathToClaudeCodeExecutable: process.env.USER_CLAUDE ?? "claude" } : {}),
	});
}

const rows = [];
for (let i = 0; i < n; i++) {
	let r;
	let warmMs = null;
	if (mode === "warm") {
		const tw = now();
		const warm = await startup({ options: opts() });
		warmMs = Math.round(now() - tw);
		await new Promise((res) => setTimeout(res, 500));
		const t0 = now();
		const q = warm.query(prompt);
		const marks = { t0 };
		const msgs = [];
		for await (const m of q) {
			const t = now() - t0;
			msgs.push({ t, m });
			if (m.type === "stream_event" && marks.firstStream == null) marks.firstStream = t;
			if (m.type === "stream_event" && m.event.type === "content_block_delta" && marks.firstDelta == null) marks.firstDelta = t;
			if (m.type === "result") marks.result = t;
		}
		r = { marks, msgs };
	} else {
		r = await run({ prompt, options: opts() });
	}
	const res = r.msgs.find(({ m }) => m.type === "result")?.m;
	rows.push({
		i,
		warmMs,
		init: r.marks.init && Math.round(r.marks.init),
		firstStream: Math.round(r.marks.firstStream),
		firstDelta: Math.round(r.marks.firstDelta),
		result: Math.round(r.marks.result),
		apiTtft: res?.ttft_ms,
		durationApi: res?.duration_api_ms,
		timeToRequest: res?.time_to_request_ms,
		overheadToFirstDelta: Math.round(r.marks.firstDelta - (res?.ttft_ms ?? 0)),
	});
	console.error(JSON.stringify(rows.at(-1)));
}
const med = (k) => {
	const v = rows.map((r) => r[k]).filter((x) => typeof x === "number").sort((a, b) => a - b);
	return v.length ? v[Math.floor(v.length / 2)] : null;
};
console.log(JSON.stringify({ mode, model, bin, n, median: Object.fromEntries(["warmMs", "init", "firstStream", "firstDelta", "result", "apiTtft", "timeToRequest", "overheadToFirstDelta"].map((k) => [k, med(k)])) }));
process.exit(0);
