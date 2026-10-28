// Phase 0 spike harness (throwaway). Shared query recipe + instrumentation.
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const now = () => performance.now();

export function emptyCwd() {
	return mkdtempSync(join(tmpdir(), "lh-cc-spike-"));
}

export function baseEnv() {
	return {
		...process.env,
		ENABLE_CLAUDEAI_MCP_SERVERS: "false",
		CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
		CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
		CLAUDE_AGENT_SDK_CLIENT_APP: "learnharness/0.3.8-spike",
	};
}

// Fake app tools. Handlers must never run; they count + shout if they do.
export const handlerCalls = [];
function fakeHandler(name) {
	return async (args) => {
		handlerCalls.push({ name, args });
		console.error(`!!! HANDLER EXECUTED: ${name} ${JSON.stringify(args)}`);
		return { content: [{ type: "text", text: `HANDLER RAN for ${name}` }], isError: true };
	};
}

// Declared from JSON Schema (as pi tools are TypeBox/JSON Schema) via z.fromJSONSchema.
const jsonSchemas = {
	get_weather: {
		description: "Get the current weather for a city.",
		schema: {
			type: "object",
			properties: { city: { type: "string", description: "City name" } },
			required: ["city"],
		},
	},
	get_time: {
		description: "Get the current local time for a city.",
		schema: {
			type: "object",
			properties: { city: { type: "string" } },
			required: ["city"],
		},
	},
	save_note: {
		description: "Save a short note for the learner.",
		schema: {
			type: "object",
			properties: {
				title: { type: "string" },
				body: { type: "string" },
				tags: { type: "array", items: { type: "string" } },
				priority: { type: "string", enum: ["low", "high"] },
			},
			required: ["title", "body"],
		},
	},
};

export function makeToolServer() {
	const tools = Object.entries(jsonSchemas).map(([name, { description, schema }]) => {
		const shape = z.fromJSONSchema(schema).shape;
		return tool(name, description, shape, fakeHandler(name));
	});
	return createSdkMcpServer({ name: "lh", version: "0.0.0", tools, alwaysLoad: true });
}

export function baseOptions(extra = {}) {
	return {
		tools: [],
		systemPrompt: "You are a concise test assistant inside LearnHarness.",
		settingSources: [],
		strictMcpConfig: true,
		settings: { disableAllHooks: true },
		persistSession: false,
		cwd: emptyCwd(),
		env: baseEnv(),
		includePartialMessages: true,
		stderr: (d) => {
			if (process.env.SPIKE_STDERR) process.stderr.write(`[cc stderr] ${d}`);
		},
		...extra,
	};
}

// Runs one query and records timeline + messages.
export async function run({ prompt, options, onMessage, label = "" }) {
	const t0 = now();
	const marks = { t0 };
	const msgs = [];
	const q = query({ prompt, options });
	try {
		for await (const m of q) {
			const t = now() - t0;
			msgs.push({ t, m });
			if (m.type === "system" && m.subtype === "init" && marks.init == null) marks.init = t;
			if (m.type === "stream_event") {
				const e = m.event;
				if (marks.firstStream == null) marks.firstStream = t;
				if (e.type === "content_block_delta" && marks.firstDelta == null) marks.firstDelta = t;
				if (e.type === "content_block_delta" && e.delta.type === "text_delta" && marks.firstText == null)
					marks.firstText = t;
			}
			if (m.type === "assistant" && marks.firstAssistant == null) marks.firstAssistant = t;
			if (m.type === "result") marks.result = t;
			if (onMessage) await onMessage(m, q, t);
		}
	} catch (err) {
		marks.error = String(err?.stack ?? err);
	}
	marks.end = now() - t0;
	return { label, marks, msgs, q };
}

export function summarize(msgs) {
	return msgs.map(({ t, m }) => {
		let d = `${t.toFixed(0).padStart(6)}ms ${m.type}`;
		if (m.subtype) d += `/${m.subtype}`;
		if (m.type === "stream_event") {
			const e = m.event;
			d += ` ${e.type}`;
			if (e.content_block) d += ` [${e.content_block.type}${e.content_block.name ? ":" + e.content_block.name : ""}]`;
			if (e.delta?.type) d += ` ${e.delta.type}`;
			if (e.delta?.stop_reason) d += ` stop=${e.delta.stop_reason}`;
		}
		if (m.type === "assistant") {
			d += ` id=${m.message.id} blocks=${m.message.content.map((b) => b.type + (b.name ? ":" + b.name : "")).join(",")} stop=${m.message.stop_reason}`;
		}
		if (m.type === "user") {
			const c = m.message.content;
			d += ` ${Array.isArray(c) ? c.map((b) => b.type + (b.is_error ? "(err)" : "") + ":" + JSON.stringify(b.content ?? b.text ?? "").slice(0, 120)).join(" | ") : String(c).slice(0, 120)}`;
		}
		if (m.type === "result") d += ` is_error=${m.is_error} stop=${m.stop_reason} turns=${m.num_turns} denials=${JSON.stringify(m.permission_denials ?? [])}`;
		return d;
	});
}

export async function* userMessages(contents) {
	for (const content of contents) {
		yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
	}
}
