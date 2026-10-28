// Check 7: run the SDK from Electron main, and from an ELECTRON_RUN_AS_NODE child (how main.cjs spawns the server).
// Usage: npx electron spike/claude-code/electron-main.cjs [pathToClaudeCodeExecutable]
const { app } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");

const exe = process.argv.find((a) => a.startsWith("--exe="))?.slice(6);

async function inMain() {
	const t0 = performance.now();
	const { query, createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk");
	const { z } = await import("zod");
	const os = require("node:os");
	const fs = require("node:fs");
	let handlerRan = false;
	const server = createSdkMcpServer({ name: "lh", tools: [tool("get_weather", "Weather for a city", { city: z.string() }, async () => ((handlerRan = true), { content: [{ type: "text", text: "x" }] }))] });
	const q = query({
		prompt: "Call get_weather for Paris and for Oslo, in parallel.",
		options: {
			model: "haiku",
			tools: [],
			systemPrompt: "Test.",
			settingSources: [],
			strictMcpConfig: true,
			settings: { disableAllHooks: true },
			persistSession: false,
			title: "lh",
			maxTurns: 1,
			cwd: fs.mkdtempSync(path.join(os.tmpdir(), "lh-cc-el-")),
			env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_AUTO_CONNECT_IDE: "0", CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1", CLAUDE_AGENT_SDK_CLIENT_APP: "learnharness/spike" },
			mcpServers: { lh: server },
			canUseTool: async () => ({ behavior: "deny", message: "captured" }),
			...(exe ? { pathToClaudeCodeExecutable: exe } : {}),
		},
	});
	const account = await q.accountInfo();
	const tools = [];
	let firstDelta;
	try {
		for await (const m of q) {
			if (m.type === "stream_event" && m.event.type === "content_block_delta" && firstDelta == null) firstDelta = Math.round(performance.now() - t0);
			if (m.type === "assistant") for (const b of m.message.content) if (b.type === "tool_use") tools.push(b.input);
		}
	} catch (e) {
		if (!String(e.message).includes("maximum number of turns")) throw e;
	}
	return { where: "electron-main", electron: process.versions.electron, exe: exe ?? "bundled", account: { email: account.email, subscriptionType: account.subscriptionType, tokenSource: account.tokenSource }, tools, handlerRan, firstDelta };
}

function inRunAsNodeChild() {
	return new Promise((resolve) => {
		const script = path.join(__dirname, "check6-auth.mjs");
		const child = spawn(process.execPath, [script, "electron-run-as-node-child"], {
			cwd: __dirname,
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("exit", (code) => {
			try {
				const j = JSON.parse(out.slice(out.indexOf("{")));
				resolve({ where: "ELECTRON_RUN_AS_NODE child", code, account: j.account, models: j.models?.length, error: j.error });
			} catch {
				resolve({ where: "ELECTRON_RUN_AS_NODE child", code, raw: out.slice(0, 800) });
			}
		});
	});
}

app.whenReady().then(async () => {
	try {
		console.log(JSON.stringify(await inMain()));
	} catch (e) {
		console.log(JSON.stringify({ where: "electron-main", error: String(e?.stack ?? e) }));
	}
	console.log(JSON.stringify(await inRunAsNodeChild()));
	app.quit();
});
