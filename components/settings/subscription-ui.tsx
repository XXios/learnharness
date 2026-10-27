"use client";
import type { ComponentType, ReactNode } from "react";
import { NATIVE_SUBSCRIPTIONS } from "@/src/core";
import { ChatGPTBackgroundAccess, ChatGPTConnection, ChatGPTUIProvider } from "./chatgpt-connection";
import { NativeSubscriptionBackgroundAccess, NativeSubscriptionConnection, NativeSubscriptionUIProvider } from "./subscription-connections";
import { ClaudeCodeBackgroundAccess, ClaudeCodeConnection, ClaudeCodeUIProvider } from "./claude-code-connection";

/** One subscription connection's UI: its Providers row, an optional context
 * provider mounted once at the settings root, and an optional inline
 * "Enable background use" affordance keyed by a model's provider id. */
export interface SubscriptionUI {
	id: string;
	Row: ComponentType<{ setup?: boolean }>;
	Provider?: ComponentType<{ children: ReactNode }>;
	BackgroundAccess?: ComponentType<{ provider: string | undefined }>;
}

/** Composition point: every subscription connection's UI registers here, one entry each. */
export const SUBSCRIPTION_UI: readonly SubscriptionUI[] = [
	{ id: "chatgpt", Row: ChatGPTConnection, Provider: ChatGPTUIProvider, BackgroundAccess: ChatGPTBackgroundAccess },
	...NATIVE_SUBSCRIPTIONS.map(({ providerId, logicalId }, index): SubscriptionUI => ({
		id: logicalId,
		Row: function NativeRow() { return <NativeSubscriptionConnection providerId={providerId} />; },
		// One shared owner context and inline affordance cover every native connection.
		...(index === 0 ? { Provider: NativeSubscriptionUIProvider, BackgroundAccess: NativeSubscriptionBackgroundAccess } : {}),
	})),
	// Fork: Claude subscription via local Claude Code.
	{ id: "claude-code-subscription", Row: ClaudeCodeConnection, Provider: ClaudeCodeUIProvider, BackgroundAccess: ClaudeCodeBackgroundAccess },
];

export function SubscriptionUIProviders({ children }: { children: ReactNode }) {
	return SUBSCRIPTION_UI.reduceRight<ReactNode>((inner, ui) => ui.Provider ? <ui.Provider key={ui.id}>{inner}</ui.Provider> : inner, children);
}
export function SubscriptionConnections({ setup = false }: { setup?: boolean }) {
	return <div className="space-y-3" data-testid="subscription-connections">{SUBSCRIPTION_UI.map((ui) => <ui.Row key={ui.id} setup={setup} />)}</div>;
}
export function SubscriptionBackgroundAccess({ provider }: { provider: string | undefined }) {
	return <>{SUBSCRIPTION_UI.map((ui) => ui.BackgroundAccess && <ui.BackgroundAccess key={ui.id} provider={provider} />)}</>;
}
