# Fork plan: Claude subscription provider via local Claude Code

Status: **approved plan, not yet implemented** (planned 2026-10-26). Fork-only document (`XXios/learnharness`). Upstream is `amosblomqvist/learnharness`; at planning time the fork was identical to upstream `v0.3.8` (`3dc8847`).

## Goal

The learner can pick their **Claude Pro/Max subscription** as a model provider in LearnHarness, while the fork keeps merging every upstream release with minimal conflicts.

## Approved decisions (do not re-litigate)

| # | Decision | Rejected alternative + why |
|---|---|---|
| D1 | **Route B (the t3code approach):** drive the user's locally installed, signed-in Claude Code through `@anthropic-ai/claude-agent-sdk`. | Route A: pi-ai 1.4.0's built-in `anthropic` OAuth (`providers/anthropic` → `auth/oauth/anthropic.js`). It impersonates Claude Code (fake system-prompt prefix, `claude-code-20250219`/`oauth-2025-04-20` betas, renames tools to Claude Code names; `dist/api/anthropic-messages.js` calls this "Stealth mode"). That violates Anthropic's consumer terms for third-party apps, can be blocked at any time, and risks the account. |
| D2 | **B1: Claude Code sits behind `PiEngine.streamFn` as "just the model".** pi-agent-core keeps the agent loop and executes all tools. | B2: Claude Code runs the loop (as t3code does). That would be a second agent engine next to pi: a large diff and constant upstream conflicts. |
| D3 | The SDK is a **root `package.json` dependency**. Lockfile conflicts are resolved mechanically by `scripts/fork-sync.sh`. | An isolated fork package would need loader changes in upstream-owned `next.config.ts`/`scripts/build-server.mjs`. Spawning the raw CLI would mean reimplementing the protocol. Note: the SDK is proprietary ("© Anthropic PBC"); bundling it into an AGPL build is fine for personal builds and must be revisited before any public distribution. |
| D4 | **Connect = detect + instruct.** The app never handles Claude tokens. It probes the local Claude Code login (SDK `accountInfo()`: email, `subscriptionType`, `tokenSource`). If not signed in, it shows "run `claude`, then `/login` in a terminal" plus **Check again**. | The app driving the CLI's interactive login, or no connect step at all. |
| D5 | **Scope: desktop (dev + packaged) and web/dev parity**, like the existing subscriptions. | Web-only first. |
| D6 | First land a **neutral refactor that makes the subscription-provider list data-driven**, offered as a **PR to upstream**. The fork carries it until merged. | Fork-only refactor (permanent conflicts); skipping it (a scattered fork diff). |
| D7 | **Desktop auto-update feed points to `XXios/learnharness` releases** in the fork. | Leaving it on upstream: installed fork builds would silently update to upstream builds *without* the feature (`electron-builder.yml` `publish` → `amosblomqvist`). |
| D8 | **Usage display is the same as the other subscriptions:** the label "Claude" goes in the subscription usage group with $0 API cost, and token counts are still recorded. | Estimated "equivalent API cost". |

Defaults that came with plan approval:
- The **background-use consent toggle** follows the existing native-subscription UX. It is stored in an app-owned file with **no credentials**.
- The model catalog comes from SDK `supportedModels()`, joined with pi-ai's `anthropic` catalog metadata (context window, reasoning levels).

**Process rule (AGENTS.md):** any design or implementation question not answered here → STOP and ask the user (one question per AskUserQuestion call). Never guess.

## Current architecture (what the plan plugs into)

- **The engine seam:** `src/agent/models.ts` → `piEngineForSpec(spec, background, lifecycle)` returns `PiEngine { model, streamFn, level }`. Every role (teacher, prober, practice, extraction, sub-agents) runs on it, and pi-agent-core owns the loop and executes tools. Today it branches `chatgpt` / native subscription / BYOK with ternaries (`models.ts:104`, `:122`).
- **Existing subscriptions:**
  - **ChatGPT:** a bespoke implementation (`electron/chatgpt.cjs`, `src/agent/chatgpt-*.ts`).
  - **"Native" (GitHub Copilot, Grok):** pi-ai OAuth.
    - Main-process owner: `electron/subscriptions.cjs`, `electron/subscription-store.cjs`, `electron/subscription-ipc.cjs`.
    - Server bridge: `src/agent/subscription-bridge.ts`, `subscription-stream.ts`.
    - Web/dev owner: `src/server/web-subscriptions.ts`, `web-subscription-http.ts`, `app/api/subscriptions/*`.
    - UI: `components/settings/subscription-connections.tsx`, `subscription-client.ts`.
- **Admission/lifecycle contract** that any subscription stream must honor (`src/agent/subscription-request-cycle.ts`):
  - `AdmissionScope { accountId, epoch, authorityRevision, selectedModelId }`
  - `SubscriptionDispatchLifecycle` (`captured` / `beforeDispatch` / `noDispatch`), `markUnadmittedUsage`
  - Consumers: `src/server/chat-handler.ts` (`SubscriptionRequestCycle`, lines ~214, 244, 321, 379, 511) and `src/server/jobs.ts:622` (automatic follow-up gating).
- **Hardcoded provider dispatch (the refactor targets):**
  - `src/agent/subscription-connections.ts`: every function branches `chatgpt` vs native.
  - `src/agent/models.ts:104,122`
  - `src/server/model-catalog.ts:29,34,36,143-144,191,207`
  - `src/server/keys.ts:204`
  - `src/server/web-subscription-http.ts:49-50`
  - `src/server/web-subscriptions.ts:31-37,68-78` (SDK loading + chatgpt branches)
  - `electron/subscriptions.cjs:8,36,41-46,85,102` (copilot/xai ternaries)
  - `electron/subscription-store.cjs:6`
  - `src/core/contracts/subscriptions.ts` (`NATIVE_SUBSCRIPTIONS`; also used by the pure core: `src/core/prices.ts:19-25`, `cost-summary.ts` for usage labels)
  - `scripts/smoke-provider-runtime.mjs:108`, `scripts/smoke-web-subscriptions.mjs:63-84`
- **Layer law** (`docs/architecture.md` §2, enforced by eslint): `components/` imports only `@/src/core`; `src/agent` never imports `server`/`store`; `src/core` is pure. The provider *descriptor data* (id, label) therefore lives in core; runtime behavior lives in agent/server/electron.
- **Build:** `next.config.ts` `serverExternalPackages` (line ~104), `scripts/build-server.mjs` (standalone desktop server), `electron-builder.yml` (asar/asarUnpack, signing, `publish`).

## Phase 0: spike (throwaway branch, real Claude login, nothing merged)

Goal: prove the B1 mechanics before writing production code. Write the findings into a `## Spike results` section of this file.

Build a minimal Node script that does an SDK `query()` with:
- `tools: []` (no built-in tools)
- `systemPrompt: "<custom string>"`
- `settingSources: []`, `strictMcpConfig: true`, `settings: { disableAllHooks: true }`, `persistSession: false`
- an empty temp `cwd`
- `env` = `{ ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_AUTO_CONNECT_IDE: "0", CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1", CLAUDE_AGENT_SDK_CLIENT_APP: "learnharness/<version>" }`
- `includePartialMessages: true`
- `mcpServers: { lh: createSdkMcpServer({ tools: [...] }) }` declaring 2–3 fake app tools

The t3code reference for these options is `apps/server/src/provider/ClaudeProvider.ts` (`buildClaudeCapabilitiesProbeQueryOptions`) and `orchestration-v2/Adapters/ClaudeAdapterV2.ts`.

Verify and record:
1. **Capture and stop:** when the model emits tool_use blocks (including **parallel** ones), we get the complete assistant message with all blocks, and **no tool handler executes**. Candidate mechanisms: `canUseTool` deny + `interrupt()`, `maxTurns: 1`, abort. Record exactly which one works and what the SDK emits.
2. **Streaming:** text and thinking deltas arrive through partial messages, and thinking level maps to `effort` / `thinking`.
3. **Usage:** input/output/cache token counts are available per call.
4. **Latency:** time to first token and total time per call (spawn overhead). The go/no-go threshold is agreed with the user before Phase 2.
5. **History:** a serialized multi-turn transcript (user/assistant text, prior tool calls + results, images) works as `prompt` (a string or an `AsyncIterable<SDKUserMessage>`; the SDK only accepts *user* messages). Pick the serialization format.
6. **Auth probe:** `accountInfo()` / init result distinguishes signed-in subscription, API key and signed-out, and works without a TTY.
7. **Desktop:** from Electron main *and* the standalone server child, the SDK finds the user's login (macOS Keychain). The SDK's per-platform native binary (`@anthropic-ai/claude-agent-sdk-darwin-arm64`) can be `asarUnpack`ed and signed.

**If 1, 4 or 7 fails → stop and report to the user before continuing.**

## Spike results

Run 2026-10-26 on branch `spike/claude-code` (throwaway, uncommitted). Environment: `@anthropic-ai/claude-agent-sdk` **0.3.310** (pinned, root `package.json`; it pulls in the peer `@modelcontextprotocol/sdk` 1.32.2, while `zod` 4.4.3 and `@anthropic-ai/sdk` 0.129.0 were already present), bundled CLI 2.1.310, Node 25.6.1, Electron 44.9.3, macOS 26 arm64. Real login: Claude Pro. Scripts: `spike/claude-code/*.mjs`. Models: `haiku` = claude-haiku-5-5, `sonnet` = claude-sonnet-5-5, `opus` = claude-opus-5-5.

Base recipe as planned, plus `title: "<anything>"` (see #3). Fake app tools were declared from **JSON Schema** via `tool(name, desc, z.fromJSONSchema(schema).shape, handler)`. Every handler logs loudly if it runs, and none ever ran.

| # | Check | Result |
|---|---|---|
| 1 | Capture and stop | **PASS**: `maxTurns: 1` + `canUseTool` → deny |
| 2 | Streaming + thinking/effort | **PASS**: needs `display: "summarized"` |
| 3 | Usage | **PASS** |
| 4 | Latency | **Measured, threshold not yet agreed.** ~0.6 s cold spawn overhead, ~0.02 s pre-warmed |
| 5 | History | **PASS**: append-only tagged text format |
| 6 | Auth probe | **PASS** |
| 7 | Desktop (Electron main + server child, Keychain, signing) | **PASS** for runtime and signing; the packaging path differs from the plan (see #7) |

### 1. Capture and stop: PASS

**Mechanism that works:** `maxTurns: 1` plus `canUseTool: async () => ({ behavior: "deny", message: "…" })` (no `interrupt`).
- Without `canUseTool` the CLI also auto-denies, because the session has no approval surface. The explicit deny is the backstop.
- The CLI makes exactly one API call. All `tool_use` blocks of that message are emitted, then it stops with `result.subtype = "error_max_turns"` and `stop_reason: "tool_use"`, 6–12 ms after `message_stop`.
- Verified:
  - haiku: 3 parallel calls
  - sonnet and opus: leading text + 3 parallel calls, including `save_note` with array/enum args
  - Electron main: 2 parallel calls
- In every run: handler executions = 0 and no second API call.

**What the SDK emits:**
- One `SDKAssistantMessage` frame **per content block**. Frames of one message share `message.id`, and **`stop_reason` is `null` on every frame**. The real stop reason is only in `stream_event` `message_delta`.
- Tool names arrive as `mcp__<server>__<name>` (e.g. `mcp__lh__get_weather`).
- The CLI also emits a synthetic `user` frame with a denied `tool_result` per call. These must be ignored.
- The SDK iterator **throws** `"Reached maximum number of turns (1)"` after yielding that result. The adapter must treat `error_max_turns` + `stop_reason: "tool_use"` as normal completion.

**Mechanisms that fail:**
- **`canUseTool` deny + `interrupt: true`:** loses parallel calls. Claude Code executes tools *while streaming*: the permission check for tool #1 fires before tool #2 has streamed, so the interrupt truncates the message. Only 1 of 3 calls was captured.
- **Deny without `maxTurns`, or `interrupt()` on `message_delta stop=tool_use`:** a second API call is made with the denied results.
- **`abort()` on stop:** the process ends only after a ~2 s graceful-exit window, and the CLI made a second API call within it.

**Working fallback:** `canUseTool` returns a promise that stays pending until `message_stop`, then `interrupt()`. All 3 calls are captured with 1 API call, but the result is an `error_during_execution`.

### 2. Streaming and thinking: PASS

**Text:** `stream_event` `content_block_delta` / `text_delta`.

**Thinking:**
- Thinking text streams as `thinking_delta` (plus one `signature_delta`) **only with `thinking: { type: "adaptive", display: "summarized" }`**.
- With the default display (or `"omitted"`), thinking blocks arrive signed but empty: 2 deltas, 0 characters.
- The CLI also emits `system/thinking_tokens` progress frames.

**Effort:** `effort` is passed through and works. Sonnet, same prompt, `display: "summarized"`:

| Setting | Thinking tokens |
|---|---|
| `effort: "low"` | 0 |
| `effort: "high"` | 0–82 (adaptive, model decides) |
| `effort: "max"` | 232 (334 summarized characters) |

Other thinking settings:
- `thinking: { type: "disabled" }`: no thinking on Sonnet. Haiku once still emitted a thinking block.
- `{ type: "enabled", budgetTokens }`: no thinking at all on Sonnet 5.5, so it is effectively ignored.

**Level mapping:** pi levels are `off|minimal|low|medium|high|xhigh|max`; the SDK has `disabled` + `low|medium|high|xhigh|max`. The exact mapping (especially `minimal`) is a Phase 2 question.

### 3. Usage: PASS

**Per call:**
- `message_start.usage` and the final `message_delta.usage` carry `input_tokens`, `cache_creation_input_tokens` (split into 5m/1h), `cache_read_input_tokens`, `output_tokens` and `output_tokens_details.thinking_tokens`.
- The `result` repeats these in `usage`, and gives per-model totals in `modelUsage`.

**Hidden extra call:** every query by default made an **extra Haiku call** (~1.2k input tokens), which is session-title generation. Passing `title` removes it (so does `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`). The recipe should always set `title`.

**Prompt cache across separately spawned calls:**
- The system prompt + tools prefix is cached with a 1 h TTL.
- With a fresh temp `cwd` per call, ~369 tokens are re-written each time, because the cwd is in the CLI's environment block.
- With a **stable `cwd`** the prefix is fully read from cache (6,947 read / 0 written).

### 4. Latency: measured. Go/no-go needs your threshold

Trivial prompt, 3 MCP tools, thinking off, medians:

| Mode | Model | Spawn→init | First token | API TTFT | Overhead (first token − API TTFT) |
|---|---|---|---|---|---|
| cold `query()` per call (bundled binary) | haiku ×6 | 593 ms | 2,033 ms | 1,321 ms | **576 ms** |
| cold `query()` per call (user's `claude` 2.1.310) | haiku ×6 | 600 ms | 1,988 ms | 1,395 ms | 585 ms |
| cold `query()` per call | sonnet ×4 | 613 ms | 2,150 ms | 1,548 ms | **602 ms** |
| pre-warmed `startup()` then `.query()` | haiku ×6 | (545 ms, ahead of time) | 1,293 ms | 1,269 ms | **24 ms** |
| pre-warmed `startup()` then `.query()` | sonnet ×4 | (567 ms, ahead of time) | 1,541 ms | 1,524 ms | **21 ms** |

Notes:
- The very first probe after install took 4.2 s (cold disk). After that, probes took 0.5–0.7 s.
- **Abort:** after `abortController.abort()` the SDK keeps yielding deltas for ~2.0 s (98–104 deltas) before the child is killed. With `maxTurns: 1` no extra API call happens. The adapter must stop forwarding on its own signal immediately.

### 5. History: PASS. Chosen format: append-only tagged text

The prompt is one `SDKUserMessage` whose content is **one text block per pi turn**:
- `<user>…</user>`
- `<assistant>…<tool_call id="…" name="…">{json}</tool_call></assistant>`
- `<tool><tool_result id="…">…</tool_result></tool>`
- Images stay as `image` blocks at their position.
- **Nothing comes after the last turn.**

The framing instruction ("continue as the assistant from the last turn, make tool calls only with real tools") goes into the system prompt.

**Verified:**
- A real 3-call pi-style loop on haiku, sonnet and opus:
  1. Call 1 captures 2 parallel calls.
  2. The host appends ~4.5k-token results.
  3. Call 2 answers from them without re-calling.
  4. Call 3 recalls the name and the tool-result value.
- Image recall (shape, colour, text) in an earlier user turn: haiku and sonnet.
- Prompt cache works: call 3 read **9,790** cached tokens and wrote 556.

**Rejected alternatives:**
- **Wrapped text format** (`<conversation_history>…</conversation_history>` + trailing instruction): answers are correct, but there is **no history cache reuse**. Call 3 wrote 9,540 tokens and read only the 736-token prefix.
- **Synthetic resume** (`sessionStore.load()` + `resume` with Claude Code's internal JSONL entries):
  - It depends on an undocumented transcript schema.
  - When the live prompt was the tool results, the CLI treated the resumed tool calls as interrupted, and the model re-issued them.

### 6. Auth probe: PASS

**Mechanism:** t3code's pattern. `query()` with a never-yielding prompt, then `initializationResult()` / `accountInfo()` / `supportedModels()`. This sends no model request. Run with stdin = `/dev/null` (no TTY). It takes 0.5–0.7 s.

| State | `accountInfo()` |
|---|---|
| Signed in (real login) | `email`, `organization`, `subscriptionType: "Claude Pro"`, `apiProvider: "firstParty"` (no `tokenSource` field) |
| Signed out (simulated: empty `CLAUDE_CONFIG_DIR`) | `tokenSource: "none"`, no email/plan |
| API key only | `tokenSource: "none"`, `apiKeySource: "ANTHROPIC_API_KEY"` |
| API key + real login | `tokenSource: "claude.ai"`, `apiKeySource: "ANTHROPIC_API_KEY"`, no email/plan |

**API key wins over the login.** With `ANTHROPIC_API_KEY` set next to a real login, requests **use the API key**: a fake key failed with "Invalid API key · Fix external API key". That error arrives as a **synthetic assistant text message** (plus an error result), which the adapter must not show as model output.

`supportedModels()` returns aliases (`default`, `opus`, `sonnet`, `fable`, `haiku`, + dated IDs). Each has `resolvedModel`, `supportedEffortLevels` and `supportsAdaptiveThinking`.

### 7. Desktop: PASS for runtime and signing; packaging differs from the plan

**Runtime:**
- **Electron 44.9.3 main process** (CJS `import()` of the ESM SDK) reads the login from the Keychain and captures 2 parallel calls.
- **`ELECTRON_RUN_AS_NODE=1` child** (spawned exactly like `electron/main.cjs` spawns the server) does the same.
- Both also pass under a minimal launchd-like environment (`env -i HOME USER LOGNAME TMPDIR PATH=/usr/bin:/bin:/usr/sbin:/sbin`).

**Binary:**
- Only `@anthropic-ai/claude-agent-sdk-darwin-arm64` installs. It is a 274 MB Mach-O, signed by Anthropic (Team `Q6L2SF6YDW`, hardened runtime).
- Copies **re-signed ad-hoc** and **re-signed with the local Apple Development cert** both work under hardened runtime + `build/entitlements.mac.plist`. They read the Keychain login with **no prompt** and complete a query.
- Not tested: notarization, an actual `electron-builder` build.

**Packaging finding (deviates from the plan's assumption):**
- `asarUnpack` does not apply to the server path. The server ships via `extraResources` (`Resources/server/standalone`, outside the asar), so the SDK would live in the standalone server's `node_modules`.
- The SDK locates its binary with a computed `require.resolve(\`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude\`)`, which Next's file tracing will not follow. Phase 2 needs `serverExternalPackages` plus an explicit tracing include (or `pathToClaudeCodeExecutable`).
- The plan's `electron/claude-code.cjs` probe in **Electron main** would need the SDK inside the asar. The asar `files` allow-list currently excludes all of `node_modules`. Alternatively the probe runs in the server child.
- The DMG grows by ~274 MB.

### Findings that need a decision from the user (not decided here)

1. **`ANTHROPIC_API_KEY` precedence:** if it is in the environment, the "subscription" provider silently bills that API key. Options: strip auth-related env vars before spawning, refuse when `apiKeySource` is set, or leave it alone.
2. **Injected context:** the CLI always does the following, and neither `verbatimPrompts: true` nor `CLAUDE_CODE_DISABLE_ATTACHMENTS=1` removes it:
   - prepends "You are a Claude agent, built on Anthropic's Claude Agent SDK." to our system prompt;
   - adds per-turn reminders with the **account email**, cwd, date, model ID, OS and a token budget.
3. **Latency go/no-go threshold** and whether to pre-warm (`startup()`, one spare process per role config) to cut the ~0.6 s per-call overhead to ~0.02 s.
4. **Thinking-level mapping**, especially pi `minimal`.
5. **Binary source:** the bundled SDK binary (+274 MB, pinned) or the user's installed `claude` (`pathToClaudeCodeExecutable`; same latency, version drift).
6. **Where the desktop probe runs** (Electron main vs. the server child), given the asar layout.

### Post-spike decisions (user, 2026-10-26)

| # | Decision |
|---|---|
| S1 | **Strip** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` from the env passed to Claude Code, so it always uses the subscription login. |
| S2 | **Accept** Claude Code's injected context. The cwd is an empty, app-owned folder (stable, for caching). |
| S3 | ~0.6 s per-call overhead is fine. **Spawn per call, no pre-warm.** |
| S4 | Thinking: `off` → `thinking: disabled`; `minimal`/`low` → effort `low`; `medium`/`high`/`xhigh`/`max` → same-named effort; adaptive with `display: "summarized"`. |
| S5 | Use the **bundled SDK binary** (pinned). |
| S6 | Status/consent owner lives in **Electron main** (`electron/claude-code.cjs`). It loads the SDK from the bundled server's `node_modules` (the same `createRequire(serverDir)` route main already uses for pi-ai), so nothing goes into the asar. Web/dev hosts the same module in the server. |
| S7 | Local desktop builds are **ad-hoc signed, not notarized**. Build with `electron-builder --mac --arm64 -c.mac.identity=- -c.mac.notarize=false -c.mac.hardenedRuntime=false`. With hardened runtime left on, an ad-hoc app cannot launch: dyld refuses the Electron framework because of "different Team IDs" (verified 2026-10-26). |
| S8 | Replacing the installed app **keeps** `~/Library/Application Support/LearnHarness`. |

### Implementation status (2026-10-26, branch `feat/claude-code-subscription`, uncommitted)

**Phase 1 (neutral refactor) is implemented on the same branch.** It is not yet split out as an upstream PR.
- Core: `SUBSCRIPTION_PROVIDERS` descriptor list; `prices.ts` labels come from it.
- Agent registry: `src/agent/subscription-providers.ts` (interface + registry) and `src/agent/subscription-provider-list.ts` (composition point).
  - `subscription-connections.ts`, `models.ts`, `model-catalog.ts` and the `chat-handler.ts` error mapping now use the registry.
- Native table: `NATIVE_PROVIDERS` in `electron/subscription-store.cjs`.
  - **Deviation:** `web-subscriptions.ts` keeps its static `import()`s, because the bundler needs literal specifiers.
- UI list: `components/settings/subscription-ui.tsx` (`SUBSCRIPTION_UI`, `SubscriptionUIProviders`, `SubscriptionConnections`, `SubscriptionBackgroundAccess`).

**Phase 2 fork files:**
- `src/core/contracts/claude-code.ts`
- `electron/claude-code.cjs`: owner + probe + child IPC + control.
- `src/agent/claude-code/{bridge,catalog,transcript,tools,stream,register}.ts`
- `src/server/claude-code-web.ts` and `app/api/subscriptions/claude-code/route.ts`
- `components/settings/claude-code-connection.tsx`
- `tests/claude-code.test.ts`

**Registration lines in upstream-owned files:**
- `subscription-provider-list.ts`, `subscription-ui.tsx`
- the core descriptor list, `core/index.ts`
- `subscription-runtime.ts` (channel), `web-subscriptions.ts` (channel branch), `server/index.ts`
- `main.cjs`, `preload.cjs`, `sidebar.tsx` (`window.lh` type)
- `next.config.ts`, `build-server.mjs`, `.gitignore`
- `electron-builder.yml` (D7 owner)

## Phase 1: neutral refactor (upstream PR)

The branch is cut from upstream `main`, no Claude code. It must change no behavior, and existing tests must pass unchanged except for mechanical updates.

1. **Core descriptor list** in `src/core/contracts/subscriptions.ts`: a single exported list of subscription provider descriptors `{ logicalId, label }` (covering chatgpt + natives), which `prices.ts` / `cost-summary.ts` use for labels.
2. **Agent-layer registry:** a `SubscriptionProvider` interface plus a `registerSubscriptionProvider()` / lookup module in `src/agent/`. It covers:
   - `isProvider`, `connected`, `backgroundAllowed`, `scopeCurrent`, `onChange`
   - `model(id)`, `models()`, `refreshModels()`
   - `stream(purpose, lifecycle)`, `errorMessage(msg)`

   ChatGPT and the native subscriptions register through it. Then:
   - `subscription-connections.ts`, `models.ts:104/122`, `model-catalog.ts`, `keys.ts` and `chat-handler.ts` error mapping iterate the registry instead of using ternaries.
   - Registration happens at a composition point (exact location is decided in the PR; keep it to one line per provider).
3. **Native provider table:** in `electron/subscriptions.cjs`, `subscription-store.cjs` and `web-subscriptions.ts`, replace the copilot/xai ternaries with a per-provider descriptor table (SDK module + factory name, default base URL, endpoint validator).
4. **UI:** the Providers list renders from the descriptor list / registry, so a new provider adds a row without editing shared components.
5. Run lint, typecheck and tests. Open the PR to `amosblomqvist/learnharness` with a neutral description (no mention of Claude). Ask the user before opening it.

## Phase 2: fork feature (new files + registration lines)

Branch `feat/claude-code-subscription` on the fork, on top of Phase 1.

New files (names indicative; keep fork code here):
- `src/agent/claude-code/stream.ts`: a `StreamFunction` adapter that does the following.
  - Resolves admission (`AdmissionScope` with `accountId` = a local connection ID, plus epoch/authorityRevision bumped on login change).
  - Calls `lifecycle.captured` / `beforeDispatch` / `noDispatch` exactly like `subscription-stream.ts`.
  - Runs the Phase 0 query recipe.
  - Maps SDK partial events → pi `AssistantMessageEventStream` (text, thinking, toolCall, done/error).
  - Applies the capture-and-stop mechanism, so tool calls are returned to pi, never executed by Claude Code.
  - Never retries after dispatch, and honors abort and background denial.
- `src/agent/claude-code/transcript.ts`: pi `TranscriptContext` → SDK prompt serialization (format from Phase 0).
- `src/agent/claude-code/tools.ts`: pi tool schemas → `createSdkMcpServer` declarations (handlers never run in normal flow and fail loudly if they do).
- `src/agent/claude-code/catalog.ts`: `supportedModels()` ∩ pi-ai `anthropic` catalog metadata → `Model<Api>` with the logical provider id (e.g. `claude-code-subscription`).
- `src/agent/claude-code/register.ts`: registers the provider in the Phase 1 registry.
- Status/consent owner:
  - Desktop main process: `electron/claude-code.cjs` (probe via `accountInfo()`, background-consent file, change snapshots over the existing IPC pattern).
  - Web/dev: matching wiring in the web subscription owner.
  - State is `{ installed, signedIn, email, subscriptionType, allowBackgroundUse, connectionId, epoch }`, **no tokens**.
- `components/settings/claude-code-connection.tsx`: the Providers row with disclosure → Check status → signed-in (email, plan) / instructions ("run `claude`, then `/login`") + **Check again**, the background-use toggle, and Disconnect (it forgets the app-side connection and consent; it does not log the CLI out).
- `tests/claude-code-*.test.ts`: transcript serialization, event mapping, capture-and-stop, admission/background gating, catalog, UI row. These use an offline fake `query()`; no real network in tests.

Edits to upstream-owned files (keep each minimal):
- `package.json` / `package-lock.json`: add `@anthropic-ai/claude-agent-sdk`.
- Registry registration line(s) from Phase 1.
- `src/core` descriptor list: add `{ logicalId: "claude-code-subscription", label: "Claude" }` (D8 usage labels follow automatically).
- `next.config.ts` `serverExternalPackages`, `scripts/build-server.mjs`, `electron-builder.yml` `asarUnpack`: what the SDK and its native binary need (per the Phase 0 findings).
- `scripts/smoke-provider-runtime.mjs` / `smoke-web-subscriptions.mjs`: include the provider if feasible offline.

Done when:
- lint, typecheck and `npm test` are green.
- A live manual session (`/run`) completes the following with a Claude model from the subscription in both `npm run dev` and `npm run desktop:dev`:
  - probe → teacher plan → questions
  - a background job (with consent on, then denied with consent off)
- An unsigned packaged build works locally.

## Phase 3: fork upkeep

1. `git remote add upstream https://github.com/amosblomqvist/learnharness.git`, then `git config rerere.enabled true`.
2. `scripts/fork-sync.sh`:
   - `git fetch upstream` → `git merge upstream/main` on the fork's `main`.
   - On a `package-lock.json` conflict: take upstream's lockfile, then `npm install`.
   - Run lint, typecheck and tests, and stop on failure.
3. **D7:** in `electron-builder.yml`, set `publish.owner` to `XXios`. Check `electron/main.cjs` (~line 513–525, `setFeedURL`) for any hardcoded feed.
4. **Signing:** `desktop:dist` hardcodes upstream's notary profile (`LH_NOTARY`) and `APPLE_TEAM_ID=JS6XN22HY6`. The fork needs the user's own credentials or an unsigned local build. Ask the user which one.
5. After each upstream merge: rebuild and publish a fork release so installed builds update.

## Risks

- **Capture-and-stop may not be clean** (Phase 0 #1). If Claude Code always runs tools before yielding, B1 needs a different mechanism. Escalate to the user.
- **Per-call spawn latency** and the loss of cross-call prompt-cache fidelity with a serialized history.
- **Claude Code / SDK updates** can change protocol behavior. Pin the SDK version and cover the event mapping with tests.
- Anthropic's terms for using Claude Code from another app can change. Re-check before any public distribution (also see D3 licensing).
