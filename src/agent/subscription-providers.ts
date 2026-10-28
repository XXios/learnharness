import type { Api, Model, Models, SimpleStreamOptions, StreamFunction } from "@earendil-works/pi-ai";
import type { AdmissionScope, SubscriptionDispatchLifecycle } from "./subscription-request-cycle.ts";

/** One subscription connection as the agent layer sees it. Runtime behavior
 * only; the display descriptor (logicalId + label) lives in core. */
export interface SubscriptionProvider {
	/** The logical provider id models and settings carry. */
	readonly id: string;
	connected(): boolean;
	/** Background-consent gate for helper agents and automatic follow-ups. */
	backgroundAllowed(): boolean;
	scopeCurrent(scope: AdmissionScope): boolean;
	onChange(listener: () => void): () => void;
	model(id: string): Model<Api> | undefined;
	models(): Model<Api>[];
	/** Shared refreshers (one owner behind several ids) may be the same function; callers dedupe by identity. */
	refreshModels: (models: Models) => Promise<void>;
	stream(models: Models, background: () => boolean, lifecycle?: SubscriptionDispatchLifecycle): StreamFunction<Api, SimpleStreamOptions>;
	/** Public, credential-free error text for a failed turn. */
	errorMessage(message: string): string;
}

const KEY = Symbol.for("lh.subscriptionProviders");
function registry(): Map<string, SubscriptionProvider> {
	const global = globalThis as typeof globalThis & { [KEY]?: Map<string, SubscriptionProvider> };
	return global[KEY] ??= new Map();
}
export function registerSubscriptionProvider(provider: SubscriptionProvider): void { registry().set(provider.id, provider); }
export function subscriptionProvider(id: string | undefined): SubscriptionProvider | undefined { return id ? registry().get(id) : undefined; }
export function subscriptionProviders(): SubscriptionProvider[] { return [...registry().values()]; }
