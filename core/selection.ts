/**
 * Pure operations over CtxCtrlSelection. No I/O, no pi imports.
 */

import {
	createEmptySelection,
	type CtxCtrlSelection,
	type EntryMark,
} from "../shared/types.js";

export function applyMark(
	selection: CtxCtrlSelection,
	contentHash: string,
	mark: EntryMark,
): CtxCtrlSelection {
	return {
		...selection,
		marks: { ...selection.marks, [contentHash]: mark },
		active: true,
	};
}

export function clearMark(
	selection: CtxCtrlSelection,
	contentHash: string,
): CtxCtrlSelection {
	if (!(contentHash in selection.marks)) return selection;
	const { [contentHash]: _omit, ...rest } = selection.marks;
	return { ...selection, marks: rest };
}

export function setInstructions(
	selection: CtxCtrlSelection,
	customInstructions: string,
): CtxCtrlSelection {
	if (selection.customInstructions === customInstructions) return selection;
	return { ...selection, customInstructions };
}

export function setActive(
	selection: CtxCtrlSelection,
	active: boolean,
): CtxCtrlSelection {
	if (selection.active === active) return selection;
	return { ...selection, active };
}

export function clearAll(): CtxCtrlSelection {
	return createEmptySelection();
}

/**
 * Effective mark for a content hash: explicit > default.
 */
export function effectiveMark(
	selection: CtxCtrlSelection,
	contentHash: string,
): { mark: EntryMark; isExplicit: boolean } {
	if (contentHash in selection.marks) {
		return { mark: selection.marks[contentHash], isExplicit: true };
	}
	return { mark: selection.defaultMark, isExplicit: false };
}

/**
 * Drop every "summarize" mark from the selection. Used by multi-cut
 * compaction's fork-and-rebuild path: S-marked messages no longer exist on
 * the new branch (they're inside branch_summary entries), so their marks
 * would be orphans. K and D marks survive because the rebuild re-appends
 * matching message bytes with the same contentHash.
 */
export function clearSMarks(selection: CtxCtrlSelection): CtxCtrlSelection {
	const marks: Record<string, EntryMark> = {};
	let removed = false;
	for (const [hash, mark] of Object.entries(selection.marks)) {
		if (mark === "summarize") {
			removed = true;
			continue;
		}
		marks[hash] = mark;
	}
	if (!removed) return selection;
	return { ...selection, marks };
}

/**
 * Drop marks whose content hash is not in `liveHashes`. Used after a
 * `session_compact` to GC stale marks.
 */
export function gcMarks(
	selection: CtxCtrlSelection,
	liveHashes: ReadonlySet<string>,
): { selection: CtxCtrlSelection; removed: number } {
	let removed = 0;
	const next: Record<string, EntryMark> = {};
	for (const [hash, mark] of Object.entries(selection.marks)) {
		if (liveHashes.has(hash)) next[hash] = mark;
		else removed++;
	}
	if (removed === 0) return { selection, removed: 0 };
	return { selection: { ...selection, marks: next }, removed };
}

export function summarizeChanges(selection: CtxCtrlSelection): string {
	const buckets: Record<EntryMark, number> = { keep: 0, summarize: 0, drop: 0 };
	for (const mark of Object.values(selection.marks)) buckets[mark]++;
	const parts: string[] = [];
	if (buckets.keep) parts.push(`${buckets.keep} keep`);
	if (buckets.summarize) parts.push(`${buckets.summarize} summarize`);
	if (buckets.drop) parts.push(`${buckets.drop} drop`);
	return parts.length === 0 ? "no marks" : parts.join(", ");
}
