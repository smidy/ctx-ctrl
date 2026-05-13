/**
 * S-run detection — find contiguous Summarize-marked entries in a branch.
 *
 * Classification (S / K / D / skip) is delegated to `classifyBranchEntry`
 * so the rebuild walk in `multiCutSetup` reaches identical decisions —
 * see core/branchWalk.ts.
 *
 * Tool-call / tool-result pairing (multi-cut §R2, decision D5) is enforced
 * during the rebuild step, NOT here.
 */

import { classifyBranchEntry, wrapSummaryAsMessage } from "./branchWalk.js";
import { contentHash } from "./hash.js";
import type { CtxCtrlSelection } from "../shared/types.js";

export interface SRun {
	startIdx: number;
	endIdx: number;
	/** Stable hash of the ordered member content hashes — summaries-map key. */
	runHash: string;
	sourceEntryIds: string[];
	sourceContentHashes: string[];
	sourceMessages: unknown[];
}

export function findSRuns(
	branchEntries: Array<Record<string, unknown>>,
	selection: CtxCtrlSelection,
): SRun[] {
	if (!Array.isArray(branchEntries) || branchEntries.length === 0) return [];

	const runs: SRun[] = [];
	let current: SRun | null = null;

	const flushCurrent = (): void => {
		if (current && current.sourceMessages.length > 0) {
			current.runHash = runHash(current.sourceContentHashes);
			runs.push(current);
		}
		current = null;
	};

	const fold = (i: number, entryId: string, hash: string, message: unknown): void => {
		if (!current) {
			current = {
				startIdx: i,
				endIdx: i,
				runHash: "",
				sourceEntryIds: [],
				sourceContentHashes: [],
				sourceMessages: [],
			};
		}
		current.endIdx = i;
		current.sourceEntryIds.push(entryId);
		current.sourceContentHashes.push(hash);
		current.sourceMessages.push(message);
	};

	for (let i = 0; i < branchEntries.length; i++) {
		const cls = classifyBranchEntry(branchEntries[i], selection);
		switch (cls.kind) {
			case "skip":
				continue;
			case "fold-message":
				fold(i, cls.entryId, cls.hash, cls.message);
				continue;
			case "fold-summary":
				fold(
					i,
					cls.entryId,
					contentHash(cls.summaryText),
					wrapSummaryAsMessage(cls.summaryText),
				);
				continue;
			case "drop":
			case "append-message":
			case "preserve-summary":
				flushCurrent();
				continue;
		}
	}
	flushCurrent();

	return runs;
}

/** Stable hash of an ordered list of content hashes. Order is part of identity. */
export function runHash(contentHashes: string[]): string {
	return contentHash(contentHashes.join("|"));
}
