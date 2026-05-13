/**
 * Selective compaction logic.
 *
 * Given the messages pi planned to summarize (and optionally a wider
 * branch view), bucket them by user mark and produce a custom
 * CompactionResult honoring the selection:
 *
 *   - SUMMARIZE → fed to the summarizer LLM
 *   - KEEP      → quoted verbatim into a "Preserved excerpts" appendix
 *   - DROP      → omitted entirely
 *
 * The cut point may be force-shifted earlier when the user has explicit
 * marks past pi's natural cut: we walk the branch, find the latest entry the
 * user marked, and place the new cut just after it. This makes the manual
 * `/compact` (or "Apply compaction") flow do what the user expects when the
 * session is below pi's auto-compaction threshold and pi's natural cut
 * lands at the very start of the branch with nothing pre-cut.
 */

import {
	convertToLlm,
	serializeConversation,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { contentHash, extractTextContent } from "./hash.js";
import { effectiveMark } from "./selection.js";
import { runSummarizer } from "./summarizer.js";
import type { CtxCtrlSelection } from "../shared/types.js";

export interface CompactorInput {
	/** Messages pi planned to summarize (`event.preparation.messagesToSummarize`). */
	messagesToSummarize: unknown[];
	/**
	 * Split-turn prefix (`event.preparation.turnPrefixMessages`). When a single
	 * turn exceeds `keepRecentTokens`, pi places the cut mid-turn and supplies
	 * the early part of that turn here. These messages also need to be folded
	 * into the summary input — ignoring them produces empty summaries on
	 * sessions whose first compaction lands mid-turn.
	 */
	turnPrefixMessages: unknown[];
	/** Previous compaction summary, when iterating. */
	previousSummary: string | null;
	/** `event.preparation.firstKeptEntryId`. */
	firstKeptEntryId: string;
	/** `event.preparation.tokensBefore`. */
	tokensBefore: number;
	/** From the event when `/compact <instructions>` was used. */
	eventCustomInstructions: string | null;
	/**
	 * ALL entries on the current branch — `event.branchEntries`. Needed for
	 * force-shift cut computation when pi's natural cut is earlier than the
	 * user's latest mark.
	 */
	branchEntries: unknown[];
}

export interface CompactorOutput {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details: {
		source: "ctx-ctrl";
		summarizedCount: number;
		keptCount: number;
		droppedCount: number;
		userInstructions: string;
		cutSource: "pi-natural" | "force-shift-by-marks";
	};
}

/**
 * Produce a custom compaction. Returns `null` when there's nothing we should
 * override pi on — the caller should return `undefined` from the hook so pi
 * runs its default path.
 *
 * Decision tree:
 *   1. User has explicit marks AND we can find a valid force-shift cut →
 *      summarize the [start..cutIdx-1] range using those marks.
 *   2. No marks OR force-shift impossible: use pi's prep (messagesToSummarize
 *      + turnPrefixMessages). If both are empty, return null.
 */
export async function buildCustomCompaction(
	input: CompactorInput,
	selection: CtxCtrlSelection,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<CompactorOutput | null> {
	const summarizerInstructions = combineInstructions(
		selection.customInstructions,
		input.eventCustomInstructions,
	);

	// ---- Path A: force-shift driven by user marks ----
	if (Object.keys(selection.marks).length > 0) {
		const forced = findForceShift(input.branchEntries, selection, input.firstKeptEntryId);
		if (forced) {
			return runBucketingPass({
				messages: forced.messages,
				firstKeptEntryId: forced.cutId,
				tokensBefore: input.tokensBefore,
				previousSummary: input.previousSummary,
				customInstructions: summarizerInstructions,
				cutSource: "force-shift-by-marks",
			}, selection, ctx, signal);
		}
	}

	// ---- Path B: use pi's natural prep ----
	const piCombined = [...input.messagesToSummarize, ...input.turnPrefixMessages];
	if (piCombined.length === 0) {
		// Nothing to do — let pi's default path handle it.
		return null;
	}
	return runBucketingPass({
		messages: piCombined,
		firstKeptEntryId: input.firstKeptEntryId,
		tokensBefore: input.tokensBefore,
		previousSummary: input.previousSummary,
		customInstructions: summarizerInstructions,
		cutSource: "pi-natural",
	}, selection, ctx, signal);
}

// ---------------------------------------------------------------------------
// Bucketing pass — shared by both code paths
// ---------------------------------------------------------------------------

interface BucketingArgs {
	messages: unknown[];
	firstKeptEntryId: string;
	tokensBefore: number;
	previousSummary: string | null;
	customInstructions: string;
	cutSource: CompactorOutput["details"]["cutSource"];
}

async function runBucketingPass(
	args: BucketingArgs,
	selection: CtxCtrlSelection,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<CompactorOutput> {
	const buckets = bucketByMark(args.messages, selection);

	const summaryBody =
		buckets.toSummarize.length === 0
			? composeNoOpSummary(args.previousSummary, buckets)
			: await runSummarizer({
					messages: buckets.toSummarize,
					previousSummary: args.previousSummary,
					customInstructions: args.customInstructions,
					ctx,
					signal,
				});

	const summary = appendPreservedExcerpts(summaryBody, buckets.toKeep);

	return {
		summary,
		firstKeptEntryId: args.firstKeptEntryId,
		tokensBefore: args.tokensBefore,
		details: {
			source: "ctx-ctrl",
			summarizedCount: buckets.toSummarize.length,
			keptCount: buckets.toKeep.length,
			droppedCount: buckets.toDrop.length,
			userInstructions: args.customInstructions,
			cutSource: args.cutSource,
		},
	};
}

// ---------------------------------------------------------------------------
// Force-shift cut computation
// ---------------------------------------------------------------------------

interface ForceShiftResult {
	cutId: string;
	messages: unknown[];
}

/**
 * Walk the branch and find a force-shift cut driven by user marks.
 *
 * Returns null when:
 *   - branchEntries is empty
 *   - no entry on the branch has an explicit mark
 *   - no valid cut point exists after the latest marked entry
 *
 * The cut is placed at the FIRST valid cut entry strictly after the latest
 * marked entry. Pre-cut messages (the bucket we'll act on) are all
 * "message"-type entries from index 0 up to but not including the cut.
 */
function findForceShift(
	branchEntries: unknown[],
	selection: CtxCtrlSelection,
	piNaturalCutId: string,
): ForceShiftResult | null {
	if (!Array.isArray(branchEntries) || branchEntries.length === 0) return null;

	// Locate pi's natural cut on the branch. If we can't find it, treat the
	// effective cut as "start of branch" (i.e., pi would compact nothing) so
	// that any user mark triggers force-shift.
	let naturalCutIdx = -1;
	for (let i = 0; i < branchEntries.length; i++) {
		const entry = branchEntries[i] as Record<string, unknown> | null;
		if (entry && entry.id === piNaturalCutId) {
			naturalCutIdx = i;
			break;
		}
	}
	const effectiveNaturalCut = naturalCutIdx === -1 ? 0 : naturalCutIdx;

	// Scan the branch for marked entries. Track:
	//   - firstKIdx: first K-marked entry (intent: keep verbatim → POST-cut)
	//   - lastSDIdx: last S/D-marked entry (intent: act in summary → PRE-cut)
	let firstKIdx = -1;
	let lastSDIdx = -1;
	for (let i = 0; i < branchEntries.length; i++) {
		const entry = branchEntries[i] as Record<string, unknown> | null;
		if (!entry || entry.type !== "message") continue;
		const text = extractTextContent(entry.message);
		if (!text) continue;
		const hash = contentHash(text);
		const mark = selection.marks[hash];
		if (mark === "keep") {
			if (firstKIdx === -1) firstKIdx = i;
		} else if (mark === "summarize" || mark === "drop") {
			lastSDIdx = i;
		}
	}

	// Determine cut position by the dominant signal:
	//   - If any S/D marks: cut AFTER last S/D (those must be pre-cut).
	//     K-marks earlier than that get quoted into the summary.
	//   - Else if K marks only: cut AT first K (K-marked entries stay verbatim
	//     as the first kept messages; everything before is summarized via
	//     default).
	let cutPos: number;
	if (lastSDIdx >= 0) {
		cutPos = lastSDIdx + 1;
	} else if (firstKIdx >= 0) {
		cutPos = firstKIdx;
	} else {
		return null;
	}

	// Advance past invalid cut points (tool results, non-message entries).
	while (cutPos < branchEntries.length) {
		const entry = branchEntries[cutPos] as Record<string, unknown> | null;
		if (entry && isValidCutEntry(entry)) break;
		cutPos++;
	}
	if (cutPos >= branchEntries.length) return null;

	// Conservative: only force-shift when we'd compact MORE than pi naturally
	// would. If pi's pre-cut range already covers our target, fall back to
	// pi's prep (Path B) — marks within that range will still be honored
	// during bucketing.
	if (cutPos <= effectiveNaturalCut) return null;

	const cutId = (branchEntries[cutPos] as Record<string, unknown>).id as string;
	if (!cutId) return null;

	// Collect message-type entries [0..cutPos-1] for bucketing.
	const messages: unknown[] = [];
	for (let i = 0; i < cutPos; i++) {
		const entry = branchEntries[i] as Record<string, unknown> | null;
		if (!entry || entry.type !== "message") continue;
		if (entry.message) messages.push(entry.message);
	}
	if (messages.length === 0) return null;

	return { cutId, messages };
}

/**
 * Cut-eligibility per pi's compaction.md §Cut Point Rules:
 *   Valid cut points are user messages, assistant messages, bashExecution,
 *   and custom messages. Never tool results.
 *
 * For our purposes (operating on session entries, not pi's serialized
 * messages), this translates to: message-type entries where the message
 * isn't a user-role with tool_result content blocks.
 */
function isValidCutEntry(entry: Record<string, unknown>): boolean {
	if (entry.type !== "message") return false;
	const message = entry.message as Record<string, unknown> | undefined;
	if (!message) return false;
	const role = message.role as string | undefined;
	// Pi's session format uses role: "toolResult" directly for tool result
	// messages — those cannot be cut points per compaction.md §Cut Point Rules.
	if (role === "toolResult") return false;
	// Older / API-style shape: user messages containing tool_result content
	// blocks also can't be cut points.
	if (role === "user" && Array.isArray(message.content)) {
		for (const block of message.content as Array<Record<string, unknown>>) {
			if (block && (block.type === "tool_result" || block.tool_result)) return false;
		}
	}
	return role === "user" || role === "assistant";
}

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

interface Buckets {
	toSummarize: unknown[];
	toKeep: unknown[];
	toDrop: unknown[];
}

function bucketByMark(messages: unknown[], selection: CtxCtrlSelection): Buckets {
	const buckets: Buckets = { toSummarize: [], toKeep: [], toDrop: [] };
	for (const msg of messages) {
		const text = extractTextContent(msg);
		const hash = contentHash(text);
		const { mark } = effectiveMark(selection, hash);
		switch (mark) {
			case "keep":
				buckets.toKeep.push(msg);
				break;
			case "summarize":
				buckets.toSummarize.push(msg);
				break;
			case "drop":
				buckets.toDrop.push(msg);
				break;
		}
	}
	return buckets;
}

// ---------------------------------------------------------------------------
// Summary composition
// ---------------------------------------------------------------------------

function combineInstructions(userInstructions: string, eventInstructions: string | null): string {
	const parts: string[] = [];
	if (eventInstructions && eventInstructions.trim().length > 0) parts.push(eventInstructions);
	if (userInstructions && userInstructions.trim().length > 0) parts.push(userInstructions);
	return parts.join("\n\n");
}

function composeNoOpSummary(previousSummary: string | null, buckets: Buckets): string {
	const counts = `${buckets.toKeep.length} kept, ${buckets.toDrop.length} dropped`;
	const note = `_ctx-ctrl: every pre-cut message was explicitly marked Keep or Drop (${counts}); no narrative summary was generated. To get a summary, mark at least one entry as Summarize or change the default mark to Summarize via the browser UI._`;
	if (previousSummary && previousSummary.trim().length > 0) {
		return `${previousSummary}\n\n${note}`;
	}
	return note;
}

function appendPreservedExcerpts(summary: string, kept: unknown[]): string {
	if (kept.length === 0) return summary;
	const serialized = serializeConversation(
		convertToLlm(kept as Parameters<typeof convertToLlm>[0]),
	);
	return `${summary.trimEnd()}\n\n## Preserved excerpts (marked Keep by user)\n\n${serialized}\n`;
}

