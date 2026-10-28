/** Claude Code behind PiEngine.streamFn as "just the model" (plan D2/B1).
 * pi-agent-core keeps the loop and runs every tool; Claude Code only answers.
 * Capture-and-stop (spike #1): maxTurns 1 + canUseTool deny, so the CLI makes
 * exactly one API call, emits every tool_use block, and never runs a tool. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { normalizeContext, getCurrentSystemPrompt, getCurrentTools, type Api, type AssistantMessage, type Model, type SimpleStreamOptions, type StopReason, type StreamFunction, type ToolCall } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { PATHS } from "../../../config.ts";
import packageMetadata from "../../../package.json" with { type: "json" };
import { CLAUDE_CODE_LABEL } from "../../core/contracts/claude-code.ts";
import { markUnadmittedUsage, type AdmissionScope, type SubscriptionDispatchLifecycle } from "../subscription-request-cycle.ts";
import { claudeCodeAbortController, claudeCodeBackgroundAllowed, claudeCodeDenial, claudeCodeScope, claudeCodeScopeCurrent } from "./bridge.ts";
import { appToolName, claudeCodeToolServer, CLAUDE_CODE_MCP_SERVER } from "./tools.ts";
import { serializeTranscript, TRANSCRIPT_FRAMING } from "./transcript.ts";

type SDK = typeof import("@anthropic-ai/claude-agent-sdk");
type SDKMessage = import("@anthropic-ai/claude-agent-sdk").SDKMessage;

/** S1: always the subscription login, never an ambient API key. */
const STRIPPED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];
export function claudeCodeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
	const next: Record<string, string | undefined> = { ...env, ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_AUTO_CONNECT_IDE: "0", CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1", CLAUDE_AGENT_SDK_CLIENT_APP: `learnharness/${packageMetadata.version}` };
	for (const key of STRIPPED_ENV) delete next[key];
	return next;
}

/** S4: off → thinking disabled; minimal/low → low; the rest same-named. */
export function claudeCodeThinking(level: ThinkingLevel | undefined): { thinking: { type: "disabled" } } | { thinking: { type: "adaptive"; display: "summarized" }; effort: "low" | "medium" | "high" | "xhigh" | "max" } {
	if (!level || level === "off") return { thinking: { type: "disabled" } };
	const effort = level === "minimal" ? "low" : level;
	return { thinking: { type: "adaptive", display: "summarized" }, effort };
}

export function claudeCodeError(message: string): string {
	const label = CLAUDE_CODE_LABEL, suffix = " No API-key fallback was used.";
	if (/background/i.test(message)) return `${label} background use is off in this app. Enable it in Providers to run this work.${suffix}`;
	if (/rate_limit|quota|429|usage limit|limit reached/i.test(message)) return `${label} usage limit reached. Check your Claude plan and try again later.${suffix}`;
	if (/authentication|oauth|401|not signed in|login|account_on_hold|verification_required|billing/i.test(message)) return `Claude Code is not signed in to a usable Claude subscription. Run \`claude\` in a terminal, then \`/login\`, and choose Check again in Providers.${suffix}`;
	if (/cancel|abort|closed|disconnect/i.test(message)) return `${label} request cancelled or connection closed.${suffix}`;
	if (/catalog|model|stale|changed/i.test(message)) return `The selected ${label} model or connection is unavailable. Refresh Providers and explicitly choose an available model.${suffix}`;
	if (/overloaded|server_error|529|5\d\d/i.test(message)) return `${label} is temporarily overloaded. Try again shortly.${suffix}`;
	return `${label} request failed. Check the connection in Providers and your plan limits, then retry.${suffix}`;
}

function empty(model: Model<Api>): AssistantMessage {
	return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "error", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

interface RawUsage { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null; output_tokens_details?: { thinking_tokens?: number | null } | null }
function applyUsage(message: AssistantMessage, raw: RawUsage | undefined) {
	if (!raw) return;
	const u = message.usage;
	if (raw.input_tokens != null) u.input = raw.input_tokens;
	if (raw.output_tokens != null) u.output = raw.output_tokens;
	if (raw.cache_read_input_tokens != null) u.cacheRead = raw.cache_read_input_tokens;
	if (raw.cache_creation_input_tokens != null) u.cacheWrite = raw.cache_creation_input_tokens;
	if (raw.cache_creation?.ephemeral_1h_input_tokens != null) u.cacheWrite1h = raw.cache_creation.ephemeral_1h_input_tokens;
	if (raw.output_tokens_details?.thinking_tokens != null) u.reasoning = raw.output_tokens_details.thinking_tokens;
	u.totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
}
function stopReason(raw: string | null | undefined, hasToolCalls: boolean): Extract<StopReason, "stop" | "length" | "toolUse"> {
	if (raw === "tool_use" || (hasToolCalls && raw !== "max_tokens")) return "toolUse";
	if (raw === "max_tokens") return "length";
	return "stop";
}

export interface ClaudeCodeStreamDeps {
	loadSDK?: () => Promise<Pick<SDK, "query" | "createSdkMcpServer" | "tool">>;
	cwd?: string;
}
const loadSDK = () => import("@anthropic-ai/claude-agent-sdk");
function workdir(): string {
	const dir = path.join(PATHS.data, "claude-code-workdir");
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function claudeCodeStream(background: () => boolean, lifecycle?: SubscriptionDispatchLifecycle, deps: ClaudeCodeStreamDeps = {}): StreamFunction<Api, SimpleStreamOptions> {
	return (logicalModel, context, options) => {
		const output = new AssistantMessageEventStream();
		const purpose = background();
		const { controller, release } = claudeCodeAbortController(purpose);
		const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
		void (async () => {
			let partial = empty(logicalModel), scope: AdmissionScope | undefined;
			let committed = false, terminal = false, started = false;
			const check = () => {
				if (signal.aborted || !scope || !claudeCodeScopeCurrent(scope)) throw new Error("cancelled or connection changed");
				if (purpose && !claudeCodeBackgroundAllowed()) throw new Error("background use disabled");
			};
			const child = new AbortController();
			const stopChild = () => child.abort();
			signal.addEventListener("abort", stopChild, { once: true });
			try {
				scope = claudeCodeScope(logicalModel.id); lifecycle?.captured(scope);
				check();
				const normalized = normalizeContext(context);
				const systemPrompt = [getCurrentSystemPrompt(normalized.messages), TRANSCRIPT_FRAMING].filter(Boolean).join("\n\n");
				const tools = getCurrentTools(normalized.messages);
				const blocks = serializeTranscript(transformMessages(normalized.messages, logicalModel));
				if (blocks.length === 0) throw new Error("Empty transcript");
				const sdk = await (deps.loadSDK ?? loadSDK)();
				check();
				const server = claudeCodeToolServer(sdk, tools);
				const cwd = deps.cwd ?? workdir();
				lifecycle?.beforeDispatch(scope); committed = true;
				const query = sdk.query({
					prompt: (async function* () { yield { type: "user" as const, message: { role: "user" as const, content: blocks }, parent_tool_use_id: null }; })(),
					options: {
						model: logicalModel.id, tools: [], systemPrompt, settingSources: [], strictMcpConfig: true,
						settings: { disableAllHooks: true }, persistSession: false, title: "LearnHarness", cwd, env: claudeCodeEnv(),
						includePartialMessages: true, maxTurns: 1, mcpServers: { [CLAUDE_CODE_MCP_SERVER]: server },
						canUseTool: async () => ({ behavior: "deny" as const, message: "Captured by LearnHarness; the app runs this tool." }),
						abortController: child, stderr: () => {},
						...claudeCodeThinking(options?.reasoning),
					},
				});
				// SDK block index → pi content index; tool JSON accumulates per block.
				const indexOf = new Map<number, number>();
				const toolJson = new Map<number, string>();
				let rawStop: string | null | undefined;
				const startOnce = () => { if (!started) { started = true; output.push({ type: "start", partial }); } };
				const finish = () => {
					if (terminal) return;
					terminal = true;
					const reason = stopReason(rawStop, partial.content.some((c) => c.type === "toolCall"));
					partial = { ...partial, stopReason: reason, ...(rawStop ? { rawStopReason: rawStop } : {}) };
					startOnce();
					output.push({ type: "done", reason, message: partial });
				};
				try {
					for await (const message of query as AsyncIterable<SDKMessage>) {
						if (terminal) continue; // drain to the CLI's own result frame
						if (signal.aborted) throw new Error("cancelled");
						if (message.type === "assistant" && message.parent_tool_use_id === null && message.error) {
							if (message.error === "max_output_tokens") { rawStop = "max_tokens"; continue; }
							throw new Error(`assistant error: ${message.error}`);
						}
						if (message.type === "result") {
							if (message.subtype === "success" && message.is_error) throw new Error(`result error: ${message.result}`);
							if (message.subtype !== "success" && message.subtype !== "error_max_turns") throw new Error(`result error: ${message.subtype} ${(message.errors ?? []).join("; ")}`);
							if (started) finish();
							continue;
						}
						if (message.type !== "stream_event" || message.parent_tool_use_id !== null) continue;
						const event = message.event;
						switch (event.type) {
							case "message_start":
								partial = { ...partial, responseId: event.message.id, responseModel: event.message.model };
								applyUsage(partial, event.message.usage as RawUsage);
								startOnce();
								break;
							case "content_block_start": {
								startOnce();
								const block = event.content_block;
								const contentIndex = partial.content.length;
								indexOf.set(event.index, contentIndex);
								if (block.type === "text") { partial.content.push({ type: "text", text: "" }); output.push({ type: "text_start", contentIndex, partial }); }
								else if (block.type === "thinking") { partial.content.push({ type: "thinking", thinking: "" }); output.push({ type: "thinking_start", contentIndex, partial }); }
								else if (block.type === "redacted_thinking") {
									partial.content.push({ type: "thinking", thinking: "", redacted: true, thinkingSignature: block.data });
									output.push({ type: "thinking_start", contentIndex, partial });
								} else if (block.type === "tool_use") {
									partial.content.push({ type: "toolCall", id: block.id, name: appToolName(block.name), arguments: {} });
									toolJson.set(event.index, "");
									output.push({ type: "toolcall_start", contentIndex, partial });
								} else indexOf.delete(event.index);
								break;
							}
							case "content_block_delta": {
								const contentIndex = indexOf.get(event.index);
								if (contentIndex === undefined) break;
								const block = partial.content[contentIndex]!;
								const delta = event.delta;
								if (delta.type === "text_delta" && block.type === "text") { block.text += delta.text; output.push({ type: "text_delta", contentIndex, delta: delta.text, partial }); }
								else if (delta.type === "thinking_delta" && block.type === "thinking") { block.thinking += delta.thinking; output.push({ type: "thinking_delta", contentIndex, delta: delta.thinking, partial }); }
								else if (delta.type === "signature_delta" && block.type === "thinking") block.thinkingSignature = (block.thinkingSignature ?? "") + delta.signature;
								else if (delta.type === "input_json_delta" && block.type === "toolCall") { toolJson.set(event.index, (toolJson.get(event.index) ?? "") + delta.partial_json); output.push({ type: "toolcall_delta", contentIndex, delta: delta.partial_json, partial }); }
								break;
							}
							case "content_block_stop": {
								const contentIndex = indexOf.get(event.index);
								if (contentIndex === undefined) break;
								const block = partial.content[contentIndex]!;
								if (block.type === "text") output.push({ type: "text_end", contentIndex, content: block.text, partial });
								else if (block.type === "thinking") output.push({ type: "thinking_end", contentIndex, content: block.thinking, partial });
								else {
									const json = toolJson.get(event.index) ?? "";
									try {
										const parsed: unknown = json.trim() ? JSON.parse(json) : {};
										if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
										block.arguments = parsed as ToolCall["arguments"];
									} catch { block.arguments = {}; block.argumentsError = `Tool arguments were not a valid JSON object: ${json.slice(0, 500)}`; }
									output.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
								}
								break;
							}
							case "message_delta":
								rawStop = event.delta.stop_reason ?? rawStop;
								applyUsage(partial, event.usage as RawUsage);
								break;
							case "message_stop":
								finish();
								break;
						}
					}
				} catch (error) {
					// The SDK throws "Reached maximum number of turns" after the expected capture stop.
					if (!terminal) throw error;
				}
				if (!terminal) {
					if (signal.aborted) throw new Error("cancelled");
					throw new Error("Claude Code ended without a response");
				}
			} catch (error) {
				if (terminal) return;
				if (!committed) { markUnadmittedUsage(partial.usage); lifecycle?.noDispatch(await claudeCodeDenial(scope, controller, options?.signal?.aborted === true, purpose)); }
				const reason = signal.aborted ? "aborted" : "error";
				partial = { ...partial, stopReason: reason, errorMessage: claudeCodeError(error instanceof Error ? error.message : String(error)) };
				output.push({ type: "error", reason, error: partial });
			} finally {
				signal.removeEventListener("abort", stopChild);
				child.abort(); release(); output.end();
			}
		})();
		return output;
	};
}
