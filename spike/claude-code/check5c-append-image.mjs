// Check 5c: append-only format with an image inside a prior user turn + recall of prior tool results.
import { Resvg } from "@resvg/resvg-js";
import { baseOptions, makeToolServer, run, userMessages } from "./lib.mjs";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="white"/><polygon points="20,100 60,20 100,100" fill="#1e5bd8"/><text x="115" y="75" font-size="40" font-family="Arial" fill="black">K7</text></svg>`;
const data = new Resvg(svg).render().asPng().toString("base64");
const blocks = [
	{ type: "text", text: "<user>\nMy name is Ada. Here is a picture I drew:" },
	{ type: "image", source: { type: "base64", media_type: "image/png", data } },
	{ type: "text", text: "Also get the weather in Paris.\n</user>" },
	{ type: "text", text: '<assistant>\nNice drawing! Checking Paris.\n<tool_call id="t1" name="get_weather">{"city":"Paris"}</tool_call>\n</assistant>' },
	{ type: "text", text: '<tool>\n<tool_result id="t1">Paris: 17°C, light rain. Station code ZEBRA-42.</tool_result>\n</tool>' },
	{ type: "text", text: "<assistant>\nParis is 17°C with light rain.\n</assistant>" },
	{ type: "text", text: "<user>\nOne line each: my name, the Paris station code, the shape+color in my picture, the text in it.\n</user>" },
];
const system = "You are a concise test assistant inside LearnHarness. The user message is the conversation so far as <user>, <assistant> and <tool> turns. Continue as the assistant from the last turn: answer the last <user> turn, or continue after the last <tool> results. Make tool calls only with your real tools, never as text, and do not wrap your reply in tags.";
for (const model of ["haiku", "sonnet"]) {
	const r = await run({ prompt: userMessages([blocks]), options: baseOptions({ model, systemPrompt: system, maxTurns: 1, title: "lh", thinking: { type: "disabled" }, mcpServers: { lh: makeToolServer() }, canUseTool: async () => ({ behavior: "deny", message: "captured" }) }) });
	const out = r.msgs.filter(({ m }) => m.type === "assistant").flatMap(({ m }) => m.message.content).map((b) => (b.type === "text" ? b.text : `[${b.type}${b.name ? ":" + b.name : ""}]`)).join(" ");
	console.log(model, "=>", JSON.stringify(out));
}
process.exit(0);
