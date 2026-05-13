/**
 * Build a SessionSnapshot from the current pi session for the browser UI.
 *
 * Walks `ctx.sessionManager.getEntries()` and projects each entry to an
 * EntryDTO. Skips bookkeeping entries (model_change, label, session_info, etc.)
 * because they have no narrative meaning to the user marking compaction.
 */

import {
	type CompactionEntry,
	type ExtensionContext,
	getLatestCompactionEntry,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { contentHash, extractTextContent, summaryEntryHash } from "../core/hash.js";
import { effectiveMark } from "../core/selection.js";
import type {
	ContextUsageDTO,
	CtxCtrlSelection,
	CutSuggestionDTO,
	EntryDTO,
	SessionSnapshot,
} from "../shared/types.js";

const SERVER_VERSION = "0.1.0";

const PREVIEW_LIMIT = 400;

export function buildSnapshot(
	ctx: ExtensionContext,
	selection: CtxCtrlSelection,
	cutSuggestion: CutSuggestionDTO = { firstKeptEntryId: null, tokensBefore: null },
): SessionSnapshot {
	// getBranch() returns the full ancestry chain — pre-cut entries are still
	// physically on the branch even after compaction (the file keeps them, only
	// the LLM context skips past them via firstKeptEntryId). To mirror the LLM's
	// view, we filter past the latest compaction's firstKeptEntryId and hoist
	// the compaction entry to the top of the visible list.
	const rawBranch = ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>;
	const visibleBranch = filterToLlmView(rawBranch);
	const entries = projectEntries(visibleBranch, selection, cutSuggestion);

	const usage = readContextUsage(ctx);

	return {
		sessionId: safeSessionFile(ctx) ?? "ephemeral",
		cwd: ctx.cwd,
		entries,
		selection,
		contextUsage: usage,
		cutSuggestion,
		snapshotAt: Date.now(),
		serverVersion: SERVER_VERSION,
	};
}

// ---------------------------------------------------------------------------
// Branch-to-LLM-view filter
// ---------------------------------------------------------------------------

/**
 * Reduce a raw branch chain to the LLM-visible subset: drop pre-cut entries
 * and hoist the latest compaction to the front so it visually stands in for
 * the compacted span. No compaction → return as-is.
 */
export function filterToLlmView(
	branch: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	if (!Array.isArray(branch) || branch.length === 0) return branch;

	const compaction = getLatestCompactionEntry(branch as unknown as SessionEntry[]) as
		| CompactionEntry
		| null;
	if (!compaction?.firstKeptEntryId) return branch;

	const firstKeptIdx = branch.findIndex((e) => e && e.id === compaction.firstKeptEntryId);
	if (firstKeptIdx === -1) return branch;

	const postCut = branch.slice(firstKeptIdx).filter((e) => e && e.id !== compaction.id);
	return [compaction as unknown as Record<string, unknown>, ...postCut];
}

// ---------------------------------------------------------------------------
// Entry projection
// ---------------------------------------------------------------------------

function projectEntries(
	entries: Array<Record<string, unknown>>,
	selection: CtxCtrlSelection,
	_cut: CutSuggestionDTO,
): EntryDTO[] {
	const out: EntryDTO[] = [];
	let turnIndex = 0;

	for (const entry of entries) {
		const type = entry.type as string | undefined;
		switch (type) {
			case "message": {
				const projected = projectMessageEntry(entry, turnIndex);
				if (projected) {
					for (const dto of projected) {
						out.push(decorate(dto, selection));
					}
				}
				// Bump turn after each assistant batch — keeps user→assistant in one turn.
				const role = (entry.message as Record<string, unknown> | undefined)?.role;
				if (role === "assistant") turnIndex++;
				break;
			}
			case "compaction": {
				const dto = projectSummaryEntry(entry, turnIndex, "compaction");
				if (dto) out.push(decorate(dto, selection));
				break;
			}
			case "branch_summary": {
				const dto = projectSummaryEntry(entry, turnIndex, "branch_summary");
				if (dto) out.push(decorate(dto, selection));
				break;
			}
			default:
				continue;
		}
	}

	return out;
}

function decorate(dto: EntryDTO, selection: CtxCtrlSelection): EntryDTO {
	const { mark, isExplicit } = effectiveMark(selection, dto.contentHash);
	return { ...dto, mark, isExplicit };
}

function projectMessageEntry(
	entry: Record<string, unknown>,
	turnIndex: number,
): EntryDTO[] | null {
	const message = entry.message as Record<string, unknown> | undefined;
	if (!message) return null;

	const entryId = (entry.id as string) ?? "";
	const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : Date.now();
	const role = (message.role as string) || "other";
	// CRITICAL: hash MUST match what core/compactor.ts computes on the
	// corresponding AgentMessage at compaction time. Both paths call
	// `extractTextContent(message)` on the WHOLE message — splitting a
	// message into sub-rows would produce hashes that the compactor lookup
	// can't match.
	const text = extractTextContent(message);
	if (text.trim().length === 0) return null;

	// Pi's session format uses role: "toolResult" directly. Older / API-style
	// shape nests tool_result content blocks in a user-role message. Detect
	// both so we map the entry correctly regardless of shape.
	const isToolResultRole = role === "toolResult";
	const isLegacyToolResultUser =
		role === "user" &&
		Array.isArray(message.content) &&
		(message.content as Array<Record<string, unknown>>).some(
			(b) => b && (b.type === "tool_result" || b.tool_result),
		);
	const isToolResultMessage = isToolResultRole || isLegacyToolResultUser;

	// Pi's assistant messages embed tool calls as content blocks of type
	// "toolCall" (camelCase) — distinct from the API-style top-level
	// `tool_calls` array. Detect both.
	const hasTopLevelToolCalls =
		Array.isArray(message.tool_calls) && (message.tool_calls as unknown[]).length > 0;
	const inlineToolCalls = Array.isArray(message.content)
		? (message.content as Array<Record<string, unknown>>).filter(
				(b) => b && (b.type === "toolCall" || b.type === "tool_use"),
			)
		: [];
	const hasToolCalls = hasTopLevelToolCalls || inlineToolCalls.length > 0;

	let mappedRole: EntryDTO["role"];
	let toolName: string | undefined;
	let preview: string;

	if (isToolResultMessage) {
		mappedRole = "toolResult";
		if (isToolResultRole) {
			toolName = (message.toolName as string) || (message.toolCallId as string) || undefined;
		} else {
			const firstResult = (message.content as Array<Record<string, unknown>>).find(
				(b) => b && (b.type === "tool_result" || b.tool_result),
			);
			if (firstResult) {
				const tr = (firstResult.tool_result || firstResult) as Record<string, unknown>;
				toolName = (tr.tool_use_id as string) || (tr.id as string) || undefined;
			}
		}
		preview = makePreview(text);
	} else if (role === "assistant" && hasToolCalls) {
		mappedRole = "assistant";
		const first = hasTopLevelToolCalls
			? (message.tool_calls as Array<Record<string, unknown>>)[0]
			: inlineToolCalls[0];
		const fn = first.function as Record<string, unknown> | undefined;
		toolName = (fn?.name as string) || (first.name as string) || "tool";
		const callCount = hasTopLevelToolCalls
			? (message.tool_calls as unknown[]).length
			: inlineToolCalls.length;
		const toolSuffix = callCount > 1 ? ` (+${callCount - 1} more)` : "";
		preview = `${makePreview(text)}\n— Tool call: ${toolName}${toolSuffix}`;
	} else if (role === "user") {
		mappedRole = "user";
		preview = makePreview(text);
	} else if (role === "assistant") {
		mappedRole = "assistant";
		preview = makePreview(text);
	} else {
		mappedRole = "other";
		preview = makePreview(text);
	}

	// Tool-result messages cannot be cut points (pi compaction §Cut Point
	// Rules). They're still valid mark targets at the entry level.
	const cutEligible = !isToolResultMessage;

	return [
		{
			entryId,
			contentHash: contentHash(text),
			role: mappedRole,
			turnIndex,
			timestamp,
			preview,
			fullContent: text,
			totalChars: text.length,
			toolName,
			mark: "summarize",
			isExplicit: false,
			cutEligible,
		},
	];
}

function projectSummaryEntry(
	entry: Record<string, unknown>,
	turnIndex: number,
	role: "compaction" | "branch_summary",
): EntryDTO | null {
	const summary = typeof entry.summary === "string" ? entry.summary : "";
	if (summary.length === 0) return null;
	const entryId = (entry.id as string) ?? "";
	const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : Date.now();
	return {
		entryId,
		contentHash: summaryEntryHash(role, entryId, summary),
		role,
		turnIndex,
		timestamp,
		preview: makePreview(summary),
		fullContent: summary,
		totalChars: summary.length,
		mark: "summarize",
		isExplicit: false,
		cutEligible: false,
	};
}

// ---------------------------------------------------------------------------
// Context usage + misc
// ---------------------------------------------------------------------------

function readContextUsage(ctx: ExtensionContext): ContextUsageDTO {
	try {
		const u = ctx.getContextUsage?.();
		if (!u) return { tokens: null, contextWindow: null, percent: null };
		return {
			tokens: typeof u.tokens === "number" ? u.tokens : null,
			contextWindow: typeof u.contextWindow === "number" ? u.contextWindow : null,
			percent: typeof u.percent === "number" ? u.percent : null,
		};
	} catch {
		return { tokens: null, contextWindow: null, percent: null };
	}
}

function safeSessionFile(ctx: ExtensionContext): string | null {
	try {
		return ctx.sessionManager.getSessionFile?.() ?? null;
	} catch {
		return null;
	}
}

function makePreview(text: string): string {
	const trimmed = text.trim();
	return trimmed.length <= PREVIEW_LIMIT ? trimmed : `${trimmed.slice(0, PREVIEW_LIMIT)}…`;
}
