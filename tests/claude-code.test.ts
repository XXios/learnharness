/** Fork feature: Claude subscription via local Claude Code. Offline: a fake
 * SDK query() replays spike-shaped frames; no network, no real CLI. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { normalizeContext, Type, type Api, type AssistantMessageEvent, type Context, type Message, type Model } from "@earendil-works/pi-ai";
import type { ClaudeCodeSnapshot } from "../src/core/contracts/claude-code.ts";
import { CLAUDE_CODE_PROVIDER_ID } from "../src/core/contracts/claude-code.ts";
import { subscriptionLabel } from "../src/core/prices.ts";
import { claudeCodeModels } from "../src/agent/claude-code/catalog.ts";
import { serializeTranscript } from "../src/agent/claude-code/transcript.ts";
import { appToolName, claudeCodeToolServer } from "../src/agent/claude-code/tools.ts";
import { claudeCodeEnv, claudeCodeStream, claudeCodeThinking } from "../src/agent/claude-code/stream.ts";
import { claudeCodeModel, refreshClaudeCodeModels } from "../src/agent/claude-code/bridge.ts";
import { isSubscriptionProvider, subscriptionConnected } from "../src/agent/subscription-connections.ts";
import type { AdmissionScope, NoDispatchKind } from "../src/agent/subscription-request-cycle.ts";

const require = createRequire(import.meta.url);
const { createClaudeCode } = require("../electron/claude-code.cjs");

const ROWS = [
	{ value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
	{ value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" },
	{ value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
	{ value: "mystery", resolvedModel: "claude-not-in-pi", displayName: "Mystery" },
];
let background = true, revision = 1;
function snapshot(): ClaudeCodeSnapshot {
	return { status: { available: true, connected: true, checking: false, signedIn: true, email: "a@example.com", subscriptionType: "Claude Pro", allowBackgroundUse: background, connectionId: "00000000-0000-4000-8000-000000000001", epoch: 1, authorityRevision: 1, revision }, models: ROWS };
}
const originalSend = Object.getOwnPropertyDescriptor(process, "send"), originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const marker = process.env.LH_DESKTOP_SERVER, secret = process.env.LH_DESKTOP_API_SECRET, apiKey = process.env.ANTHROPIC_API_KEY;
const emit = (value: unknown) => (process.emit as (event: string, value: unknown) => boolean)("message", value);
before(async () => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "c".repeat(64);
	process.env.ANTHROPIC_API_KEY = "sk-ant-fixture-must-be-stripped";
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (message: { channel: string; id: string; op: string }, callback?: () => void) => {
		if (message.channel === "lh:claude-code") queueMicrotask(() => emit({ channel: "lh:claude-code", id: message.id, op: message.op, ok: true, value: snapshot() }));
		callback?.(); return true;
	} });
	await refreshClaudeCodeModels();
});
after(() => {
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
	for (const [key, value] of [["LH_DESKTOP_SERVER", marker], ["LH_DESKTOP_API_SECRET", secret], ["ANTHROPIC_API_KEY", apiKey]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test("catalog joins supportedModels with pi's anthropic metadata, dedupes aliases, drops unknown rows", () => {
	const models = claudeCodeModels(ROWS);
	assert.deepEqual(models.map((m) => [m.id, m.name, m.provider]), [["claude-opus-5-5", "Opus 5.5", CLAUDE_CODE_PROVIDER_ID], ["claude-sonnet-5-5", "Sonnet 5.5", CLAUDE_CODE_PROVIDER_ID]]);
	assert(models.every((m) => m.contextWindow > 0 && m.cost.input === 0 && m.cost.output === 0));
	assert.equal(subscriptionLabel(`${CLAUDE_CODE_PROVIDER_ID}:claude-opus-5-5`), "Claude");
});

test("the provider registers in the subscription registry and reads connected from the snapshot", () => {
	assert(isSubscriptionProvider(CLAUDE_CODE_PROVIDER_ID));
	assert(subscriptionConnected(CLAUDE_CODE_PROVIDER_ID));
	assert(claudeCodeModel("claude-sonnet-5-5"));
});

test("transcript serialization is append-only: each call's blocks prefix the next call's", () => {
	const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
	const turns: Message[] = [
		{ role: "user", content: [{ type: "text", text: "My name is Ada." }, image, { type: "text", text: "Weather?" }], timestamp: 0 },
		{ role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Checking." }, { type: "toolCall", id: "t1", name: "get_weather", arguments: { city: "Paris" } }], api: "anthropic-messages", provider: CLAUDE_CODE_PROVIDER_ID, model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 0 },
		{ role: "toolResult", toolCallId: "t1", toolName: "get_weather", content: [{ type: "text", text: "17°C" }], isError: false, timestamp: 0 } as Message,
	];
	const full = serializeTranscript(turns);
	assert.deepEqual(full.map((b) => b.type), ["text", "image", "text", "text", "text"]);
	assert.equal(full[0]!.type === "text" && full[0]!.text, "<user>\nMy name is Ada.");
	const text = full.filter((b) => b.type === "text").map((b) => b.text).join("|");
	assert.match(text, /<tool_call id="t1" name="get_weather">\{"city":"Paris"\}<\/tool_call>/);
	assert.match(text, /<tool_result id="t1" name="get_weather">17°C<\/tool_result>/);
	assert.doesNotMatch(text, /private/);
	for (let n = 1; n < turns.length; n++) assert.deepEqual(full.slice(0, serializeTranscript(turns.slice(0, n)).length), serializeTranscript(turns.slice(0, n)));
});

test("thinking map (S4) and env stripping (S1)", () => {
	assert.deepEqual(claudeCodeThinking(undefined), { thinking: { type: "disabled" } });
	assert.deepEqual(claudeCodeThinking("off"), { thinking: { type: "disabled" } });
	assert.deepEqual(claudeCodeThinking("minimal"), { thinking: { type: "adaptive", display: "summarized" }, effort: "low" });
	assert.deepEqual(claudeCodeThinking("xhigh"), { thinking: { type: "adaptive", display: "summarized" }, effort: "xhigh" });
	const env = claudeCodeEnv({ ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "u", PATH: "/bin", NODE_ENV: "test" });
	assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined); assert.equal(env.ANTHROPIC_BASE_URL, undefined);
	assert.equal(env.PATH, "/bin"); assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

test("JSON-Schema tools become MCP declarations whose handlers refuse to run", async () => {
	const sdk = await import("@anthropic-ai/claude-agent-sdk");
	const server = claudeCodeToolServer(sdk, [{ name: "save_note", description: "Save", parameters: Type.Object({ title: Type.String(), tags: Type.Optional(Type.Array(Type.String())), priority: Type.Union([Type.Literal("low"), Type.Literal("high")]) }) }]);
	assert.equal(server.type, "sdk"); assert.equal(server.name, "lh");
	assert.equal(appToolName("mcp__lh__save_note"), "save_note");
});

// ---- stream adapter with a fake query() replaying spike #1 frames
const frame = (event: unknown) => ({ type: "stream_event", event, parent_tool_use_id: null, uuid: "u", session_id: "s" });
const CAPTURE_FRAMES = [
	{ type: "system", subtype: "init" },
	frame({ type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5-5", usage: { input_tokens: 2, cache_creation_input_tokens: 600, cache_read_input_tokens: 700, cache_creation: { ephemeral_1h_input_tokens: 600 }, output_tokens: 1 } } }),
	frame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
	frame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Plan." } }),
	frame({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }),
	frame({ type: "content_block_stop", index: 0 }),
	frame({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
	frame({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Checking both." } }),
	frame({ type: "content_block_stop", index: 1 }),
	frame({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__lh__get_weather", input: {} } }),
	frame({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"city\":" } }),
	{ type: "assistant", message: { id: "msg_1", content: [{ type: "tool_use" }], stop_reason: null }, parent_tool_use_id: null },
	{ type: "user", message: { role: "user", content: [{ type: "tool_result", is_error: true, content: "denied" }] }, parent_tool_use_id: null },
	frame({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "\"Paris\"}" } }),
	frame({ type: "content_block_stop", index: 2 }),
	frame({ type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "toolu_2", name: "mcp__lh__get_weather", input: {} } }),
	frame({ type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "{\"city\":\"Tokyo\"}" } }),
	frame({ type: "content_block_stop", index: 3 }),
	frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 90, output_tokens_details: { thinking_tokens: 12 } } }),
	frame({ type: "message_stop" }),
	{ type: "result", subtype: "error_max_turns", is_error: true, stop_reason: "tool_use", errors: [] },
];
function fakeSDK(frames: unknown[], throwAfter?: Error) {
	const calls: { prompt: unknown[]; options: Record<string, any> }[] = [];
	return {
		calls,
		sdk: {
			createSdkMcpServer: (o: unknown) => ({ type: "sdk", ...(o as object) }),
			tool: (name: string) => ({ name }),
			query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, any> }) => {
				const call = { prompt: [] as unknown[], options }; calls.push(call);
				return (async function* () {
					for await (const message of prompt) call.prompt.push(message);
					for (const f of frames) yield f;
					if (throwAfter) throw throwAfter;
				})();
			},
		} as never,
	};
}
function lifecycleSpy() {
	const log: string[] = [];
	return { log, lifecycle: { captured: (s: AdmissionScope) => log.push(`captured:${s.selectedModelId}`), beforeDispatch: () => log.push("beforeDispatch"), noDispatch: (k: NoDispatchKind) => log.push(`noDispatch:${k}`) } };
}
async function collect(stream: AsyncIterable<AssistantMessageEvent>) { const events: AssistantMessageEvent[] = []; for await (const e of stream) events.push(e); return events; }
const CONTEXT = normalizeContext({ systemPrompt: "You are the teacher.", messages: [{ role: "user", content: "Weather in Paris and Tokyo?", timestamp: 0 }], tools: [{ name: "get_weather", description: "Weather", parameters: Type.Object({ city: Type.String() }) }] } satisfies Context);

test("capture-and-stop: parallel tool calls return to pi, nothing executes, usage maps, max-turns throw is absorbed", async () => {
	const model = claudeCodeModel("claude-sonnet-5-5") as Model<Api>;
	const { sdk, calls } = fakeSDK(CAPTURE_FRAMES, new Error("Claude Code returned an error result: Reached maximum number of turns (1)"));
	const spy = lifecycleSpy();
	const events = await collect(claudeCodeStream(() => false, spy.lifecycle, { loadSDK: async () => sdk, cwd: "/tmp" })(model, CONTEXT, { reasoning: "high" }));
	const done = events.at(-1)!;
	assert.equal(done.type, "done");
	if (done.type !== "done") return;
	assert.equal(done.reason, "toolUse");
	assert.deepEqual(done.message.content.map((c) => c.type), ["thinking", "text", "toolCall", "toolCall"]);
	assert.deepEqual(done.message.content.filter((c) => c.type === "toolCall").map((c) => c.type === "toolCall" && [c.id, c.name, c.arguments]), [["toolu_1", "get_weather", { city: "Paris" }], ["toolu_2", "get_weather", { city: "Tokyo" }]]);
	assert.equal(done.message.content[0]!.type === "thinking" && done.message.content[0]!.thinkingSignature, "sig");
	assert.deepEqual({ ...done.message.usage, cost: undefined }, { input: 2, output: 90, cacheRead: 700, cacheWrite: 600, cacheWrite1h: 600, reasoning: 12, totalTokens: 1392, cost: undefined });
	assert.equal(done.message.provider, CLAUDE_CODE_PROVIDER_ID);
	assert.deepEqual(events.filter((e) => e.type !== "text_delta" && e.type !== "thinking_delta" && e.type !== "toolcall_delta").map((e) => e.type), ["start", "thinking_start", "thinking_end", "text_start", "text_end", "toolcall_start", "toolcall_end", "toolcall_start", "toolcall_end", "done"]);
	assert.deepEqual(spy.log, ["captured:claude-sonnet-5-5", "beforeDispatch"]);
	const options = calls[0]!.options;
	assert.equal(options.maxTurns, 1); assert.equal(options.model, "claude-sonnet-5-5"); assert.deepEqual(options.tools, []);
	assert.deepEqual(options.settingSources, []); assert.equal(options.persistSession, false); assert.equal(typeof options.title, "string");
	assert.deepEqual(await options.canUseTool("mcp__lh__get_weather", {}, {}), { behavior: "deny", message: "Captured by LearnHarness; the app runs this tool." });
	assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
	assert.deepEqual(options.thinking, { type: "adaptive", display: "summarized" }); assert.equal(options.effort, "high");
	assert.match(options.systemPrompt, /^You are the teacher\.\n\n## Conversation format/);
	assert.deepEqual((calls[0]!.prompt[0] as { message: { content: unknown } }).message.content, [{ type: "text", text: "<user>\nWeather in Paris and Tokyo?\n</user>" }]);
});

test("a synthetic auth-error assistant frame becomes a Claude error after dispatch, never model text", async () => {
	const model = claudeCodeModel("claude-sonnet-5-5") as Model<Api>;
	const { sdk } = fakeSDK([{ type: "assistant", error: "authentication_failed", message: { id: "x", content: [{ type: "text", text: "Invalid API key · Fix external API key" }] }, parent_tool_use_id: null }, { type: "result", subtype: "success", is_error: true, result: "Invalid API key" }]);
	const spy = lifecycleSpy();
	const events = await collect(claudeCodeStream(() => false, spy.lifecycle, { loadSDK: async () => sdk, cwd: "/tmp" })(model, CONTEXT, {}));
	const last = events.at(-1)!;
	assert.equal(last.type, "error");
	if (last.type !== "error") return;
	assert.match(last.error.errorMessage!, /not signed in to a usable Claude subscription/);
	assert.deepEqual(last.error.content, []);
	assert.deepEqual(spy.log, ["captured:claude-sonnet-5-5", "beforeDispatch"]);
});

test("background work is denied before dispatch when background use is off", async () => {
	background = false; revision++; await refreshClaudeCodeModels();
	try {
		const model = claudeCodeModel("claude-sonnet-5-5") as Model<Api>;
		const { sdk, calls } = fakeSDK(CAPTURE_FRAMES);
		const spy = lifecycleSpy();
		const events = await collect(claudeCodeStream(() => true, spy.lifecycle, { loadSDK: async () => sdk, cwd: "/tmp" })(model, CONTEXT, {}));
		const last = events.at(-1)!;
		assert.equal(last.type, "error");
		assert.equal(calls.length, 0);
		assert.deepEqual(spy.log, ["captured:claude-sonnet-5-5", "noDispatch:background"]);
		assert.match(last.type === "error" ? last.error.errorMessage! : "", /background use is off/);
	} finally { background = true; revision++; await refreshClaudeCodeModels(); }
});

// ---- main/web owner (electron/claude-code.cjs) with a fake probe + in-memory store
function memoryStore() { let state = { version: 1, allowBackgroundUse: true }; return { read: async () => state, write: async (next: typeof state) => { state = next; }, get: () => state }; }
test("owner: detect + instruct, connect, consent, login change bumps epoch, disconnect forgets", async () => {
	let account = { signedIn: false, email: null as string | null, subscriptionType: null as string | null, models: ROWS };
	const store = memoryStore(), changes: ClaudeCodeSnapshot[] = [];
	const owner = createClaudeCode({ store, sdk: {}, probe: async () => account, onChange: (s: ClaudeCodeSnapshot) => changes.push(s) });
	await owner.ready;
	let status = await owner.status();
	assert.equal(status.available, true); assert.equal(status.signedIn, false); assert.equal(status.connected, false); assert.match(status.error, /run `claude`/i);
	await assert.rejects(owner.connect(false), /signedOut/);
	account = { signedIn: true, email: "a@example.com", subscriptionType: "Claude Max", models: ROWS };
	await owner.connect(false);
	status = await owner.status();
	assert.equal(status.connected, true); assert.equal(status.allowBackgroundUse, false); assert.equal(status.email, "a@example.com");
	assert.deepEqual(Object.keys(store.get()).sort(), ["allowBackgroundUse", "connectionId", "email", "version"]);
	assert.equal((await owner.snapshot()).models.length, ROWS.length);
	await owner.consent(true); assert.equal((await owner.status()).allowBackgroundUse, true);
	const epoch = (await owner.status()).epoch;
	account = { ...account, email: "b@example.com" };
	await owner.check();
	assert((await owner.status()).epoch > epoch); assert.equal((await owner.status()).connected, true);
	await owner.disconnect();
	status = await owner.status();
	assert.equal(status.connected, false); assert.equal(status.connectionId, null); assert.deepEqual((await owner.snapshot()).models, []);
	assert(changes.length > 0); assert(changes.every((s) => !JSON.stringify(s).includes("token")));
	owner.close();
});
