/** Composition point: every subscription connection registers here, one line each. */
import type { Model, Models } from "@earendil-works/pi-ai";
import { NATIVE_SUBSCRIPTIONS } from "../core/contracts/subscriptions.ts";
import { chatGPTBackgroundAllowed, chatGPTConnected, chatGPTModel, chatGPTModels, chatGPTScopeCurrent, onChatGPTChange, refreshChatGPTModels } from "./chatgpt-bridge.ts";
import { chatGPTStream, chatGPTStreamError } from "./chatgpt-stream.ts";
import { nativeAdmissionCurrent, nativeSubscriptionBackgroundAllowed, nativeSubscriptionConnected, nativeSubscriptionModel, nativeSubscriptionModels, onNativeSubscriptionChange, refreshSubscriptionModels } from "./subscription-bridge.ts";
import { nativeSubscriptionError, nativeSubscriptionStream } from "./subscription-stream.ts";
import { registerSubscriptionProvider, type SubscriptionProvider } from "./subscription-providers.ts";

const refreshChatGPT = (models: Models) => refreshChatGPTModels(models.getModels("openai").filter((m): m is Model<"openai-responses"> => m.api === "openai-responses"));
const refreshNative = () => refreshSubscriptionModels();

registerSubscriptionProvider({
	id: "chatgpt",
	connected: chatGPTConnected,
	backgroundAllowed: chatGPTBackgroundAllowed,
	scopeCurrent: chatGPTScopeCurrent,
	onChange: onChatGPTChange,
	model: chatGPTModel,
	models: chatGPTModels,
	refreshModels: refreshChatGPT,
	stream: (_models, background, lifecycle) => chatGPTStream(background, lifecycle),
	errorMessage: chatGPTStreamError,
});

for (const { providerId, logicalId } of NATIVE_SUBSCRIPTIONS) registerSubscriptionProvider({
	id: logicalId,
	connected: () => nativeSubscriptionConnected(providerId),
	backgroundAllowed: () => nativeSubscriptionBackgroundAllowed(providerId),
	scopeCurrent: (scope) => nativeAdmissionCurrent(providerId, scope),
	onChange: onNativeSubscriptionChange,
	model: (id) => nativeSubscriptionModel(logicalId, id),
	models: () => nativeSubscriptionModels().filter((m) => m.provider === logicalId),
	refreshModels: refreshNative,
	stream: (models, background, lifecycle) => nativeSubscriptionStream(models.getProvider(providerId)!, background, lifecycle),
	errorMessage: (message) => nativeSubscriptionError(logicalId, message),
} satisfies SubscriptionProvider);

// Fork: Claude subscription via local Claude Code (docs/fork/claude-code-subscription.md).
import "./claude-code/register.ts";
