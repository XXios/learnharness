import { baseOptions, makeToolServer, run } from "./lib.mjs";
const r = await run({ prompt: "Call get_weather for Paris.", options: baseOptions({ model: "haiku", maxTurns: 1, title: "lh", persistSession: true, cwd: "/tmp/lh-cc-fmt", mcpServers: { lh: makeToolServer() }, canUseTool: async () => ({ behavior: "deny", message: "captured by host" }) }) });
console.log(r.msgs.find(({ m }) => m.type === "result")?.m.session_id);
process.exit(0);
