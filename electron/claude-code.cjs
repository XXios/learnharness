"use strict";
/** Fork feature: Claude subscription via the locally signed-in Claude Code.
 * Owns the app-side connection + background consent (no credentials: Claude
 * Code keeps its own login) and probes the local login through the Agent SDK.
 * Used by Electron main (desktop) and by the web/dev server owner. */
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

const PROBE_TIMEOUT_MS = 30000;
/** S1: always use the subscription login, never an ambient API key. */
const STRIPPED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];
const MESSAGES = {
	signedOut: "Claude Code is not signed in to a Claude subscription. Run `claude` in a terminal, then `/login`, and choose Check again.",
	probe: "Claude Code could not be reached. Choose Check again; if it keeps failing, reopen LearnHarness.",
	unavailable: "The Claude connection is unavailable in this app session.",
	storage: "The Claude connection settings could not be read or written safely.",
};
const failure = (code) => Object.assign(new Error(code), { code });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function claudeCodeEnv(env = process.env) {
	const next = { ...env, ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_AUTO_CONNECT_IDE: "0", CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1" };
	for (const key of STRIPPED_ENV) delete next[key];
	return next;
}

/** Resolve the SAME SDK installation as the standalone server (main's asar ships no node_modules). */
async function loadClaudeCodeSDK(baseDirectory) {
	const file = createRequire(path.join(baseDirectory, "package.json")).resolve("@anthropic-ai/claude-agent-sdk");
	return import(pathToFileURL(file).href);
}

function validateState(state) {
	if (!state || state.version !== 1 || typeof state.allowBackgroundUse !== "boolean") throw failure("storage");
	if (state.connectionId !== undefined && !(typeof state.connectionId === "string" && UUID.test(state.connectionId))) throw failure("storage");
	if (state.email !== undefined && typeof state.email !== "string") throw failure("storage");
	return state;
}
/** One owner-only JSON file. No secrets inside: connection id, consent and the probed account email. */
function fileStore(file) {
	return {
		async read() {
			try { return validateState(JSON.parse(await fs.readFile(file, "utf8"))); }
			catch (error) { if (error.code === "ENOENT") return { version: 1, allowBackgroundUse: true }; throw failure("storage"); }
		},
		async write(state) {
			validateState(state);
			const temporary = `${file}.${randomUUID()}.tmp`;
			try {
				await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
				await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
				await fs.rename(temporary, file);
			} catch { await fs.unlink(temporary).catch(() => {}); throw failure("storage"); }
		},
	};
}

/** Probe the local login without sending a model request (never-yielding prompt). */
async function probeClaudeCode(sdk, { cwd, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), timeoutMs);
	try {
		if (cwd) await fs.mkdir(cwd, { recursive: true });
		const q = sdk.query({
			prompt: (async function* () { await new Promise((resolve) => abort.signal.addEventListener("abort", resolve, { once: true })); })(),
			options: {
				abortController: abort, persistSession: false, settingSources: [], strictMcpConfig: true, mcpServers: {}, tools: [],
				settings: { disableAllHooks: true }, env: claudeCodeEnv(), stderr: () => {}, ...(cwd ? { cwd } : {}),
			},
		});
		const timeout = new Promise((_, reject) => abort.signal.addEventListener("abort", () => reject(failure("probe")), { once: true }));
		const [account, models] = await Promise.race([Promise.all([q.accountInfo(), q.supportedModels()]), timeout]);
		const signedIn = account?.apiProvider === "firstParty" && typeof account.email === "string" && !!account.email && typeof account.subscriptionType === "string" && !!account.subscriptionType;
		return {
			signedIn,
			email: signedIn ? account.email : null,
			subscriptionType: signedIn ? account.subscriptionType : null,
			models: (Array.isArray(models) ? models : []).filter((m) => m && typeof m.value === "string").map((m) => ({
				value: m.value, displayName: String(m.displayName ?? m.value),
				...(typeof m.resolvedModel === "string" ? { resolvedModel: m.resolvedModel } : {}),
				...(Array.isArray(m.supportedEffortLevels) ? { supportedEffortLevels: m.supportedEffortLevels.filter((l) => typeof l === "string") } : {}),
			})),
		};
	} finally { clearTimeout(timer); abort.abort(); }
}

function createClaudeCode(options) {
	const store = options.store ?? fileStore(path.join(options.directory, "claude-code-connection.json"));
	const probe = options.probe ?? ((sdk) => probeClaudeCode(sdk, { cwd: options.cwd }));
	let sdk, closed = false, paused = false, fatal = false, ready = false;
	let state = { version: 1, allowBackgroundUse: true };
	let account = { signedIn: false, email: null, subscriptionType: null, models: [] };
	let epoch = 0, authorityRevision = 0, revision = 0, checking = 0, error, tail = Promise.resolve();
	const serialized = (fn) => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
	function statusNow() {
		const available = ready && !fatal && !closed && !paused;
		return {
			available, connected: !!(available && state.connectionId && account.signedIn), checking: checking > 0,
			signedIn: account.signedIn, email: account.email, subscriptionType: account.subscriptionType,
			allowBackgroundUse: state.allowBackgroundUse, connectionId: state.connectionId ?? null,
			epoch, authorityRevision, revision, ...(error ? { error } : {}),
		};
	}
	function snapshotNow() { const status = statusNow(); return { status, models: status.connected ? JSON.parse(JSON.stringify(account.models)) : [] }; }
	function changed() { revision++; try { options.onChange?.(snapshotNow()); } catch { /* observer isolation */ } }
	async function save(next) {
		try { await store.write(next); } catch { fatal = true; epoch++; error = MESSAGES.storage; changed(); throw failure("storage"); }
		state = next;
	}
	async function check() {
		if (!ready || fatal || closed || paused) throw failure("unavailable");
		checking++; changed();
		try {
			const next = await probe(sdk);
			if (account.email !== next.email || account.signedIn !== next.signedIn) epoch++;
			if (JSON.stringify(account.models) !== JSON.stringify(next.models)) authorityRevision++;
			account = next;
			error = next.signedIn ? undefined : MESSAGES.signedOut;
			if (next.signedIn && state.connectionId && state.email !== next.email) await save({ ...state, email: next.email });
		} catch (cause) {
			if (cause?.code === "storage") throw cause;
			if (account.signedIn) epoch++;
			account = { signedIn: false, email: null, subscriptionType: null, models: [] };
			error = MESSAGES.probe;
			throw failure("probe");
		} finally { checking--; changed(); }
	}
	const started = (async () => {
		try { sdk = options.sdk ?? await options.loadSDK(); state = await store.read(); ready = true; }
		catch { fatal = true; error = MESSAGES.unavailable; changed(); return; }
		changed();
		await serialized(check).catch(() => {});
	})();
	return {
		ready: started,
		async status() { await started; return statusNow(); },
		async snapshot() { await started; return snapshotNow(); },
		check: () => serialized(check),
		connect: (enabled) => serialized(async () => {
			if (enabled !== undefined && typeof enabled !== "boolean") throw failure("unavailable");
			await check();
			if (!account.signedIn) throw failure("signedOut");
			epoch++;
			await save({ version: 1, allowBackgroundUse: enabled ?? state.allowBackgroundUse, connectionId: randomUUID(), email: account.email });
			changed();
		}),
		consent: (enabled) => serialized(async () => {
			if (typeof enabled !== "boolean" || !ready || fatal || closed || paused) throw failure("unavailable");
			if (state.allowBackgroundUse !== enabled) { await save({ ...state, allowBackgroundUse: enabled }); changed(); }
		}),
		disconnect: () => serialized(async () => {
			if (!ready || fatal) throw failure("unavailable");
			epoch++;
			await save({ version: 1, allowBackgroundUse: true });
			changed();
		}),
		pause() { paused = true; epoch++; changed(); },
		resume() { if (closed) return; paused = false; changed(); },
		close() { closed = true; epoch++; changed(); },
	};
}

function publicError(error) {
	return MESSAGES[error?.code] ?? MESSAGES.unavailable;
}

/** Renderer/web controls. No token, URL or credential operation exists. */
async function claudeCodeControl(command, owner) {
	try {
		if (!owner || !command || typeof command !== "object") throw failure("unavailable");
		switch (command.op) {
			case "status": return await owner.status();
			case "connect": return await owner.connect(command.enabled);
			case "check": return await owner.check();
			case "consent": return await owner.consent(command.enabled);
			case "disconnect": return await owner.disconnect();
			default: throw failure("unavailable");
		}
	} catch (error) { throw new Error(publicError(error)); }
}

/** Server child IPC: the child asks for snapshots; main pushes changes. */
function attachClaudeCodeChild(child, owner) {
	let disposed = false;
	const send = (packet) => { if (!disposed && child.connected) { try { child.send(packet, () => {}); } catch { /* child exited */ } } };
	const listener = async (message) => {
		if (disposed || !child.connected || message?.channel !== "lh:claude-code" || typeof message.id !== "string") return;
		const { id, op } = message;
		try {
			if (!owner || op !== "snapshot") throw failure("unavailable");
			send({ channel: "lh:claude-code", id, op, ok: true, value: await owner.snapshot() });
		} catch (error) { send({ channel: "lh:claude-code", id, op, ok: false, error: publicError(error) }); }
	};
	child.on("message", listener);
	return {
		send(snapshot) { send({ channel: "lh:claude-code", op: "changed", snapshot }); },
		dispose() { disposed = true; child.removeListener("message", listener); },
	};
}

module.exports = { createClaudeCode, claudeCodeControl, attachClaudeCodeChild, loadClaudeCodeSDK, probeClaudeCode, claudeCodeEnv, fileStore, publicError, STRIPPED_ENV, MESSAGES };
