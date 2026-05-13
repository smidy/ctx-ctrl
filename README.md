# ctx-ctrl

Pi extension that opens a local browser UI for **selective compaction** of the current session history.

For each message in the session, you mark it as one of:

- **Keep** — preserved verbatim across compaction
- **Summarize** — fed to the summarizer LLM
- **Drop** — excluded from both the summary and every subsequent LLM call

Selections persist across pi restarts via `pi.appendEntry`. The browser UI is served from a localhost-only HTTP+WebSocket server with a per-invocation auth token (same pattern as `[pi-studio](https://github.com/omaclaren/pi-studio)`).

## Install

```bash
# Local
pi install /path/to/ctx-ctrl

# Once without installing
pi -e /path/to/ctx-ctrl/index.ts
```

After install, run `/ctx-ctrl` in pi.

## Commands

| Command | Description |
|---|---|
| `/ctx-ctrl` | Open the browser UI (starts server if needed) |
| `/ctx-ctrl --compact-now` | Run compaction now (multi-cut fork if S marks exist, else pi default) |
| `/ctx-ctrl --status` | Show server status + URL |
| `/ctx-ctrl --stop` | Stop the server, free the port |
| `/ctx-ctrl --clear` | Wipe all marks (no UI) |
| `/ctx-ctrl --toggle` | Flip the master Active toggle (no UI) |
| `/ctx-ctrl --help` | Show command list |

## How compaction works

Two paths, picked automatically based on selection state.

### Multi-cut (Apply compaction) — fork-and-rebuild

When you click **Apply compaction** (or run `/ctx-ctrl --compact-now`) AND your selection has at least one Summarize mark, ctx-ctrl:

1. Generates one summary per contiguous run of Summarize-marked entries (LLM calls happen up front; any failure aborts cleanly, original session untouched).
2. Calls `ctx.newSession({ parentSession, setup })` to fork into a **new session file**. The setup callback walks the original branch and re-appends:
   - **Keep** entries → preserved verbatim via `appendMessage`
   - **Summarize** runs → collapsed into one `branch_summary` entry per run (using the pre-generated summaries)
   - **Drop** entries → omitted entirely
   - Existing `branch_summary` / `compaction` entries → preserved verbatim
3. Persists a fresh selection (S marks cleared, K/D marks survive via stable contentHashes) on the new session.

**You land on the new session after Apply** — your pi prompt shows the new session ID. The original session is preserved as the new session's `parentSession` and remains reachable via `/switch-session` or `/tree`. The browser UI auto-reconnects to the new session.

The resulting branch shape is `[K, summary, K, summary, K, ...]` instead of pi's contiguous `[summary-with-folded-K, K, K, ...]` — Keep entries appear as siblings of the summary rows, not inside them.

### Single-cut (legacy fallback)

When pi triggers compaction (auto-threshold or plain `/compact`) — or you click Apply with no Summarize marks — ctx-ctrl intercepts via `session_before_compact` and:

1. Splits the messages pi planned to summarize into three buckets by user mark:
   - **Summarize** → fed to a summarizer LLM call
   - **Keep** → quoted verbatim into the summary under "Preserved excerpts"
   - **Drop** → omitted entirely
2. Returns a `CompactionEntry` with `details.source === "ctx-ctrl"` and the resulting summary text.
3. For entries past the compaction cut that are marked Drop, ctx-ctrl filters them out of every subsequent LLM call via the `context` event.

This path stays on the **same session** — no fork. Pi's compaction cut point is contiguous, so Keep marks before the cut don't move the boundary; they are inlined into the summary.

## Threat model

- Server binds to `127.0.0.1` only — no remote exposure.
- Per-invocation `randomUUID()` token required on every HTTP and WebSocket request — any request missing or with a wrong token returns 401.
- The token appears in your terminal scrollback; assume terminal access ≈ session access. Do not paste the URL into untrusted chats.
- For remote SSH sessions: use SSH local port forwarding and open the URL through the tunnel. Do not change the bind address.

## Reference

Architecture, data model, WS protocol, and acceptance criteria are documented in [docs/plans/implementation-plan.md](docs/plans/implementation-plan.md).

## License

MIT
