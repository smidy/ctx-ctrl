// ctx-ctrl browser client — vanilla JS, no framework.
//
// Lifecycle:
//   1. Read token from window.location.search
//   2. Open WebSocket to /ws?token=...
//   3. Receive snapshot/selection/context_usage/compaction_* events from the
//      server. Re-render on each snapshot.
//   4. Send mark/unmark/set_instructions/set_active/clear/
//      request_snapshot/compact_now to the server based on user actions.

const params = new URLSearchParams(window.location.search);
const token = params.get("token") || "";

const els = {
	app: document.getElementById("app"),
	sessionLabel: document.getElementById("session-label"),
	activeToggle: document.getElementById("active-toggle"),
	clearBtn: document.getElementById("clear-btn"),
	instructions: document.getElementById("instructions"),
	entries: document.getElementById("entries"),
	usage: document.getElementById("usage"),
	compactBtn: document.getElementById("compact-btn"),
};

const state = {
	snapshot: null,
	ws: null,
	reconnectTimer: null,
	instructionsDebounce: null,
	// Set of contentHashes whose row is currently expanded (showing fullContent
	// instead of preview). Persists across re-renders within the same tab —
	// reload clears it.
	expanded: new Set(),
};

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function connect() {
	const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = `${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
	const ws = new WebSocket(url);
	state.ws = ws;

	ws.addEventListener("open", () => {
		ws.send(JSON.stringify({ kind: "request_snapshot" }));
	});

	ws.addEventListener("message", (event) => {
		let msg;
		try {
			msg = JSON.parse(event.data);
		} catch (err) {
			console.warn("ctx-ctrl: bad ws payload", err);
			return;
		}
		handleServerMsg(msg);
	});

	ws.addEventListener("close", () => {
		state.ws = null;
		scheduleReconnect();
	});

	ws.addEventListener("error", () => {
		try { ws.close(); } catch (_) {}
	});
}

function scheduleReconnect() {
	if (state.reconnectTimer) return;
	state.reconnectTimer = setTimeout(() => {
		state.reconnectTimer = null;
		connect();
	}, 1500);
}

function send(msg) {
	if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
		toast("Disconnected — change not sent", true);
		return;
	}
	state.ws.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------------------
// Inbound messages
// ---------------------------------------------------------------------------

function applySelectionToEntry(entry, selection) {
	const marks = selection && selection.marks ? selection.marks : {};
	const explicit = Object.prototype.hasOwnProperty.call(marks, entry.contentHash);
	if (explicit) {
		return { ...entry, mark: marks[entry.contentHash], isExplicit: true };
	}
	return {
		...entry,
		mark: (selection && selection.defaultMark) || "keep",
		isExplicit: false,
	};
}

function handleServerMsg(msg) {
	switch (msg.kind) {
		case "snapshot":
			state.snapshot = msg.data;
			render();
			break;
		case "selection":
			if (state.snapshot) {
				state.snapshot.selection = msg.data;
				// Per-entry mark + isExplicit are derived from the selection.
				// Recompute them locally so the UI updates without waiting for
				// a full snapshot rebuild from the server.
				state.snapshot.entries = (state.snapshot.entries || []).map((e) =>
					applySelectionToEntry(e, msg.data),
				);
				render();
			}
			break;
		case "context_usage":
			if (state.snapshot) {
				state.snapshot.contextUsage = msg.data;
				renderUsage();
			}
			break;
		case "compaction_started":
			toast("Compaction running…");
			els.compactBtn.disabled = true;
			break;
		case "compaction_progress":
			// Show per-run progress for multi-cut compaction. "started" fires
			// once per run before its summarizer call; "complete" fires after
			// success; "failed" fires once and is followed by a
			// compaction_finished with ok:false from the server.
			if (msg.status === "started") {
				toast(`Summarizing run ${msg.runIndex + 1}/${msg.totalRuns}…`);
			} else if (msg.status === "failed") {
				toast(`Run ${msg.runIndex + 1} failed: ${msg.error || "unknown"}`, true);
			}
			break;
		case "compaction_finished":
			els.compactBtn.disabled = false;
			toast(msg.ok ? "Compaction complete" : `Compaction failed: ${msg.error || "unknown"}`, !msg.ok);
			break;
		case "error":
			toast(msg.message, true);
			break;
		default:
			console.warn("ctx-ctrl: unknown server msg kind", msg.kind);
	}
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
	if (!state.snapshot) return;
	els.sessionLabel.textContent = state.snapshot.cwd
		? `· ${truncate(state.snapshot.cwd, 60)}`
		: "";

	els.activeToggle.checked = !!state.snapshot.selection.active;
	if (document.activeElement !== els.instructions) {
		els.instructions.value = state.snapshot.selection.customInstructions || "";
	}

	renderEntries();
	renderUsage();
}

function renderEntries() {
	const entries = state.snapshot.entries || [];
	if (entries.length === 0) {
		els.entries.innerHTML = '<p class="empty">No entries in this session yet.</p>';
		return;
	}

	const frag = document.createDocumentFragment();
	const cutId = state.snapshot.cutSuggestion?.firstKeptEntryId || null;
	let cutInserted = !cutId;

	let lastTurn = -1;

	for (const entry of entries) {
		if (cutId && !cutInserted && entry.entryId === cutId) {
			frag.appendChild(makeCutDivider());
			cutInserted = true;
		}
		if (entry.turnIndex !== lastTurn) {
			lastTurn = entry.turnIndex;
		}
		frag.appendChild(makeEntryRow(entry));
	}

	els.entries.replaceChildren(frag);
}

function makeCutDivider() {
	const div = document.createElement("div");
	div.className = "cut-divider";
	div.innerHTML = "<hr/><span>pi suggested compaction cut</span><hr/>";
	return div;
}

function makeEntryRow(entry) {
	const row = document.createElement("div");
	row.className = `entry role-${entry.role} mark-${entry.mark}`;
	row.dataset.hash = entry.contentHash;

	const meta = document.createElement("div");
	meta.className = "meta";
	const role = document.createElement("span");
	role.className = "role";
	role.textContent = `${roleLabel(entry.role)}${entry.toolName ? ` · ${entry.toolName}` : ""}`;
	const turn = document.createElement("span");
	turn.textContent = `turn ${entry.turnIndex + 1}${entry.isExplicit ? "" : " · (default)"}`;
	const size = document.createElement("span");
	size.textContent = `${entry.totalChars.toLocaleString()} chars`;
	meta.appendChild(role);
	meta.appendChild(turn);
	meta.appendChild(size);

	const preview = document.createElement("div");
	preview.className = "preview";
	const isExpanded = state.expanded.has(entry.contentHash);
	const fullText = typeof entry.fullContent === "string" ? entry.fullContent : entry.preview;
	const shortText = entry.preview;
	const canExpand = fullText.length > shortText.length;
	preview.textContent = isExpanded ? fullText : shortText;

	if (canExpand) {
		const toggle = document.createElement("button");
		toggle.type = "button";
		toggle.className = "expand-toggle";
		toggle.textContent = isExpanded
			? "Show less"
			: `Show full (${entry.totalChars.toLocaleString()} chars)`;
		toggle.addEventListener("click", (e) => {
			e.stopPropagation();
			if (state.expanded.has(entry.contentHash)) {
				state.expanded.delete(entry.contentHash);
			} else {
				state.expanded.add(entry.contentHash);
			}
			renderEntries();
		});
		preview.appendChild(document.createElement("br"));
		preview.appendChild(toggle);
	}

	const marks = document.createElement("div");
	marks.className = "marks";
	const markMeta = {
		keep: { label: "Keep", title: "Preserve this entry verbatim — it stays in the conversation after compaction" },
		summarize: { label: "Summarize", title: "Fold this entry into the compaction summary — it will be replaced by summary text" },
		drop: { label: "Drop", title: "Omit this entry entirely — neither summarized nor preserved" },
	};
	for (const m of ["keep", "summarize", "drop"]) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.dataset.mark = m;
		btn.textContent = markMeta[m].label;
		btn.title = markMeta[m].title;
		if (entry.mark === m) btn.classList.add("active");
		if (m === "keep" && !entry.cutEligible) {
			btn.title = `${markMeta.keep.title}\n\nNote: this is a tool result and cannot serve as a cut point — it will appear in summary excerpts instead of staying as a separate entry.`;
		}
		btn.addEventListener("click", () => onMarkClick(entry, m));
		marks.appendChild(btn);
	}

	row.appendChild(meta);
	row.appendChild(preview);
	row.appendChild(marks);
	return row;
}

function renderUsage() {
	if (!state.snapshot) return;
	const u = state.snapshot.contextUsage || {};
	if (typeof u.tokens === "number" && typeof u.contextWindow === "number") {
		const pct = u.percent != null ? Math.round(u.percent) : Math.round((u.tokens / u.contextWindow) * 100);
		els.usage.textContent = `Context: ${u.tokens.toLocaleString()} / ${u.contextWindow.toLocaleString()} (${pct}%)`;
	} else if (typeof u.tokens === "number") {
		els.usage.textContent = `Context: ${u.tokens.toLocaleString()} tokens`;
	} else {
		els.usage.textContent = "Context: unknown";
	}
}

function roleLabel(role) {
	switch (role) {
		case "user": return "user";
		case "assistant": return "assistant";
		case "toolCall": return "tool call";
		case "toolResult": return "tool result";
		case "compaction": return "compaction";
		case "branch_summary": return "branch summary";
		default: return role;
	}
}

function truncate(text, limit) {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer = null;

function toast(msg, isError) {
	let el = document.getElementById("toast");
	if (!el) {
		el = document.createElement("div");
		el.id = "toast";
		el.className = "toast";
		document.body.appendChild(el);
	}
	el.textContent = msg;
	el.classList.toggle("error", !!isError);
	el.classList.add("show");
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

// ---------------------------------------------------------------------------
// Interaction handlers
// ---------------------------------------------------------------------------

function onMarkClick(entry, mark) {
	// If the user clicks the currently-active mark, treat as unmark.
	if (entry.mark === mark && entry.isExplicit) {
		send({ kind: "unmark", contentHash: entry.contentHash });
		return;
	}
	send({ kind: "mark", contentHash: entry.contentHash, mark });
}

els.activeToggle.addEventListener("change", () => {
	send({ kind: "set_active", active: els.activeToggle.checked });
});

els.clearBtn.addEventListener("click", () => {
	if (!confirm("Clear all marks?")) return;
	send({ kind: "clear" });
});

els.compactBtn.addEventListener("click", () => {
	send({ kind: "compact_now" });
});

els.instructions.addEventListener("input", () => {
	if (state.instructionsDebounce) clearTimeout(state.instructionsDebounce);
	state.instructionsDebounce = setTimeout(() => {
		send({ kind: "set_instructions", customInstructions: els.instructions.value });
	}, 350);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (!token) {
	els.entries.innerHTML = '<p class="empty">Missing token in URL. Open the link printed by /ctx-ctrl.</p>';
} else {
	connect();
}
