/**
 * ctx-ctrl — Pi extension wiring layer: per-session state, command
 * registration, event subscriptions, WS handler bridge. See
 * docs/plans/multi-cut-compaction.md for the multi-cut fork design.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import {
	buildCustomCompaction,
} from "./core/compactor.js";
import { contentHash, extractTextContent, summaryEntryHash } from "./core/hash.js";
import { buildSetup } from "./core/multiCutSetup.js";
import { generateAllSummaries } from "./core/multiCutSummarize.js";
import { CUSTOM_TYPE, loadFromSession, save } from "./core/persistence.js";
import { findSRuns } from "./core/runs.js";
import { errorMessage } from "./core/util.js";
import {
	applyMark,
	clearMark,
	clearAll,
	effectiveMark,
	gcMarks,
	setActive,
	setInstructions,
	summarizeChanges,
} from "./core/selection.js";
import { createHttpServer, type HttpServerHandle } from "./server/http.js";
import { mintToken } from "./server/auth.js";
import { buildSnapshot, filterToLlmView } from "./server/snapshot.js";
import { createWsLayer, type WsLayer } from "./server/ws.js";
import type { ServerMsg } from "./shared/protocol.js";
import {
	createEmptySelection,
	type CtxCtrlSelection,
	type EntryMark,
} from "./shared/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const CLIENT_HTML_PATH = join(HERE, "client", "index.html");
const CLIENT_JS_PATH = join(HERE, "client", "client.js");
const CLIENT_CSS_PATH = join(HERE, "client", "client.css");

const SNAPSHOT_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function ctxCtrl(pi: ExtensionAPI): void {
	let selection: CtxCtrlSelection = createEmptySelection();
	let httpHandle: HttpServerHandle | null = null;
	let wsLayer: WsLayer | null = null;
	let lastCtx: ExtensionContext | null = null;
	// Command-only ctx needed for ctx.newSession (multi-cut fork). Stays valid
	// until the next session replacement/reload — see SDK
	// agent-session.js:509. Captured every time the /ctx-ctrl command fires;
	// nulled inside the fork's withSession to make multi-cut a single-shot
	// from a single /ctx-ctrl invocation.
	let lastCommandCtx: ExtensionCommandContext | null = null;
	// Re-entry guard for the fork path: WS Apply clicks during an in-flight
	// fork would race. UI also disables the button on compaction_started.
	let forkingNow = false;
	let snapshotTimer: NodeJS.Timeout | null = null;

	const staticAssets = loadStaticAssetsLazy();

	// --- Persistence ---------------------------------------------------------

	const persist = () => {
		try {
			save(pi, selection);
		} catch (err) {
			console.error("[ctx-ctrl] persist failed:", errorMessage(err));
		}
	};

	const rehydrate = (ctx: ExtensionContext) => {
		selection = loadFromSession(ctx);
	};

	// --- Snapshot broadcast --------------------------------------------------

	const computeSnapshot = (ctx: ExtensionContext) =>
		buildSnapshot(ctx, selection, { firstKeptEntryId: null, tokensBefore: null });

	const broadcastSnapshot = () => {
		if (!wsLayer || !lastCtx) return;
		try {
			const snap = computeSnapshot(lastCtx);
			wsLayer.broadcast({ kind: "snapshot", data: snap });
		} catch (err) {
			console.error("[ctx-ctrl] snapshot broadcast failed:", errorMessage(err));
		}
	};

	const broadcastSelection = () => {
		if (!wsLayer) return;
		wsLayer.broadcast({ kind: "selection", data: selection });
	};

	const scheduleSnapshot = () => {
		if (!wsLayer) return;
		if (snapshotTimer) clearTimeout(snapshotTimer);
		snapshotTimer = setTimeout(() => {
			snapshotTimer = null;
			broadcastSnapshot();
		}, SNAPSHOT_DEBOUNCE_MS);
	};

	// --- WS handlers ---------------------------------------------------------

	const wsHandlers = {
		async onMark(hash: string, mark: EntryMark) {
			selection = applyMark(selection, hash, mark);
			persist();
			broadcastSelection();
		},
		async onUnmark(hash: string) {
			selection = clearMark(selection, hash);
			persist();
			broadcastSelection();
		},
		async onSetInstructions(text: string) {
			selection = setInstructions(selection, text);
			persist();
			broadcastSelection();
		},
		async onSetActive(active: boolean) {
			selection = setActive(selection, active);
			persist();
			broadcastSelection();
		},
		async onClear() {
			selection = clearAll();
			persist();
			broadcastSelection();
		},
		async onRequestSnapshot() {
			broadcastSnapshot();
		},
		async onCompactNow() {
			if (!lastCtx) {
				wsLayer?.broadcast({
					kind: "compaction_finished",
					ok: false,
					error: "No active session context",
				});
				return;
			}

			// Path selection: multi-cut fork when active + at least one S mark
			// exists; otherwise fall through to pi's native single-cut path
			// (still honours K/D marks via session_before_compact + the
			// `context` hook in this file).
			const hasSMarks = Object.values(selection.marks).some((m) => m === "summarize");
			const useFork = selection.active && hasSMarks;

			if (!useFork) {
				wsLayer?.broadcast({ kind: "compaction_started" });
				lastCtx.compact({
					customInstructions: selection.customInstructions || undefined,
					onComplete: () =>
						wsLayer?.broadcast({ kind: "compaction_finished", ok: true }),
					onError: (error: Error) =>
						wsLayer?.broadcast({
							kind: "compaction_finished",
							ok: false,
							error: error.message,
						}),
				});
				return;
			}

			if (forkingNow) return;
			const cmdCtx = lastCommandCtx;
			if (!cmdCtx) {
				wsLayer?.broadcast({
					kind: "compaction_finished",
					ok: false,
					error:
						"Multi-cut requires a /ctx-ctrl invocation — re-run /ctx-ctrl in your terminal to refresh the command context.",
				});
				return;
			}

			forkingNow = true;
			wsLayer?.broadcast({ kind: "compaction_started" });

			try {
				const rawBranch = cmdCtx.sessionManager.getBranch() as unknown as Array<
					Record<string, unknown>
				>;
				const visibleBranch = filterToLlmView(rawBranch);
				const parentSession = cmdCtx.sessionManager.getSessionFile() ?? undefined;

				const runs = findSRuns(visibleBranch, selection);
				if (runs.length === 0) {
					const reason = "No summarize-marked entries on the visible branch.";
					wsLayer?.broadcast({
						kind: "compaction_finished",
						ok: false,
						error: reason,
					});
					cmdCtx.ui.notify(`ctx-ctrl: ${reason}`, "warning");
					return;
				}

				// Generate BEFORE newSession — any LLM failure aborts cleanly
				// with the original session intact (§9 anti #6).
				const summaries = await generateAllSummaries({
					runs,
					ctx: cmdCtx,
					signal: undefined,
					customInstructions: selection.customInstructions || "",
					onProgress: (p) => {
						const msg: ServerMsg = {
							kind: "compaction_progress",
							runIndex: p.runIndex,
							totalRuns: p.totalRuns,
							runHash: p.runHash,
							status: p.status,
							...(p.error !== undefined ? { error: p.error } : {}),
						};
						wsLayer?.broadcast(msg);
					},
				});

				const setup = buildSetup({
					origBranch: visibleBranch as unknown as SessionEntry[],
					origSelection: selection,
					summaries,
					ctxCtrlCustomType: CUSTOM_TYPE,
				});

				const layerForFinish = wsLayer;

				await cmdCtx.newSession({
					parentSession,
					setup,
					withSession: async (newCtx) => {
						// Single-shot: a second Apply must come from a fresh
						// /ctx-ctrl invocation per SDK stale-ctx rule.
						lastCommandCtx = null;

						// session_start fires INSIDE createRuntime, BEFORE
						// `setup` (agent-session-runtime.js:154-163). Its
						// snapshot is of an empty branch — re-broadcast now
						// that setup has populated the new branch.
						lastCtx = newCtx;
						selection = loadFromSession(newCtx);

						newCtx.ui.notify(
							"ctx-ctrl: multi-cut compaction applied",
							"info",
						);

						try {
							const snap = buildSnapshot(newCtx, selection, {
								firstKeptEntryId: null,
								tokensBefore: null,
							});
							layerForFinish?.broadcast({
								kind: "snapshot",
								data: snap,
							});
						} catch (err) {
							console.error(
								"[ctx-ctrl] post-fork snapshot failed:",
								errorMessage(err),
							);
						}
						layerForFinish?.broadcast({
							kind: "compaction_finished",
							ok: true,
						});
					},
				});
			} catch (err) {
				const errMsg = errorMessage(err);
				wsLayer?.broadcast({
					kind: "compaction_finished",
					ok: false,
					error: errMsg,
				});
				// cmdCtx still valid: no successful replacement → no invalidate.
				cmdCtx.ui.notify(`ctx-ctrl: compaction failed — ${errMsg}`, "error");
			} finally {
				forkingNow = false;
			}
		},
	};

	// --- Server lifecycle ----------------------------------------------------

	const ensureServer = async (ctx: ExtensionContext): Promise<HttpServerHandle> => {
		if (httpHandle) return httpHandle;

		const token = mintToken();
		const layer = createWsLayer(wsHandlers);
		const assets = staticAssets.get();

		httpHandle = await createHttpServer({
			token,
			wsServer: layer.server,
			getIndexHtml: () => assets.html.replace(/__TOKEN__/g, token),
			clientJs: assets.js,
			clientCss: assets.css,
		});
		wsLayer = layer;
		lastCtx = ctx;
		return httpHandle;
	};

	const stopServer = async () => {
		if (snapshotTimer) {
			clearTimeout(snapshotTimer);
			snapshotTimer = null;
		}
		if (wsLayer) {
			wsLayer.closeAll();
			wsLayer = null;
		}
		if (httpHandle) {
			await httpHandle.close();
			httpHandle = null;
		}
	};

	// --- Commands ------------------------------------------------------------

	pi.registerCommand("ctx-ctrl", {
		description: "Open the browser UI for selective compaction",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const flag = (args || "").trim().toLowerCase();

			if (flag === "--help" || flag === "-h") {
				ctx.ui.notify(helpText(), "info");
				return;
			}

			if (flag === "--status") {
				const status = httpHandle
					? `running at ${httpHandle.url}`
					: "stopped";
				const sel = selection.active
					? `marks ${summarizeChanges(selection)}`
					: "inactive";
				ctx.ui.notify(`ctx-ctrl: ${status} · ${sel}`, "info");
				return;
			}

			if (flag === "--stop") {
				await stopServer();
				ctx.ui.notify("ctx-ctrl: server stopped", "info");
				return;
			}

			if (flag === "--clear") {
				selection = clearAll();
				persist();
				broadcastSelection();
				ctx.ui.notify("ctx-ctrl: all marks cleared", "info");
				return;
			}

			if (flag === "--toggle") {
				selection = setActive(selection, !selection.active);
				persist();
				broadcastSelection();
				ctx.ui.notify(
					`ctx-ctrl: ${selection.active ? "active" : "inactive"}`,
					"info",
				);
				return;
			}

			if (flag === "--compact-now") {
				// Routes through wsHandlers.onCompactNow for one code path.
				lastCtx = ctx;
				lastCommandCtx = ctx;
				ctx.ui.notify("ctx-ctrl: starting compaction…", "info");
				await wsHandlers.onCompactNow();
				return;
			}

			// Default: open the browser UI.
			if (!ctx.hasUI) {
				ctx.ui.notify(
					"ctx-ctrl requires interactive mode (no UI in print/json modes).",
					"error",
				);
				return;
			}

			lastCtx = ctx;
			lastCommandCtx = ctx;
			const skipAutoOpen = flag === "--no-open";

			try {
				const handle = await ensureServer(ctx);
				ctx.ui.notify(`Open ctx-ctrl at ${handle.url}`, "info");
				broadcastSnapshot();
				if (!skipAutoOpen) {
					openUrlInDefaultBrowser(handle.url).catch((err) => {
						ctx.ui.notify(
							`ctx-ctrl: could not auto-open browser (${errorMessage(err)}) — open the URL manually`,
							"warning",
						);
					});
				}
			} catch (err) {
				ctx.ui.notify(`ctx-ctrl failed to start: ${errorMessage(err)}`, "error");
			}
		},
	});

	// --- Event subscriptions -------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		rehydrate(ctx);
		lastCtx = ctx;
		broadcastSnapshot();
	});

	pi.on("message_end", async (_event, ctx) => {
		lastCtx = ctx;
		scheduleSnapshot();
	});

	pi.on("turn_end", async (_event, ctx) => {
		lastCtx = ctx;
		scheduleSnapshot();
	});

	pi.on("session_before_compact", async (event, ctx) => {
		lastCtx = ctx;
		if (!selection.active) return; // fall through to pi default

		try {
			const result = await buildCustomCompaction(
				{
					messagesToSummarize: event.preparation.messagesToSummarize as unknown[],
					turnPrefixMessages:
						(event.preparation as { turnPrefixMessages?: unknown[] }).turnPrefixMessages ?? [],
					previousSummary: event.preparation.previousSummary ?? null,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					eventCustomInstructions: event.customInstructions ?? null,
					branchEntries: (event.branchEntries ?? []) as unknown[],
				},
				selection,
				ctx,
				event.signal,
			);
			if (result === null) {
				// Nothing meaningful for us to do — let pi run its default path.
				return;
			}
			return {
				compaction: {
					summary: result.summary,
					firstKeptEntryId: result.firstKeptEntryId,
					tokensBefore: result.tokensBefore,
					details: result.details,
				},
			};
		} catch (err) {
			console.error("[ctx-ctrl] custom compaction failed:", errorMessage(err));
			ctx.ui.notify(
				`ctx-ctrl: selective compaction failed, falling back to default — ${errorMessage(err)}`,
				"warning",
			);
			// Returning undefined lets pi run its default compaction.
			return;
		}
	});

	pi.on("context", async (event) => {
		if (!selection.active) return;

		const dropHashes = new Set<string>();
		for (const [hash, mark] of Object.entries(selection.marks)) {
			if (mark === "drop") dropHashes.add(hash);
		}
		if (dropHashes.size === 0) return;

		const filtered = (event.messages as unknown[]).filter((msg) => {
			const text = extractTextContent(msg);
			const hash = contentHash(text);
			return !dropHashes.has(hash);
		});

		if (filtered.length === (event.messages as unknown[]).length) return;
		return { messages: filtered as typeof event.messages };
	});

	pi.on("session_compact", async (_event, ctx) => {
		lastCtx = ctx;

		// GC marks whose content is no longer in the LLM-visible view. Pre-cut
		// entries are still physically on the branch but their marks are now
		// orphans — the user can no longer see those rows to unmark them.
		const branch = ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>;
		const visible = filterToLlmView(branch);
		const liveHashes = new Set<string>();
		for (const entry of visible) {
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				const summary = typeof entry.summary === "string" ? entry.summary : "";
				if (summary) {
					liveHashes.add(
						summaryEntryHash(
							entry.type as "compaction" | "branch_summary",
							(entry.id as string) ?? "",
							summary,
						),
					);
				}
				continue;
			}
			const text = extractTextContent(entry.message ?? entry);
			if (text) liveHashes.add(contentHash(text));
		}
		const { selection: next, removed } = gcMarks(selection, liveHashes);
		if (removed > 0) {
			selection = next;
			persist();
			broadcastSelection();
		}
		broadcastSnapshot();
	});

	pi.on("session_shutdown", async (event) => {
		// SessionShutdownEvent.reason distinguishes process-level shutdown
		// (`quit`, `reload`) from session REPLACEMENT (`new` from
		// ctx.newSession, `fork` from ctx.fork, `resume` from switching
		// sessions). The extension closure — and the HTTP/WS server it owns
		// — persists across replacements, so killing the server on `new` /
		// `fork` / `resume` would yank it out from under a still-connected
		// browser. Only tear down when the process or the extension itself
		// is going away.
		if (event.reason === "quit" || event.reason === "reload") {
			await stopServer();
			return;
		}
		// Replacement (`new` / `fork` / `resume`): keep the server alive but
		// null out captured ctxs so any pending snapshot timer or
		// late-firing turn_end handler doesn't call methods on the now-
		// stale ctx. session_start will set lastCtx to the fresh ctx and
		// resume broadcasts.
		if (snapshotTimer) {
			clearTimeout(snapshotTimer);
			snapshotTimer = null;
		}
		lastCtx = null;
		lastCommandCtx = null;
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StaticAssets {
	html: string;
	js: Buffer;
	css: Buffer;
}

function loadStaticAssetsLazy(): { get(): StaticAssets } {
	let cached: StaticAssets | null = null;
	return {
		get() {
			if (cached) return cached;
			cached = {
				html: readFileSync(CLIENT_HTML_PATH, "utf-8"),
				js: readFileSync(CLIENT_JS_PATH),
				css: readFileSync(CLIENT_CSS_PATH),
			};
			return cached;
		},
	};
}

function helpText(): string {
	return [
		"ctx-ctrl commands:",
		"  /ctx-ctrl               Open the browser UI (auto-launches default browser)",
		"  /ctx-ctrl --no-open     Start the server but don't open a browser tab",
		"  /ctx-ctrl --compact-now Run compaction now (multi-cut if S marks exist, else pi default)",
		"  /ctx-ctrl --status      Show server + selection state",
		"  /ctx-ctrl --stop        Stop the server",
		"  /ctx-ctrl --clear       Wipe all marks",
		"  /ctx-ctrl --toggle      Flip the Active master toggle",
		"  /ctx-ctrl --help        Show this help",
	].join("\n");
}

function openUrlInDefaultBrowser(url: string): Promise<void> {
	const openCommand =
		process.platform === "darwin"
			? { command: "open", args: [url] }
			: process.platform === "win32"
				? { command: "cmd", args: ["/c", "start", "", url] }
				: { command: "xdg-open", args: [url] };

	return new Promise<void>((resolve, reject) => {
		const child = spawn(openCommand.command, openCommand.args, {
			stdio: "ignore",
			detached: true,
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

export { CUSTOM_TYPE as CTX_CTRL_CUSTOM_TYPE } from "./core/persistence.js";
