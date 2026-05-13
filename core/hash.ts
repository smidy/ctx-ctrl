/**
 * Content hashing for join-key stability across the session entry / context
 * event boundary.
 *
 * The `context` event exposes messages without stable session entry IDs (see
 * docs note in shared/types.ts). Hashing also survives entry-ID rotation
 * across compaction.
 *
 * Algorithm: djb2 over UTF-16 code units of the first HASH_INPUT_LIMIT
 * characters, concatenated with the total content length. Cheap, deterministic,
 * good enough for matching within one session.
 *
 * NOT a cryptographic hash. Never use this for anything security-relevant.
 */

const HASH_INPUT_LIMIT = 2048;

/**
 * Stable hash key for a `compaction` or `branch_summary` session entry.
 *
 * These entries don't carry a `message` field, so contentHash on the entry
 * directly would collide across distinct summaries with similar prefixes.
 * Mixing the entry type + id + summary text in produces a unique-per-entry
 * key that snapshot.ts, runs.ts, and multiCutSetup.ts all share.
 *
 * NEVER change the format — existing selection.marks entries reference it.
 */
export function summaryEntryHash(
	type: "compaction" | "branch_summary",
	entryId: string,
	summary: string,
): string {
	const prefix = type === "compaction" ? "compaction" : "branch";
	return contentHash(`${prefix}:${entryId}:${summary}`);
}

export function contentHash(content: string): string {
	const sliced = content.length > HASH_INPUT_LIMIT ? content.slice(0, HASH_INPUT_LIMIT) : content;
	let hash = 5381;
	for (let i = 0; i < sliced.length; i++) {
		hash = ((hash << 5) + hash + sliced.charCodeAt(i)) | 0;
	}
	// Unsigned 32-bit + total length suffix avoids trivial collisions on
	// "same first 2k chars but different length" pairs.
	const hex = (hash >>> 0).toString(16).padStart(8, "0");
	return `${hex}-${content.length.toString(16)}`;
}

/**
 * Extract canonical text content from an unknown message-shaped value for
 * hashing. Walks the shapes used by pi's AgentMessage / SessionMessageEntry.
 *
 * Defensive about field presence — pi emits several message shapes and we
 * want stable behavior across all of them. Unknown shapes return the empty
 * string (hash will collide for empty content, but those entries are
 * uninteresting for marks anyway).
 */
export function extractTextContent(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const m = message as Record<string, unknown>;

	// Shape 1: `content` is a string (some custom message kinds)
	if (typeof m.content === "string") return m.content;

	// Shape 2: `content` is an array of typed parts (user/assistant)
	if (Array.isArray(m.content)) {
		const parts: string[] = [];
		for (const part of m.content) {
			if (!part || typeof part !== "object") continue;
			const p = part as Record<string, unknown>;
			if (typeof p.text === "string") parts.push(p.text);
			else if (typeof p.thinking === "string") parts.push(p.thinking);
			else if (p.type === "tool_use" && typeof p.name === "string") {
				const input = typeof p.input === "object" ? JSON.stringify(p.input) : String(p.input ?? "");
				parts.push(`[tool_use:${p.name}] ${input}`);
			} else if (p.type === "tool_result") {
				if (typeof p.content === "string") parts.push(p.content);
				else if (Array.isArray(p.content)) {
					for (const c of p.content) {
						if (c && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string") {
							parts.push((c as Record<string, unknown>).text as string);
						}
					}
				}
			}
		}
		return parts.join("\n");
	}

	// Shape 3: bashExecution / custom — fall through to summary
	if (typeof m.summary === "string") return m.summary;
	if (typeof m.text === "string") return m.text;

	return "";
}
