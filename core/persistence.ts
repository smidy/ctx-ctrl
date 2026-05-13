/**
 * Persistence of CtxCtrlSelection across pi restarts via pi.appendEntry.
 *
 * On session_start: walk entries backwards, find most recent custom entry
 * with customType === CUSTOM_TYPE, restore. If none, return empty selection.
 *
 * On every selection mutation: append a new entry. Older entries become
 * historical; only the latest is read.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createEmptySelection, type CtxCtrlSelection } from "../shared/types.js";

export const CUSTOM_TYPE = "ctx-ctrl-selection";

export function loadFromSession(ctx: ExtensionContext): CtxCtrlSelection {
	const entries = ctx.sessionManager.getEntries() as unknown as Array<Record<string, unknown>>;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
			return normalize(entry.data);
		}
	}
	return createEmptySelection();
}

export function save(pi: ExtensionAPI, selection: CtxCtrlSelection): void {
	pi.appendEntry(CUSTOM_TYPE, selection);
}

/**
 * Normalize an unknown persisted shape to a valid CtxCtrlSelection. Drops
 * unrecognized fields. Fills in defaults for missing fields. Used to
 * tolerate older schema versions in long-lived sessions.
 */
function normalize(raw: unknown): CtxCtrlSelection {
	const base = createEmptySelection();
	if (!raw || typeof raw !== "object") return base;
	const obj = raw as Record<string, unknown>;
	const marks: Record<string, "keep" | "summarize" | "drop"> = {};
	if (obj.marks && typeof obj.marks === "object") {
		for (const [k, v] of Object.entries(obj.marks)) {
			if (v === "keep" || v === "summarize" || v === "drop") marks[k] = v;
		}
	}
	// D1: defaultMark is always "keep" — discard any persisted value from
	// older sessions that may have stored "summarize" or "drop".
	const customInstructions = typeof obj.customInstructions === "string" ? obj.customInstructions : "";
	const active = typeof obj.active === "boolean" ? obj.active : false;
	return { marks, defaultMark: "keep", customInstructions, active, version: 1 };
}
