/** Fork feature: web/dev owner for the Claude connection (desktop uses the
 * Electron main owner). Hosts the same electron/claude-code.cjs module in the
 * server process; no credential ever enters app JS (Claude Code keeps its login). */
import path from "node:path";
import { AUTH_FILE, PATHS } from "../../config.ts";
import { createClaudeCode, claudeCodeControl } from "../../electron/claude-code.cjs";
import { emit } from "../core/events.ts";
import type { ClaudeCodeSnapshot } from "../core/contracts/claude-code.ts";
import { publishWebSubscriptionPacket, webSubscriptionsEnabled } from "../agent/subscription-runtime.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

type Owner = ReturnType<typeof createClaudeCode>;
const KEY = Symbol.for("lh.claudeCode.webOwner");
function owner(): Owner {
	if (!webSubscriptionsEnabled()) throw new Error("Web Claude controls are unavailable in desktop-owned mode.");
	const global = globalThis as typeof globalThis & { [KEY]?: Owner };
	if (!global[KEY]) {
		global[KEY] = createClaudeCode({
			directory: path.dirname(AUTH_FILE),
			cwd: path.join(PATHS.data, "claude-code-workdir"),
			loadSDK: () => import("@anthropic-ai/claude-agent-sdk"),
			onChange: (snapshot: ClaudeCodeSnapshot) => {
				publishWebSubscriptionPacket("lh:claude-code", { channel: "lh:claude-code", op: "changed", snapshot });
				emit("subscriptions-changed", {});
			},
		});
		const created = global[KEY]!;
		process.once("exit", () => created.close());
	}
	return global[KEY]!;
}

/** Private runtime call from the agent bridge (no HTTP exposure). */
export async function claudeCodeWebRequest(op: string): Promise<ClaudeCodeSnapshot> {
	if (op !== "snapshot") throw new Error("Invalid private operation.");
	return owner().snapshot();
}

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const error = (message: string, status: number) => Response.json({ error: message }, { status, headers: HEADERS });
/** Same-origin browser controls, mirroring the other subscription routes' trust model. */
function authorized(request: Request): boolean {
	const origin = subscriptionRequestOrigin(request);
	if (!origin || request.headers.get("x-learnharness-subscriptions") !== "1") return false;
	if (request.headers.get("sec-fetch-site") === "cross-site") return false;
	const supplied = request.headers.get("origin");
	return request.method === "GET" ? !supplied || supplied === origin : supplied === origin;
}
export async function claudeCodeControlsResponse(request: Request): Promise<Response> {
	if (!webSubscriptionsEnabled()) return error("Web Claude controls are unavailable in desktop-owned mode.", 404);
	if (!authorized(request)) return error("Claude controls require a same-origin LearnHarness request.", 403);
	try {
		if (request.method === "GET") return Response.json(await owner().status(), { headers: HEADERS });
		if (request.method !== "POST") return error("Unsupported method.", 405);
		if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return error("Expected JSON.", 415);
		const text = await request.text();
		if (text.length > 4096) return error("Request too large.", 413);
		const command: unknown = JSON.parse(text);
		if (!command || typeof command !== "object" || Array.isArray(command)) return error("Invalid command.", 400);
		const op = (command as { op?: unknown }).op;
		if (typeof op !== "string" || !["connect", "check", "consent", "disconnect"].includes(op)) return error("Unsupported control.", 400);
		await claudeCodeControl(command, owner());
		return Response.json({ status: await owner().status() }, { headers: HEADERS });
	} catch (cause) {
		return error(cause instanceof Error ? cause.message : "The Claude connection could not be changed.", 400);
	}
}
