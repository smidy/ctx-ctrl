/**
 * Shared classification for walking a branch in `findSRuns` (run detection)
 * and `buildSetup` (rebuild). Both walks MUST decide the same fate for the
 * same entry — runHash diverges otherwise and the summaries-map lookup
 * misses inside `ctx.newSession`'s setup callback.
 */

import { contentHash, extractTextContent, summaryEntryHash } from "./hash.js";
import { effectiveMark } from "./selection.js";
import type { CtxCtrlSelection } from "../shared/types.js";

export type EntryClass =
	/** Bookkeeping / empty / unrecognized — caller skips without flushing. */
	| { kind: "skip" }
	/** Explicit drop — caller flushes pending run, emits nothing. */
	| { kind: "drop" }
	/** Verbatim message preserve — caller flushes, then appends. */
	| { kind: "append-message"; message: unknown; hash: string }
	/** Verbatim prior summary preserve — caller flushes, then branchWithSummary. */
	| {
			kind: "preserve-summary";
			summaryText: string;
			originalId: string;
			entryType: "compaction" | "branch_summary";
	  }
	/** Fold message into the current S-run. */
	| { kind: "fold-message"; message: unknown; hash: string; entryId: string }
	/** Fold prior summary into the current S-run (as wrapped fake user message). */
	| { kind: "fold-summary"; summaryText: string; entryId: string };

export function classifyBranchEntry(
	entry: Record<string, unknown> | null | undefined,
	selection: CtxCtrlSelection,
): EntryClass {
	if (!entry) return { kind: "skip" };
	const type = entry.type;

	if (type === "compaction" || type === "branch_summary") {
		const summaryText = typeof entry.summary === "string" ? entry.summary : "";
		if (!summaryText) return { kind: "skip" };
		const entryId = (entry.id as string) ?? "";
		const hash = summaryEntryHash(type, entryId, summaryText);
		const { mark } = effectiveMark(selection, hash);
		if (mark === "summarize") return { kind: "fold-summary", summaryText, entryId };
		if (mark === "drop") return { kind: "drop" };
		return { kind: "preserve-summary", summaryText, originalId: entryId, entryType: type };
	}

	if (type !== "message") return { kind: "skip" };

	const message = entry.message;
	if (!message) return { kind: "skip" };
	const text = extractTextContent(message);
	if (text.trim().length === 0) return { kind: "skip" };

	const hash = contentHash(text);
	const { mark } = effectiveMark(selection, hash);
	const entryId = (entry.id as string) ?? "";

	if (mark === "summarize") return { kind: "fold-message", message, hash, entryId };
	if (mark === "drop") return { kind: "drop" };
	return { kind: "append-message", message, hash };
}

/**
 * Wrap a prior summary's text as a fake user message so the summarizer LLM
 * can incorporate it. MUST stay byte-identical across both walks for run
 * identity to align.
 */
export function wrapSummaryAsMessage(summaryText: string): Record<string, unknown> {
	return {
		role: "user",
		content: [{ type: "text", text: `[Previous summary]\n\n${summaryText}` }],
	};
}
