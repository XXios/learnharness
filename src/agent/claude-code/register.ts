/** Fork feature: registers the Claude subscription in the Phase 1 registry. */
import { CLAUDE_CODE_PROVIDER_ID } from "../../core/contracts/claude-code.ts";
import { registerSubscriptionProvider } from "../subscription-providers.ts";
import { claudeCodeBackgroundAllowed, claudeCodeCatalog, claudeCodeConnected, claudeCodeModel, claudeCodeScopeCurrent, onClaudeCodeChange, refreshClaudeCodeModels } from "./bridge.ts";
import { claudeCodeError, claudeCodeStream } from "./stream.ts";

registerSubscriptionProvider({
	id: CLAUDE_CODE_PROVIDER_ID,
	connected: claudeCodeConnected,
	backgroundAllowed: claudeCodeBackgroundAllowed,
	scopeCurrent: claudeCodeScopeCurrent,
	onChange: onClaudeCodeChange,
	model: claudeCodeModel,
	models: claudeCodeCatalog,
	refreshModels: refreshClaudeCodeModels,
	stream: (_models, background, lifecycle) => claudeCodeStream(background, lifecycle),
	errorMessage: claudeCodeError,
});
