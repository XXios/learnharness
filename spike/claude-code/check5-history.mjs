// Check 5: replay a pi-style transcript (user/assistant text, prior parallel tool calls + results, image)
// Usage: node check5-history.mjs <text|resume> <scenario: recall|continue> [model]
import { Resvg } from "@resvg/resvg-js";
import { randomUUID } from "node:crypto";
import { baseOptions, handlerCalls, makeToolServer, run, userMessages } from "./lib.mjs";

const [format = "text", scenario = "recall", model = "sonnet"] = process.argv.slice(2);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="white"/><polygon points="20,100 60,20 100,100" fill="#1e5bd8"/><text x="115" y="75" font-size="40" font-family="Arial" fill="black">K7</text></svg>`;
const png = new Resvg(svg).render().asPng().toString("base64");
const image = { type: "image", source: { type: "base64", media_type: "image/png", data: png } };

// A pi-like transcript, as neutral role-tagged turns.
const history = [
	{ role: "user", content: [{ type: "text", text: "My name is Ada. What's the weather in Paris and Tokyo?" }] },
	{
		role: "assistant",
		content: [
			{ type: "text", text: "Let me check both cities." },
			{ type: "tool_use", id: "toolu_hist_1", name: "get_weather", input: { city: "Paris" } },
			{ type: "tool_use", id: "toolu_hist_2", name: "get_weather", input: { city: "Tokyo" } },
		],
	},
	{
		role: "tool",
		content: [
			{ type: "tool_result", tool_use_id: "toolu_hist_1", content: "Paris: 17°C, light rain. Station code ZEBRA-42." + (process.env.SPIKE_LONG ? " Notes: " + Array.from({ length: 600 }, (_, i) => `obs${i}=calm`).join(", ") : "") },
			{ type: "tool_result", tool_use_id: "toolu_hist_2", content: "Tokyo: 24°C, clear. Station code OTTER-7." },
		],
	},
];
if (scenario === "recall") {
	history.push(
		{ role: "assistant", content: [{ type: "text", text: "Paris is 17°C with light rain; Tokyo is 24°C and clear." }] },
		{
			role: "user",
			content: [
				{ type: "text", text: "Here is a picture." },
				image,
				{ type: "text", text: "Answer in one line each: 1) my name 2) the Paris station code 3) the shape and its color in the picture 4) the text in the picture. Do not call any tools." },
			],
		},
	);
}
if (scenario === "followup") {
	history.push(
		{ role: "assistant", content: [{ type: "text", text: "Paris is 17°C with light rain; Tokyo is 24°C and clear." }] },
		{ role: "user", content: [{ type: "text", text: "Which city is warmer? One word." }] },
	);
}
// scenario "continue": history ends on tool results (the pi loop calling streamFn after executing tools).

// ---- Format A: one user message, transcript serialized as tagged text; images stay as image blocks in place.
function serializeText(turns) {
	const blocks = [];
	const pushText = (t) => {
		const last = blocks.at(-1);
		if (last?.type === "text") last.text += t;
		else blocks.push({ type: "text", text: t });
	};
	const lastIsUser = turns.at(-1).role === "user";
	const prior = lastIsUser ? turns.slice(0, -1) : turns;
	pushText("<conversation_history>\n");
	for (const turn of prior) {
		pushText(`<${turn.role}>\n`);
		for (const b of turn.content) {
			if (b.type === "text") pushText(b.text + "\n");
			else if (b.type === "image") blocks.push(b);
			else if (b.type === "tool_use") pushText(`<tool_call id="${b.id}" name="${b.name}">${JSON.stringify(b.input)}</tool_call>\n`);
			else if (b.type === "tool_result") pushText(`<tool_result id="${b.tool_use_id}">${b.content}</tool_result>\n`);
		}
		pushText(`</${turn.role}>\n`);
	}
	pushText("</conversation_history>\n\n");
	if (lastIsUser) {
		for (const b of turns.at(-1).content) b.type === "text" ? pushText(b.text) : blocks.push(b);
	} else {
		pushText("Continue the conversation as the assistant from where it left off, using the tool results above. Use your tools for any new tool call; never write tool calls as text.");
	}
	return blocks;
}

// ---- Format B: synthetic Claude Code session (real assistant/tool_use/tool_result turns) via sessionStore + resume.
function toSessionEntries(turns, sessionId, cwd) {
	const entries = [];
	let parent = null;
	const base = () => ({ isSidechain: false, userType: "external", entrypoint: "sdk-ts", cwd, sessionId, version: "2.1.310", timestamp: new Date().toISOString() });
	for (const turn of turns) {
		const uuid = randomUUID();
		if (turn.role === "assistant") {
			const content = turn.content.map((b) => (b.type === "tool_use" ? { ...b, name: `mcp__lh__${b.name}` } : b));
			entries.push({ ...base(), parentUuid: parent, type: "assistant", uuid, message: { id: `msg_hist_${uuid.slice(0, 8)}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
		} else {
			entries.push({ ...base(), parentUuid: parent, type: "user", uuid, message: { role: "user", content: turn.content } });
		}
		parent = uuid;
	}
	return entries;
}

const counter = { appended: 0 };
let options;
let prompt;
const cwd = "/tmp/lh-cc-hist";
await import("node:fs").then((fs) => fs.mkdirSync(cwd, { recursive: true }));
if (format === "text") {
	prompt = userMessages([serializeText(history)]);
	options = baseOptions({ model, cwd });
} else {
	const sessionId = randomUUID();
	const lastIsUser = history.at(-1).role === "user";
	const prior = lastIsUser ? history.slice(0, -1) : history;
	const entries = toSessionEntries(prior, sessionId, cwd);
	const store = {
		append: async (_k, e) => void (counter.appended += e.length),
		load: async (k) => (k.sessionId === sessionId && !k.subpath ? entries : null),
	};
	options = baseOptions({ model, cwd, persistSession: true, sessionStore: store, resume: sessionId });
	prompt = userMessages([lastIsUser ? history.at(-1).content : [{ type: "text", text: "Continue." }]]);
	options.__sessionId = sessionId;
}
Object.assign(options, { maxTurns: 1, title: "lh", thinking: { type: "disabled" }, mcpServers: { lh: makeToolServer() }, canUseTool: async () => ({ behavior: "deny", message: "captured by host" }) });
const sessionId = options.__sessionId;
delete options.__sessionId;

const r = await run({ prompt, options });
const blocks = r.msgs.filter(({ m }) => m.type === "assistant").flatMap(({ m }) => m.message.content);
const res = r.msgs.find(({ m }) => m.type === "result")?.m;
console.log(JSON.stringify({
	format,
	scenario,
	model,
	error: r.marks.error?.slice(0, 300),
	result: res && { subtype: res.subtype, usage: { in: res.usage.input_tokens, cw: res.usage.cache_creation_input_tokens, cr: res.usage.cache_read_input_tokens, out: res.usage.output_tokens } },
	firstDelta: Math.round(r.marks.firstDelta ?? -1),
	handlerCalls,
	blocks: blocks.map((b) => (b.type === "tool_use" ? { tool_use: b.name, input: b.input } : { [b.type]: b.text ?? "" })),
	appended: counter.appended,
}, null, 2));
if (sessionId) {
	const { deleteSession } = await import("@anthropic-ai/claude-agent-sdk");
	await deleteSession(sessionId, { dir: cwd }).catch((e) => console.error("deleteSession:", e.message));
}
process.exit(0);
