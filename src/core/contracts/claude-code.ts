/** Fork feature: Claude subscription via the locally signed-in Claude Code.
 * The app never handles Claude tokens; it only probes the local login. */
export const CLAUDE_CODE_PROVIDER_ID = "claude-code-subscription";
export const CLAUDE_CODE_LABEL = "Claude";

/** One row of Claude Code's supportedModels(), projected (no credentials). */
export interface ClaudeCodeModelInfo {
	value: string;
	resolvedModel?: string;
	displayName: string;
	supportedEffortLevels?: string[];
}

export interface ClaudeCodeStatus {
	/** The SDK loaded and the owner is running. */
	available: boolean;
	/** App-side connection exists AND Claude Code is signed in to a Claude subscription. */
	connected: boolean;
	checking: boolean;
	/** Last probe: signed in to a Claude subscription (not an API key, not signed out). */
	signedIn: boolean;
	email: string | null;
	subscriptionType: string | null;
	allowBackgroundUse: boolean;
	connectionId: string | null;
	epoch: number;
	authorityRevision: number;
	revision: number;
	error?: string;
}

export interface ClaudeCodeSnapshot {
	status: ClaudeCodeStatus;
	models: ClaudeCodeModelInfo[];
}

export interface ClaudeCodeControlBridge {
	status(): Promise<ClaudeCodeStatus>;
	/** Probe the local login; when signed in, create the app-side connection. */
	connect(enabled?: boolean): Promise<void>;
	/** Re-probe the local login ("Check again"). */
	check(): Promise<void>;
	consent(enabled: boolean): Promise<void>;
	/** Forget the app-side connection and consent. Never logs the CLI out. */
	disconnect(): Promise<void>;
	onChange(listener: () => void): () => void;
}
