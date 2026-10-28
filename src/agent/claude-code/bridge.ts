/** Server-side view of the Claude connection: snapshots from the desktop main
 * owner (inherited IPC) or the web/dev owner (private runtime). No credentials
 * cross this bridge; Claude Code keeps its own login. */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ClaudeCodeSnapshot, ClaudeCodeStatus } from "../../core/contracts/claude-code.ts";
import type { AdmissionScope, NoDispatchKind } from "../subscription-request-cycle.ts";
import { onWebSubscriptionPacket, webSubscriptionRequest, webSubscriptionsEnabled } from "../subscription-runtime.ts";
import { claudeCodeModels } from "./catalog.ts";

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface State {
	status?: ClaudeCodeStatus;
	models: Model<Api>[];
	pending: Map<string, Pending>;
	controllers: Map<AbortController, { background: boolean }>;
	listeners: Set<() => void>;
	counter: number;
}
const KEY = Symbol.for("lh.claudeCode.bridge");
function desktopConnected(): boolean {
	return process.env.LH_DESKTOP_SERVER === "1" && (process.env.LH_DESKTOP_API_SECRET?.length ?? 0) >= 64 && typeof process.send === "function" && process.connected === true;
}
function runtimeConnected(): boolean { return desktopConnected() || webSubscriptionsEnabled(); }
function notify(state: State) { for (const listener of state.listeners) { try { listener(); } catch { /* observer isolation */ } } }
function invalidate(state: State) {
	for (const controller of state.controllers.keys()) controller.abort("all");
	state.status = undefined; state.models = [];
}
function accept(state: State, snapshot: ClaudeCodeSnapshot | undefined) {
	const next = snapshot?.status;
	if (!next || ![next.revision, next.epoch, next.authorityRevision].every((n) => Number.isSafeInteger(n) && n >= 0)) return;
	const previous = state.status;
	if (previous && next.revision < previous.revision) return;
	const all = !!previous && (next.connectionId !== previous.connectionId || next.epoch !== previous.epoch || next.authorityRevision !== previous.authorityRevision || !next.available || !next.connected);
	for (const [controller, owner] of state.controllers) {
		if (all) controller.abort("all");
		else if (owner.background && !next.allowBackgroundUse) controller.abort("background");
	}
	state.status = next;
	state.models = next.available && next.connected ? claudeCodeModels(snapshot!.models ?? []) : [];
	if (!previous || next.revision !== previous.revision) notify(state);
}
function bridge(): State {
	const global = globalThis as typeof globalThis & { [KEY]?: State };
	if (!global[KEY]) {
		const state: State = { models: [], pending: new Map(), controllers: new Map(), listeners: new Set(), counter: 0 };
		global[KEY] = state;
		process.on("message", (raw: unknown) => {
			const message = raw as { channel?: string; op?: string; id?: string; ok?: boolean; value?: unknown; error?: string; snapshot?: ClaudeCodeSnapshot };
			if (!desktopConnected() || message?.channel !== "lh:claude-code") return;
			if (message.op === "changed") accept(state, message.snapshot);
			if (!message.id) return;
			const pending = state.pending.get(message.id);
			if (!pending) return;
			clearTimeout(pending.timer); state.pending.delete(message.id);
			if (message.ok) pending.resolve(message.value);
			else pending.reject(new Error(message.error ?? "The Claude connection failed."));
		});
		onWebSubscriptionPacket("lh:claude-code", (packet) => { if (webSubscriptionsEnabled()) accept(state, packet.snapshot as ClaudeCodeSnapshot); });
		process.on("disconnect", () => {
			if (webSubscriptionsEnabled()) return;
			invalidate(state);
			for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("The desktop connection closed.")); }
			state.pending.clear(); notify(state);
		});
	}
	return global[KEY];
}
function snapshotRequest(): Promise<ClaudeCodeSnapshot> {
	const state = bridge();
	if (webSubscriptionsEnabled()) return webSubscriptionRequest<ClaudeCodeSnapshot>("lh:claude-code", "snapshot", {});
	if (!desktopConnected()) return Promise.reject(new Error("The Claude connection is available only in the desktop app or the web/dev server."));
	return new Promise((resolve, reject) => {
		const id = `${process.pid}:cc:${++state.counter}`;
		const timer = setTimeout(() => { state.pending.delete(id); reject(new Error("The Claude desktop connection timed out.")); }, 45000);
		state.pending.set(id, { timer, resolve: (value) => resolve(value as ClaudeCodeSnapshot), reject });
		process.send!({ channel: "lh:claude-code", id, op: "snapshot" }, (error) => {
			if (error) { clearTimeout(timer); state.pending.delete(id); reject(new Error("The Claude desktop connection closed.")); }
		});
	});
}
export async function refreshClaudeCodeModels(): Promise<void> {
	const state = bridge();
	if (!runtimeConnected()) { invalidate(state); return; }
	try { accept(state, await snapshotRequest()); }
	catch { invalidate(state); notify(state); }
}
export function claudeCodeStatus(): ClaudeCodeStatus | undefined { return bridge().status; }
export function claudeCodeConnected(): boolean {
	const status = claudeCodeStatus();
	return runtimeConnected() && status?.available === true && status.connected && !!status.connectionId;
}
export function claudeCodeBackgroundAllowed(): boolean { return claudeCodeConnected() && claudeCodeStatus()?.allowBackgroundUse === true; }
export function claudeCodeCatalog(): Model<Api>[] { return runtimeConnected() ? bridge().models : []; }
export function claudeCodeModel(id: string): Model<Api> | undefined { return claudeCodeCatalog().find((m) => m.id === id); }
export function onClaudeCodeChange(listener: () => void): () => void { const state = bridge(); state.listeners.add(listener); return () => { state.listeners.delete(listener); }; }
/** accountId is the app-side connection id; epoch bumps on any login change. */
export function claudeCodeScope(selectedModelId: string): AdmissionScope {
	const status = claudeCodeStatus();
	if (!status?.connectionId || !claudeCodeConnected() || !claudeCodeModel(selectedModelId)) throw new Error("Claude model catalog unavailable");
	return { accountId: status.connectionId, epoch: status.epoch, authorityRevision: status.authorityRevision, selectedModelId };
}
export function claudeCodeScopeCurrent(scope: AdmissionScope): boolean {
	try { return JSON.stringify(claudeCodeScope(scope.selectedModelId)) === JSON.stringify(scope); } catch { return false; }
}
export function claudeCodeAbortController(background: boolean) {
	const state = bridge(); const controller = new AbortController(); state.controllers.set(controller, { background });
	return { controller, release: () => { state.controllers.delete(controller); } };
}
export async function claudeCodeDenial(scope: AdmissionScope | undefined, controller: AbortController, callerAborted: boolean, background: boolean): Promise<NoDispatchKind> {
	if (callerAborted || controller.signal.reason === "all") return "all";
	if (!scope || !claudeCodeScopeCurrent(scope)) return "other";
	if (controller.signal.reason === "background") return "background";
	if (!background) return "other";
	await refreshClaudeCodeModels();
	if (!claudeCodeScopeCurrent(scope)) return "all";
	return claudeCodeBackgroundAllowed() ? "other" : "background";
}
