"use client";
/** Fork feature: the Claude subscription row (local Claude Code login).
 * Connect = detect + instruct (plan D4): the app never handles Claude tokens. */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CLAUDE_CODE_LABEL, CLAUDE_CODE_PROVIDER_ID, type ClaudeCodeControlBridge, type ClaudeCodeStatus } from "@/src/core";
import { Button } from "@/components/ui/button";
import { notifySettingsSaved } from "@/components/settings-signal";
import { useNotifyHub, type createNotifyHub } from "@/components/server-events";
import { ConnectionDialog, ConnectionFooter, ConnectionRow } from "./connection-controls";
import { Toggle } from "./controls";
import { SUBSCRIPTION_BACKGROUND_HINT } from "./subscription-connections";

export const CLAUDE_CODE_NOTICE = "LearnHarness runs your locally signed-in Claude Code to answer as the model. Your prompts, tool results and relevant session context are sent to Anthropic under your Claude plan; Claude Code may also attach your account email, the date and basic system details. LearnHarness never sees or stores your Claude credentials, and never falls back to an API key.";
export const CLAUDE_CODE_SIGN_IN = "Claude Code is not signed in to a Claude subscription. In a terminal, run `claude`, then `/login` and sign in with your Claude Pro or Max account. Then choose Check again.";
const CONTROL_ERROR = "The Claude connection could not be changed. Try again.";
const PATH = "/api/subscriptions/claude-code";
const headers = { "Content-Type": "application/json", "x-learnharness-subscriptions": "1" };

export function emptyClaudeCodeStatus(): ClaudeCodeStatus {
	return { available: false, connected: false, checking: false, signedIn: false, email: null, subscriptionType: null, allowBackgroundUse: true, connectionId: null, epoch: 0, authorityRevision: 0, revision: 0 };
}

type Hub = ReturnType<typeof createNotifyHub> | null;
export function createWebClaudeCodeBridge(hub: Hub): ClaudeCodeControlBridge {
	const control = async (op: string, fields: Record<string, unknown> = {}) => {
		const response = await fetch(PATH, { method: "POST", headers, body: JSON.stringify({ op, ...fields }) });
		if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? CONTROL_ERROR);
	};
	return {
		status: async () => {
			const response = await fetch(PATH, { headers, cache: "no-store" });
			if (!response.ok) throw new Error("Claude status is unavailable.");
			return response.json() as Promise<ClaudeCodeStatus>;
		},
		connect: (enabled) => control("connect", enabled === undefined ? {} : { enabled }),
		check: () => control("check"),
		consent: (enabled) => control("consent", { enabled }),
		disconnect: () => control("disconnect"),
		onChange: (listener) => {
			const offEvent = hub?.subscribe("subscriptions-changed", listener);
			const offResync = hub?.onResync(listener);
			return () => { offEvent?.(); offResync?.(); };
		},
	};
}
export function useClaudeCodeBridge(): ClaudeCodeControlBridge | undefined {
	const hub = useNotifyHub();
	return useMemo(() => typeof window === "undefined" ? undefined : window.lh?.subscriptionTransport !== "web" && window.lh?.claudeCode ? window.lh.claudeCode : createWebClaudeCodeBridge(hub), [hub]);
}

const Context = createContext({ status: emptyClaudeCodeStatus(), busy: false, open: () => {} });

export function ClaudeCodeUIProvider({ children }: { children: React.ReactNode }) {
	const bridge = useClaudeCodeBridge();
	const [status, setStatus] = useState<ClaudeCodeStatus>(emptyClaudeCodeStatus);
	const [dialog, setDialog] = useState(false), [confirm, setConfirm] = useState(false);
	const [background, setBackground] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
	const mounted = useRef(false), sequence = useRef(0), statusRef = useRef(status);
	async function refresh() {
		const request = ++sequence.current;
		try {
			const next = await bridge?.status();
			if (!mounted.current || request !== sequence.current || !next || next.revision < statusRef.current.revision) return;
			statusRef.current = next; setStatus(next);
		} catch { /* desktop not ready yet; the next change event retries */ }
	}
	useEffect(() => {
		mounted.current = true; void refresh();
		const off = bridge?.onChange(() => { void refresh(); notifySettingsSaved("keys"); });
		return () => { mounted.current = false; off?.(); };
		// The root-lifetime subscriber reads current state through refs.
	}, [bridge]);
	async function control(action: () => Promise<void>, close = false) {
		if (busy || !bridge) return;
		setBusy(true); setError(null);
		try { await action(); await refresh(); if (mounted.current && close) setDialog(false); }
		catch (cause) { if (mounted.current) { setError(cause instanceof Error && cause.message ? cause.message : CONTROL_ERROR); await refresh(); } }
		finally { if (mounted.current) setBusy(false); }
	}
	function open() { if (busy) return; setError(null); setConfirm(false); setBackground(statusRef.current.allowBackgroundUse); setDialog(true); }
	function close() { if (busy) return; if (confirm) { setConfirm(false); return; } setDialog(false); setError(null); }
	const managing = !!status.connectionId;
	return <Context.Provider value={{ status, busy, open }}>
		{children}
		{dialog && <ConnectionDialog label={`${CLAUDE_CODE_LABEL} connection`} testid="claude-code-connection-dialog" backdropTestid="claude-code-dialog-backdrop" busy={busy} onClose={close}>
			<h2 className="text-sm font-semibold text-foreground">{CLAUDE_CODE_LABEL} (Claude Code)</h2>
			{confirm ? <>
				<p className="mt-3 text-sm font-semibold text-red-400">Disconnect {CLAUDE_CODE_LABEL}?</p>
				<p className="mt-3 text-xs leading-relaxed text-muted-foreground">This stops LearnHarness from using your Claude subscription and forgets its background-use choice. It does not sign Claude Code out or change your plan. Saved model choices stay unavailable until you reconnect or change them.</p>
			</> : <>
				<p className="mt-3 text-xs leading-relaxed text-muted-foreground" data-testid="claude-code-notice">{CLAUDE_CODE_NOTICE}</p>
				<div className="mt-3 text-xs text-foreground" data-testid="claude-code-account" role="status">
					{status.checking ? "Checking Claude Code…"
						: status.signedIn ? <>Signed in as <span className="font-medium">{status.email}</span>{status.subscriptionType ? ` · ${status.subscriptionType}` : ""}{status.connected ? " · connected" : ""}</>
						: status.available ? <span className="text-muted-foreground">{status.error ?? CLAUDE_CODE_SIGN_IN}</span>
						: <span className="text-muted-foreground">The Claude connection is starting…</span>}
				</div>
				<div className="mt-4 flex items-center gap-3 text-xs text-foreground">
					<Toggle label="Allow background use" checked={managing ? status.allowBackgroundUse : background} disabled={busy || !status.available} onChange={(enabled) => { setBackground(enabled); if (managing && bridge) void control(() => bridge.consent(enabled)); }} />
					<span>Allow background use<span className="mt-1 block leading-relaxed text-muted-foreground">{SUBSCRIPTION_BACKGROUND_HINT}</span></span>
				</div>
			</>}
			{error && <p role="alert" className="mt-3 text-xs text-red-400">{error}</p>}
			<ConnectionFooter testid="claude-code-connection-footer" leading={!confirm && managing && <Button variant="ghost" size="sm" className="cursor-pointer text-red-400 hover:bg-red-500/10 hover:text-red-300" disabled={busy} onClick={() => setConfirm(true)}>Disconnect</Button>}>
				{!confirm && <Button variant="outline" size="sm" disabled={busy || !status.available || status.checking} onClick={() => bridge && void control(() => bridge.check())}>Check again</Button>}
				<Button variant="ghost" size="sm" disabled={busy} onClick={close}>{confirm ? "Cancel" : "Close"}</Button>
				{confirm ? <Button variant="destructive" size="sm" disabled={busy} onClick={() => bridge && void control(() => bridge.disconnect(), true)}>Disconnect</Button>
					: !status.connected && <Button variant="outline" size="sm" disabled={busy || !status.available || status.checking || !status.signedIn} onClick={() => bridge && void control(() => bridge.connect(managing ? undefined : background), true)}>Connect</Button>}
			</ConnectionFooter>
		</ConnectionDialog>}
	</Context.Provider>;
}

export function ClaudeCodeConnection(_props: { setup?: boolean } = {}) {
	const ui = useContext(Context), status = ui.status;
	return <div className="flex flex-col gap-2" data-testid="claude-code-connection">
		<ConnectionRow label={CLAUDE_CODE_LABEL} action={status.connectionId ? "Manage…" : "Connect"} disabled={ui.busy || !status.available} onAction={ui.open} />
		{status.connectionId && !status.connected && !status.checking && <p role="alert" className="text-xs text-red-400">{status.error ?? CLAUDE_CODE_SIGN_IN}</p>}
	</div>;
}

export function ClaudeCodeBackgroundAccess({ provider }: { provider: string | undefined }) {
	const ui = useContext(Context);
	if (provider !== CLAUDE_CODE_PROVIDER_ID || !ui.status.connected || ui.status.allowBackgroundUse) return null;
	return <Button type="button" size="xs" variant="ghost" disabled={ui.busy} onClick={ui.open}>Enable background use</Button>;
}
