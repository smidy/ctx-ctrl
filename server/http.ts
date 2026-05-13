/**
 * HTTP server + static asset serving + WS upgrade gate.
 *
 * Binds to 127.0.0.1 on an ephemeral port. Every request must carry the
 * server's per-invocation token (via ?token= query param). Anything missing
 * or mismatched returns 401 without revealing any asset bytes.
 *
 * Routes:
 *   GET /                  → rendered index.html (theme + token embedded)
 *   GET /client.js         → static JS
 *   GET /client.css        → static CSS
 *   WS  /ws?token=<TOKEN>  → upgraded by server.on("upgrade")
 *
 * Origin policy: pi-studio pattern — accept any localhost origin. Token is
 * the primary auth (random UUID, length-equal constant-time compare). See
 * README §Threat model.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { WebSocketServer } from "ws";
import { verifyToken } from "./auth.js";

export interface HttpServerHandle {
	server: Server;
	port: number;
	url: string;
	close(): Promise<void>;
}

export interface CreateHttpServerArgs {
	token: string;
	wsServer: WebSocketServer;
	getIndexHtml(): string;
	clientJs: Buffer;
	clientCss: Buffer;
}

const SECURITY_HEADERS = {
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Cache-Control": "no-store",
} as const;

export async function createHttpServer(args: CreateHttpServerArgs): Promise<HttpServerHandle> {
	const server = createServer((req, res) => handleRequest(req, res, args));

	server.on("upgrade", (req, socket, head) => {
		const requestUrl = parseRequestUrl(req);
		if (!requestUrl || requestUrl.pathname !== "/ws") {
			socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
			socket.destroy();
			return;
		}
		const token = requestUrl.searchParams.get("token");
		if (!verifyToken(args.token, token)) {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}
		args.wsServer.handleUpgrade(req, socket, head, (ws) => {
			args.wsServer.emit("connection", ws, req);
		});
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (err: Error) => {
			server.off("listening", onListening);
			reject(err);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(0, "127.0.0.1");
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("ctx-ctrl: failed to determine server port");
	}
	const port = address.port;
	const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(args.token)}`;

	return {
		server,
		port,
		url,
		async close() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

// ---------------------------------------------------------------------------
// Request routing
// ---------------------------------------------------------------------------

function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	args: CreateHttpServerArgs,
): void {
	const url = parseRequestUrl(req);
	if (!url) {
		send(res, 400, "text/plain", "Bad Request");
		return;
	}

	const token = url.searchParams.get("token");
	if (!verifyToken(args.token, token)) {
		send(res, 401, "text/plain", "Unauthorized");
		return;
	}

	switch (url.pathname) {
		case "/":
		case "/index.html":
			send(res, 200, "text/html; charset=utf-8", args.getIndexHtml());
			return;
		case "/client.js":
			send(res, 200, "application/javascript; charset=utf-8", args.clientJs);
			return;
		case "/client.css":
			send(res, 200, "text/css; charset=utf-8", args.clientCss);
			return;
		case "/healthz":
			send(res, 200, "text/plain", "ok");
			return;
		default:
			send(res, 404, "text/plain", "Not Found");
			return;
	}
}

function parseRequestUrl(req: IncomingMessage): URL | null {
	const host = req.headers.host ?? "127.0.0.1";
	try {
		return new URL(req.url ?? "/", `http://${host}`);
	} catch {
		return null;
	}
}

function send(
	res: ServerResponse,
	status: number,
	contentType: string,
	body: string | Buffer,
): void {
	res.writeHead(status, {
		"Content-Type": contentType,
		...SECURITY_HEADERS,
	});
	res.end(body);
}

