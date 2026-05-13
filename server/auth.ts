/**
 * Per-invocation token mint and verify.
 *
 * Token = randomUUID() generated fresh on every `/ctx-ctrl` (or first server
 * start in the session). Rotated on `/ctx-ctrl --stop` followed by another
 * `/ctx-ctrl`. Compared with a constant-time check to avoid trivial timing
 * side-channels — overkill on localhost but cheap.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

export function mintToken(): string {
	return randomUUID();
}

export function verifyToken(expected: string, actual: string | null | undefined): boolean {
	if (typeof actual !== "string") return false;
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(actual, "utf8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}
