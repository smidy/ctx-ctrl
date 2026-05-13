/**
 * WebSocket protocol between the extension runtime and the browser client.
 *
 * All messages are JSON objects with a discriminator `kind`. New message
 * kinds MUST be added to both unions; unknown kinds are rejected at the
 * server boundary (see server/ws.ts).
 */

import type {
	ContextUsageDTO,
	CtxCtrlSelection,
	EntryMark,
	SessionSnapshot,
} from "./types.js";

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export type ServerMsg =
	| { kind: "snapshot"; data: SessionSnapshot }
	| { kind: "selection"; data: CtxCtrlSelection }
	| { kind: "context_usage"; data: ContextUsageDTO }
	| { kind: "compaction_started" }
	| {
			kind: "compaction_progress";
			/** 0-based index into the run list. */
			runIndex: number;
			totalRuns: number;
			runHash: string;
			status: "started" | "complete" | "failed";
			/** Populated only when status === "failed". */
			error?: string;
	  }
	| { kind: "compaction_finished"; ok: boolean; error?: string }
	| { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export type ClientMsg =
	| { kind: "mark"; contentHash: string; mark: EntryMark }
	| { kind: "unmark"; contentHash: string }
	| { kind: "set_instructions"; customInstructions: string }
	| { kind: "set_active"; active: boolean }
	| { kind: "clear" }
	| { kind: "request_snapshot" }
	| { kind: "compact_now" };

// ---------------------------------------------------------------------------
// Boundary validation — server side. Reject unknown shapes.
// ---------------------------------------------------------------------------

const VALID_MARKS: ReadonlySet<EntryMark> = new Set(["keep", "summarize", "drop"]);

export function parseClientMsg(raw: unknown): ClientMsg | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const kind = obj.kind;
	if (typeof kind !== "string") return null;

	switch (kind) {
		case "mark": {
			if (typeof obj.contentHash !== "string") return null;
			if (typeof obj.mark !== "string" || !VALID_MARKS.has(obj.mark as EntryMark)) return null;
			return { kind: "mark", contentHash: obj.contentHash, mark: obj.mark as EntryMark };
		}
		case "unmark": {
			if (typeof obj.contentHash !== "string") return null;
			return { kind: "unmark", contentHash: obj.contentHash };
		}
		case "set_instructions": {
			if (typeof obj.customInstructions !== "string") return null;
			return { kind: "set_instructions", customInstructions: obj.customInstructions };
		}
		case "set_active": {
			if (typeof obj.active !== "boolean") return null;
			return { kind: "set_active", active: obj.active };
		}
		case "clear":
			return { kind: "clear" };
		case "request_snapshot":
			return { kind: "request_snapshot" };
		case "compact_now":
			return { kind: "compact_now" };
		default:
			return null;
	}
}
