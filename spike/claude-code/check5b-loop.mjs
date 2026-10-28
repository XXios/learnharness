// Check 5b: a real mini pi-style loop over 3 calls, for both history formats.
// call1: user question -> captured tool_use(s); host "executes" them (long results)
// call2: history + tool results -> assistant answer
// call3: history + answer + follow-up question -> answer
// Usage: node check5b-loop.mjs <text|resume> [model]
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { baseOptions, handlerCalls, makeToolServer, run, userMessages } from "./lib.mjs";

const [format = "text", model = "sonnet"] = process.argv.slice(2);
const cwd = "/tmp/lh-cc-loop";
mkdirSync(cwd, { recursive: true });
const longNotes = Array.from({ length: 600 }, (_, i) => `obs${i}=calm`).join(", ");

const transcript = []; // pi-like: {role:user|assistant|tool, content:[...]}

function serializeText(turns) {
	// One text block per turn (stable prefix), images would be separate blocks.
	const blocks = [{ type: "text", text: "<conversation_history>" }];
	const last = turns.at(-1);
	const prior = last.role === "user" ? turns.slice(0, -1) : turns;
	for (const t of prior) {
		const parts = t.content.map((b) =>
			b.type === "text" ? b.text : b.type === "tool_use" ? `<tool_call id="${b.id}" name="${b.name}">${JSON.stringify(b.input)}</tool_call>` : `<tool_result id="${b.tool_use_id}">${b.content}</tool_result>`,
		);
		blocks.push({ type: "text", text: `<${t.role}>\n${parts.join("\n")}\n</${t.role}>` });
	}
	blocks.push({ type: "text", text: "</conversation_history>" });
	if (last.role === "user") blocks.push(...last.content);
	else blocks.push({ type: "text", text: "Continue as the assistant from where the history ends, using the tool results. Make any new tool call with your tools, never as text." });
	return blocks;
}

// Append-only variant: one block per turn, nothing after the last turn, so call N's blocks prefix call N+1's.
function serializeAppendOnly(turns) {
	return turns.map((t) => {
		const parts = t.content.map((b) =>
			b.type === "text" ? b.text : b.type === "tool_use" ? `<tool_call id="${b.id}" name="${b.name}">${JSON.stringify(b.input)}</tool_call>` : `<tool_result id="${b.tool_use_id}">${b.content}</tool_result>`,
		);
		return { type: "text", text: `<${t.role}>\n${parts.join("\n")}\n</${t.role}>` };
	});
}
const APPEND_ONLY_SYSTEM = "You are a concise test assistant inside LearnHarness. The user message is the conversation so far as <user>, <assistant> and <tool> turns. Continue as the assistant from the last turn: answer the last <user> turn, or continue after the last <tool> results. Make tool calls only with your real tools, never as text, and do not wrap your reply in tags.";

function toEntries(turns, sessionId) {
	const entries = [];
	let parent = null;
	for (const t of turns) {
		const uuid = randomUUID();
		const common = { parentUuid: parent, isSidechain: false, userType: "external", entrypoint: "sdk-ts", cwd, sessionId, version: "2.1.310", timestamp: new Date().toISOString(), uuid };
		if (t.role === "assistant") {
			const content = t.content.map((b) => (b.type === "tool_use" ? { ...b, name: `mcp__lh__${b.name}` } : b));
			entries.push({ ...common, type: "assistant", message: { id: t.id ?? `msg_${uuid.slice(0, 8)}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
		} else entries.push({ ...common, type: "user", message: { role: "user", content: t.content } });
		parent = uuid;
	}
	return entries;
}

async function call(label) {
	let prompt;
	let extra = {};
	if (format === "text") prompt = userMessages([serializeText(transcript)]);
	else if (format === "append") {
		prompt = userMessages([serializeAppendOnly(transcript)]);
		extra = { systemPrompt: APPEND_ONLY_SYSTEM };
	}
	else {
		// History = all but the last turn; the last turn (user text or tool results) is the live prompt.
		const sessionId = randomUUID();
		const entries = toEntries(transcript.slice(0, -1), sessionId);
		if (entries.length) extra = { persistSession: true, resume: sessionId, sessionStore: { append: async () => {}, load: async (k) => (k.sessionId === sessionId && !k.subpath ? entries : null) } };
		prompt = userMessages([transcript.at(-1).content]);
	}
	const r = await run({
		prompt,
		options: baseOptions({ model, cwd, maxTurns: 1, title: "lh", thinking: { type: "disabled" }, mcpServers: { lh: makeToolServer() }, canUseTool: async () => ({ behavior: "deny", message: "captured by host" }), ...extra }),
	});
	const blocks = r.msgs.filter(({ m }) => m.type === "assistant").flatMap(({ m }) => m.message.content).filter((b) => b.type === "text" || b.type === "tool_use");
	const res = r.msgs.find(({ m }) => m.type === "result")?.m;
	const u = res?.usage ?? {};
	console.log(JSON.stringify({ format, label, err: r.marks.error?.slice(0, 160), firstDelta: Math.round(r.marks.firstDelta ?? -1), in: u.input_tokens, cw: u.cache_creation_input_tokens, cr: u.cache_read_input_tokens, out: u.output_tokens, blocks: blocks.map((b) => (b.type === "tool_use" ? `tool_use:${b.name}(${JSON.stringify(b.input)})` : `text:${b.text.slice(0, 70)}`)) }));
	return blocks.map((b) => (b.type === "tool_use" ? { type: "tool_use", id: b.id, name: b.name.replace(/^mcp__lh__/, ""), input: b.input } : { type: "text", text: b.text }));
}

transcript.push({ role: "user", content: [{ type: "text", text: "My name is Ada. Get the weather in Paris and Tokyo (in parallel), then compare them." }] });
const a1 = await call("call1");
transcript.push({ role: "assistant", content: a1 });
const results = a1.filter((b) => b.type === "tool_use").map((b) => ({ type: "tool_result", tool_use_id: b.id, content: `${b.input.city}: ${b.input.city === "Paris" ? "17°C, light rain" : "24°C, clear"}. Station code ${b.input.city === "Paris" ? "ZEBRA-42" : "OTTER-7"}. Notes: ${longNotes}` }));
transcript.push({ role: format === "resume" ? "user" : "tool", content: results });
const a2 = await call("call2");
transcript.push({ role: "assistant", content: a2 });
transcript.push({ role: "user", content: [{ type: "text", text: "What was the Paris station code, and what is my name? One line." }] });
await call("call3");
console.log(JSON.stringify({ handlerCalls }));
process.exit(0);
