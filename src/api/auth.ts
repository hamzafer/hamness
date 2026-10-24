import { timingSafeEqual } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("hex");
}

/** Writes the token so only the owner can read it (0600). */
export function writeTokenFile(path: string, token: string): void {
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // mode is ignored when the file already exists
}

export function tokensMatch(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The token from `Authorization: Bearer <t>`, or from `?token=` (browsers can't set WebSocket headers). */
export function tokenFromRequest(req: Request, url: URL, allowQuery: boolean): string | null {
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  return allowQuery ? url.searchParams.get("token") : null;
}
