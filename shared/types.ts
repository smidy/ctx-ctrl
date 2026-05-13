/**
 * ctx-ctrl shared types.
 *
 * Used by both the extension runtime (`index.ts`, `server/*`, `core/*`) and
 * the browser client (`client/client.js` via TypeScript-free duck typing).
 *
 * The canonical join key between extension runtime and browser is a content
 * hash, NOT the session entry ID. This is because the `context` event exposes
 * messages without stable session entry IDs (see ctxedit/index.ts:311 for the
 * same conclusion). Hashing also survives entry-ID rotation across
 * compaction.
 */

export type EntryMark = "keep" | "summarize" | "drop";

export interface CtxCtrlSelection {
	/** Content hash → user mark. Unhashed entries follow defaultMark. */
	marks: Record<string, EntryMark>;
	/** Default mark for entries with no explicit mark. */
	defaultMark: EntryMark;
	/** Free-form instructions appended to the summarizer prompt. */
	customInstructions: string;
	/** Master toggle — when false, every hook short-circuits. */
	active: boolean;
	/** Schema version for forward compatibility. */
	version: 1;
}

export function createEmptySelection(): CtxCtrlSelection {
	return {
		marks: {},
		// D1: always "keep". The user-facing default selector was removed; this
		// field is retained for back-compat with persisted selections, but is
		// coerced to "keep" on load (see core/persistence.ts).
		defaultMark: "keep",
		customInstructions: "",
		active: false,
		version: 1,
	};
}

/** UI-side projection of one session entry. */
export interface EntryDTO {
	/** Session entry ID — used only for display (turn ordering / debug). */
	entryId: string;
	/** Content hash — the canonical key for marks. */
	contentHash: string;
	role:
		| "user"
		| "assistant"
		| "toolCall"
		| "toolResult"
		| "compaction"
		| "branch_summary"
		| "custom"
		| "other";
	turnIndex: number;
	timestamp: number;
	/** First 400 chars (no truncation marker), shown when the row is collapsed. */
	preview: string;
	/**
	 * Full content text — same shape as `preview` but uncapped. Client uses
	 * this when the row is expanded. Always populated even when shorter than
	 * the preview limit (in that case `preview === fullContent`).
	 */
	fullContent: string;
	totalChars: number;
	/** For toolCall / toolResult rows. */
	toolName?: string;
	/** Effective mark (explicit or default). */
	mark: EntryMark;
	/** True when user has set this entry's mark; false when defaulted. */
	isExplicit: boolean;
	/**
	 * True if this entry can serve as a cut point for compaction.
	 * False for tool-result rows (per compaction.md §Cut Point Rules).
	 */
	cutEligible: boolean;
}

export interface ContextUsageDTO {
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
}

export interface CutSuggestionDTO {
	/**
	 * Pi's current default `firstKeptEntryId` — recomputed cheaply on each
	 * snapshot from session manager state. Null when no compaction is needed.
	 */
	firstKeptEntryId: string | null;
	tokensBefore: number | null;
}

export interface SessionSnapshot {
	sessionId: string;
	cwd: string;
	entries: EntryDTO[];
	selection: CtxCtrlSelection;
	contextUsage: ContextUsageDTO;
	cutSuggestion: CutSuggestionDTO;
	/** ISO timestamp the server produced this snapshot. */
	snapshotAt: number;
	/** Pi-coding-agent version of the server. */
	serverVersion: string;
}
