// Abort mid-stream (pi AbortSignal): how fast does iteration end, does the child exit, any extra API call?
import { baseOptions, now, run } from "./lib.mjs";
const abort = new AbortController();
let abortedAt = null;
let deltasAfterAbort = 0;
const r = await run({
	prompt: "Write a 400-word story about a lighthouse.",
	options: baseOptions({ model: "haiku", maxTurns: 1, title: "lh", thinking: { type: "disabled" }, abortController: abort }),
	onMessage: async (m, _q, t) => {
		if (m.type === "stream_event" && m.event.type === "content_block_delta") {
			if (abortedAt != null) deltasAfterAbort++;
			else if (t > (r0 ??= t) + 400) { abortedAt = t; abort.abort(); }
		}
	},
});
var r0;
console.log(JSON.stringify({ abortedAt: Math.round(abortedAt), iterationEnd: Math.round(r.marks.end), endAfterAbortMs: Math.round(r.marks.end - abortedAt), deltasAfterAbort, error: r.marks.error?.split("\n")[0], resultSeen: r.msgs.some(({ m }) => m.type === "result") }));
process.exit(0);
