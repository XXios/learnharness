/** pi tool schemas → an in-process MCP server Claude Code can see. The handlers
 * never run in normal flow (capture-and-stop denies every call) and fail
 * loudly if they ever do. */
import type { Tool } from "@earendil-works/pi-ai";
import { z } from "zod";

export const CLAUDE_CODE_MCP_SERVER = "lh";
const PREFIX = `mcp__${CLAUDE_CODE_MCP_SERVER}__`;

/** Claude Code names MCP tools mcp__<server>__<name>; pi sees the bare name. */
export function appToolName(name: string): string { return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name; }

type SDK = typeof import("@anthropic-ai/claude-agent-sdk");
export function claudeCodeToolServer(sdk: Pick<SDK, "createSdkMcpServer" | "tool">, tools: readonly Tool[]) {
	const declared = tools.map((tool) => {
		const schema = z.fromJSONSchema(JSON.parse(JSON.stringify(tool.parameters ?? { type: "object", properties: {} })));
		const shape = (schema as unknown as { shape?: Record<string, z.ZodType> }).shape;
		if (!shape) throw new Error(`Tool ${tool.name} has no object parameters`);
		return sdk.tool(tool.name, tool.description, shape, async () => {
			throw new Error(`LearnHarness tool ${tool.name} must be executed by the app, not by Claude Code`);
		}, { alwaysLoad: true });
	});
	return sdk.createSdkMcpServer({ name: CLAUDE_CODE_MCP_SERVER, version: "1.0.0", tools: declared, alwaysLoad: true });
}
