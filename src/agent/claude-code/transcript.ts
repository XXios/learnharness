/** pi transcript → one Claude Code user message (Phase 0 spike result #5):
 * append-only tagged text, one block per pi message, images in place, nothing
 * after the last turn. Call N's blocks are an exact prefix of call N+1's, so
 * the prompt cache reuses the history. The framing goes into the system prompt. */
import type { Message } from "@earendil-works/pi-ai";

export const TRANSCRIPT_FRAMING = [
	"## Conversation format",
	"The user message holds the conversation so far as <user>, <assistant> and <tool> turns, oldest first.",
	"Continue as the assistant from the last turn: answer the last <user> turn, or continue after the last <tool> results.",
	"Call tools only with your real tools, never by writing tool calls as text, and do not wrap your reply in tags.",
].join("\n");

export type ClaudeCodeContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } };
type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const MEDIA_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const attr = (value: string) => value.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", "\"": "&quot;", "<": "&lt;", ">": "&gt;" })[c]!);

/** Mutable builder: consecutive text merges into one block; images split blocks. */
class Blocks {
	readonly out: ClaudeCodeContentBlock[] = [];
	text(value: string) {
		const last = this.out.at(-1);
		if (last?.type === "text") last.text += value;
		else this.out.push({ type: "text", text: value });
	}
	image(data: string, mimeType: string) {
		if (MEDIA_TYPES.includes(mimeType)) this.out.push({ type: "image", source: { type: "base64", media_type: mimeType as ImageMediaType, data } });
		else this.text(`[image omitted: unsupported type ${mimeType}]`);
	}
}

function messageBlocks(message: Message): ClaudeCodeContentBlock[] {
	const b = new Blocks();
	if (message.role === "user") {
		b.text("<user>\n");
		if (typeof message.content === "string") b.text(message.content);
		else for (const part of message.content) part.type === "text" ? b.text(part.text) : b.image(part.data, part.mimeType);
		b.text("\n</user>");
	} else if (message.role === "assistant") {
		b.text("<assistant>\n");
		const parts: string[] = [];
		for (const part of message.content) {
			if (part.type === "text" && part.text) parts.push(part.text);
			else if (part.type === "toolCall") parts.push(`<tool_call id="${attr(part.id)}" name="${attr(part.name)}">${JSON.stringify(part.arguments ?? {})}</tool_call>`);
			// Thinking stays private to the turn that produced it.
		}
		b.text(parts.join("\n"));
		b.text("\n</assistant>");
	} else if (message.role === "toolResult") {
		b.text(`<tool>\n<tool_result id="${attr(message.toolCallId)}" name="${attr(message.toolName)}"${message.isError ? " error=\"true\"" : ""}>`);
		for (const part of message.content) part.type === "text" ? b.text(part.text) : b.image(part.data, part.mimeType);
		b.text("</tool_result>\n</tool>");
	}
	return b.out;
}

/** System messages are excluded (the caller folds them into the system prompt). */
export function serializeTranscript(messages: readonly Message[]): ClaudeCodeContentBlock[] {
	return messages.filter((m) => m.role !== "system").flatMap(messageBlocks);
}
