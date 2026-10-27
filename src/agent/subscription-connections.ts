import "./subscription-provider-list.ts";
import { subscriptionProvider, subscriptionProviders } from "./subscription-providers.ts";
import type { AdmissionScope } from "./subscription-request-cycle.ts";

export function isSubscriptionProvider(provider: string | undefined): boolean { return !!subscriptionProvider(provider); }
export function subscriptionConnected(provider: string): boolean { return subscriptionProvider(provider)?.connected() ?? false; }
/** Ordinary API connections have no subscription background-consent gate. */
export function connectionBackgroundAllowed(provider: string | undefined): boolean {
	const subscription = subscriptionProvider(provider);
	return subscription ? subscription.backgroundAllowed() : true;
}
export function connectionScopeCurrent(provider: string, scope: AdmissionScope): boolean { return subscriptionProvider(provider)?.scopeCurrent(scope) ?? false; }
/** Owners shared by several ids register the same listener function; subscribe once each. */
export function onSubscriptionChange(listener: () => void): () => void {
	const stops = [...new Set(subscriptionProviders().map((p) => p.onChange))].map((onChange) => onChange(listener));
	return () => { for (const stop of stops) stop(); };
}
/** Public error text for a subscription turn; undefined for ordinary API providers. */
export function subscriptionErrorMessage(provider: string | undefined, message: string): string | undefined { return subscriptionProvider(provider)?.errorMessage(message); }
export { subscriptionProvider, subscriptionProviders } from "./subscription-providers.ts";
