// Check 3b: does the prompt cache hit across separately spawned calls?
import { baseOptions, run } from "./lib.mjs";
import { mkdirSync } from "node:fs";
const fixedCwd = process.env.SPIKE_FIXED_CWD;
if (fixedCwd) mkdirSync(fixedCwd, { recursive: true });
const big = "You are a tutor. " + Array.from({ length: 400 }, (_, i) => `Rule ${i}: be precise and kind to learners.`).join(" ");
for (let i = 0; i < 3; i++) {
	const r = await run({ prompt: "Say ok.", options: baseOptions({ model: process.argv[2] ?? "sonnet", maxTurns: 1, title: "lh", thinking: { type: "disabled" }, systemPrompt: big, ...(fixedCwd ? { cwd: fixedCwd } : {}) }) });
	const u = r.msgs.find(({ m }) => m.type === "result")?.m.usage;
	console.log(JSON.stringify({ fixedCwd: Boolean(fixedCwd), i, in: u.input_tokens, cacheCreate: u.cache_creation_input_tokens, cacheRead: u.cache_read_input_tokens }));
}
process.exit(0);
