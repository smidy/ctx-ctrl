/**
 * WebSocket transport layer.
 *
 * Owns the WebSocketServer, the client set, parse-and-dispatch of incoming
 * messages, and broadcast of outgoing messages. State mutations are delegated
 * to handlers passed in from index.ts — this module is transport-only.
 */

import { WebSocketServer, WebSocket, type RawData } from "ws";
import { parseClientMsg } from "../shared/protocol.js";
import type { ClientMsg, ServerMsg } from "../shared/protocol.js";
import type { EntryMark } from "../shared/types.js";

export interface WsHandlers {
	onMark(contentHash: string, mark: EntryMark): Promise<void>;
	onUnmark(contentHash: string): Promise<void>;
	onSetInstructions(text: string): Promise<void>;
	onSetActive(active: boolean): Promise<void>;
	onClear(): Promise<void>;
	onRequestSnapshot(): Promise<void>;
	onCompactNow(): Promise<void>;
}

export interface WsLayer {
	server: WebSocketServer;
	clients: Set<WebSocket>;
	broadcast(msg: ServerMsg): void;
	send(client: WebSocket, msg: ServerMsg): void;
	closeAll(code?: number, reason?: string): void;
}

export function createWsLayer(handlers: WsHandlers): WsLayer {
	const server = new WebSocketServer({ noServer: true });
	const clients = new Set<WebSocket>();

	server.on("connection", (ws) => {
		clients.add(ws);

		ws.on("message", (data) => {
			void handleIncoming(data, ws, handlers).catch((err) => {
				send(ws, { kind: "error", message: errorMessage(err) });
			});
		});

		ws.on("close", () => {
			clients.delete(ws);
		});

		ws.on("error", () => {
			clients.delete(ws);
		});

		// Fire-and-forget — initial snapshot is handled by index.ts via the
		// snapshot dispatcher (it has the ctx).
		void handlers.onRequestSnapshot().catch(() => {
			// swallow — error events already wired
		});
	});

	function send(client: WebSocket, msg: ServerMsg): void {
		if (client.readyState !== WebSocket.OPEN) return;
		try {
			client.send(JSON.stringify(msg));
		} catch {
			// drop — closed sockets handled by close listener
		}
	}

	function broadcast(msg: ServerMsg): void {
		const payload = JSON.stringify(msg);
		for (const client of clients) {
			if (client.readyState !== WebSocket.OPEN) continue;
			try {
				client.send(payload);
			} catch {
				// drop
			}
		}
	}

	function closeAll(code = 1001, reason = "Server shutting down"): void {
		for (const client of clients) {
			try {
				client.close(code, reason);
			} catch {
				// swallow
			}
		}
		clients.clear();
	}

	return { server, clients, broadcast, send, closeAll };
}

async function handleIncoming(data: RawData, ws: WebSocket, handlers: WsHandlers): Promise<void> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawDataToString(data));
	} catch {
		send(ws, { kind: "error", message: "Invalid JSON" });
		return;
	}

	const msg = parseClientMsg(parsed);
	if (!msg) {
		send(ws, { kind: "error", message: "Invalid message shape" });
		return;
	}

	await dispatch(msg, handlers);
}

async function dispatch(msg: ClientMsg, h: WsHandlers): Promise<void> {
	switch (msg.kind) {
		case "mark":
			return h.onMark(msg.contentHash, msg.mark);
		case "unmark":
			return h.onUnmark(msg.contentHash);
		case "set_instructions":
			return h.onSetInstructions(msg.customInstructions);
		case "set_active":
			return h.onSetActive(msg.active);
		case "clear":
			return h.onClear();
		case "request_snapshot":
			return h.onRequestSnapshot();
		case "compact_now":
			return h.onCompactNow();
	}
}

function send(client: WebSocket, msg: ServerMsg): void {
	if (client.readyState !== WebSocket.OPEN) return;
	try {
		client.send(JSON.stringify(msg));
	} catch {
		// drop
	}
}

function rawDataToString(data: RawData): string {
	if (typeof data === "string") return data;
	if (data instanceof Buffer) return data.toString("utf-8");
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
	return Buffer.from(data as ArrayBuffer).toString("utf-8");
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
