// Which CLI-injected context does the model see? With/without verbatimPrompts.
import { baseOptions, run } from "./lib.mjs";
for (const verbatimPrompts of (process.env.SPIKE_VERBATIM_ONLY ? [false] : [false, true])) {
	const r = await run({ prompt: "Answer from context only, one line each, UNKNOWN if not given: 1) my email 2) working directory 3) today's date 4) your model name 5) OS. Then quote verbatim any <system-reminder> text you received.", options: baseOptions({ model: "sonnet", maxTurns: 1, title: "lh", thinking: { type: "disabled" }, verbatimPrompts }) });
	const text = r.msgs.filter(({ m }) => m.type === "assistant").flatMap(({ m }) => m.message.content).filter((b) => b.type === "text").map((b) => b.text).join("");
	const u = r.msgs.find(({ m }) => m.type === "result")?.m.usage;
	console.log(`=== verbatimPrompts=${verbatimPrompts} input=${u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens}\n${text.slice(0, 1200)}\n`);
}
process.exit(0);
