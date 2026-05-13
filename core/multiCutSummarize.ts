/**
 * Per-run summary generation, called BEFORE `ctx.newSession` so any LLM
 * failure aborts cleanly with the original session untouched (§9 anti #6).
 *
 * Sequential (not parallel): one provider, parallel fan-out risks rate-limit
 * storms and complicates abort propagation.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SRun } from "./runs.js";
import { runSummarizer } from "./summarizer.js";
import { errorMessage } from "./util.js";

export interface SummaryProgress {
	/** 0-based index into the runs array. */
	runIndex: number;
	totalRuns: number;
	runHash: string;
	status: "started" | "complete" | "failed";
	/** Populated only when status === "failed". */
	error?: string;
}

export interface GenerateAllSummariesArgs {
	runs: SRun[];
	ctx: ExtensionContext;
	signal: AbortSignal | undefined;
	/** Free-form summarizer instructions (selection.customInstructions). */
	customInstructions: string;
	/** Optional progress callback — caller wires to WS broadcast (step 8). */
	onProgress?: (progress: SummaryProgress) => void;
}

/**
 * Throws on first failure — caller MUST NOT then call `ctx.newSession`.
 */
export async function generateAllSummaries(
	args: GenerateAllSummariesArgs,
): Promise<Map<string, string>> {
	const { runs, ctx, signal, customInstructions, onProgress } = args;
	const summaries = new Map<string, string>();

	for (let i = 0; i < runs.length; i++) {
		const run = runs[i];

		onProgress?.({
			runIndex: i,
			totalRuns: runs.length,
			runHash: run.runHash,
			status: "started",
		});

		try {
			// previousSummary: null — each S-run is independent. Chaining
			// would conflate distinct pre-cut segments.
			const summary = await runSummarizer({
				messages: run.sourceMessages,
				previousSummary: null,
				customInstructions,
				ctx,
				signal,
			});
			summaries.set(run.runHash, summary);

			onProgress?.({
				runIndex: i,
				totalRuns: runs.length,
				runHash: run.runHash,
				status: "complete",
			});
		} catch (err) {
			onProgress?.({
				runIndex: i,
				totalRuns: runs.length,
				runHash: run.runHash,
				status: "failed",
				error: errorMessage(err),
			});
			throw err;
		}
	}

	return summaries;
}
