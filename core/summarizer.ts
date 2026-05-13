/**
 * Thin wrapper around pi's exported `generateSummary` so the rest of the
 * codebase doesn't depend on internal SDK shape directly.
 *
 * `generateSummary` produces the standard pi summary structure:
 *   ## Goal / ## Constraints / ## Progress / ## Key Decisions / ## Next Steps
 *   <read-files> / <modified-files>
 *
 * We append a "Preserved excerpts" section in compactor.ts when KEEP marks
 * are present, so this module stays pure.
 */

import {
	DEFAULT_COMPACTION_SETTINGS,
	generateSummary,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface RunSummarizerArgs {
	/** Messages to fold into the summary. Already filtered for selection. */
	messages: unknown[];
	/** Previous compaction summary, when iterating. */
	previousSummary: string | null;
	/** Free-form user instructions appended to the summarizer prompt. */
	customInstructions: string;
	ctx: ExtensionContext;
	signal: AbortSignal | undefined;
}

export async function runSummarizer(args: RunSummarizerArgs): Promise<string> {
	const { messages, previousSummary, customInstructions, ctx, signal } = args;

	const model = ctx.model;
	if (!model) {
		throw new Error("ctx-ctrl: no model available for summarization");
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error("ctx-ctrl: missing API key for current model");
	}

	const reserveTokens = DEFAULT_COMPACTION_SETTINGS.reserveTokens;

	return generateSummary(
		messages as Parameters<typeof generateSummary>[0],
		model,
		reserveTokens,
		auth.apiKey,
		auth.headers,
		signal,
		customInstructions || undefined,
		previousSummary || undefined,
	);
}
