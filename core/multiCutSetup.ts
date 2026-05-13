/**
 * Setup-callback factory for multi-cut compaction (Approach D).
 *
 * Returns the closure passed to `ctx.newSession({ setup, ... })`. Walks the
 * original branch and reconstructs it on the new session manager. The
 * classification (S / K / D / skip / preserve / fold) is shared with
 * `findSRuns` — see core/branchWalk.ts.
 *
 * Pi auto-emits `model_change` and `thinking_level_change` at session
 * creation, so we deliberately don't replay them here — that would produce
 * duplicate bookkeeping. Mid-session model changes are lost in v1.
 *
 * Stale-ctx warning: this closure runs INSIDE `ctx.newSession`'s await.
 * Touch only `sm` and pre-captured args — outer `ctx` is being invalidated.
 */

import type {
	SessionEntry,
	SessionManager,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { classifyBranchEntry, wrapSummaryAsMessage } from "./branchWalk.js";
import { contentHash } from "./hash.js";
import { runHash } from "./runs.js";
import { clearSMarks } from "./selection.js";
import type { CtxCtrlSelection } from "../shared/types.js";

type SessionMessage = SessionMessageEntry["message"];
type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];

export interface BuildSetupArgs {
	origBranch: SessionEntry[];
	origSelection: CtxCtrlSelection;
	/** Pre-computed summaries keyed by runHash. */
	summaries: Map<string, string>;
	/** customType for ctx-ctrl's selection persistence entries. */
	ctxCtrlCustomType: string;
}

export function buildSetup(
	args: BuildSetupArgs,
): (sm: SessionManager) => Promise<void> {
	const { origBranch, origSelection, summaries, ctxCtrlCustomType } = args;

	return async (sm: SessionManager): Promise<void> => {
		let pendingMessages: SessionMessage[] = [];
		let pendingHashes: string[] = [];

		const flushRun = (): void => {
			if (pendingMessages.length === 0) return;
			const rh = runHash(pendingHashes);
			const summary =
				summaries.get(rh) ??
				"(ctx-ctrl: summary missing for this run — see extension logs)";
			sm.branchWithSummary(
				sm.getLeafId(),
				summary,
				{
					source: "ctx-ctrl",
					runHash: rh,
					summarizedCount: pendingMessages.length,
				},
				true,
			);
			pendingMessages = [];
			pendingHashes = [];
		};

		for (const entry of origBranch) {
			const cls = classifyBranchEntry(
				entry as unknown as Record<string, unknown>,
				origSelection,
			);
			switch (cls.kind) {
				case "skip":
					continue;
				case "drop":
					flushRun();
					continue;
				case "append-message":
					flushRun();
					// SessionMessageEntry.message at runtime is always one of
					// the appendMessage-accepted variants; the typesystem's
					// AgentMessage union is wider for BranchSummaryMessage /
					// CompactionSummaryMessage which are their own entry types.
					sm.appendMessage(cls.message as AppendableMessage);
					continue;
				case "preserve-summary":
					flushRun();
					sm.branchWithSummary(
						sm.getLeafId(),
						cls.summaryText,
						{
							source:
								cls.entryType === "compaction"
									? "ctx-ctrl-preserved-compaction"
									: "ctx-ctrl-preserved-branch-summary",
							originalId: cls.originalId,
						},
						true,
					);
					continue;
				case "fold-message":
					pendingMessages.push(cls.message as SessionMessage);
					pendingHashes.push(cls.hash);
					continue;
				case "fold-summary":
					pendingMessages.push(
						wrapSummaryAsMessage(cls.summaryText) as unknown as SessionMessage,
					);
					pendingHashes.push(contentHash(cls.summaryText));
					continue;
			}
		}
		flushRun();

		// Carry over the user's selection minus S-marks. S-marked messages no
		// longer exist on the new branch (they live inside branch_summary
		// entries); K and D marks survive because the rebuild re-appends with
		// the same contentHash.
		sm.appendCustomEntry(ctxCtrlCustomType, clearSMarks(origSelection));
	};
}
