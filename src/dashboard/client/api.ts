/**
 * The token and the JSON routes. `hamness dashboard` opens `/dash#token=<t>`: the fragment
 * never leaves the browser, so the token stays out of server and proxy logs. The page moves it
 * to sessionStorage (this tab only), wipes it from the address bar and sends it as a header.
 */

const KEY = "hamness.dashboard.token";
let memory: string | null = null;

export function takeToken(): string | null {
  const m = /(?:^|&)token=([0-9a-f]{16,128})(?:&|$)/.exec(location.hash.slice(1));
  if (m?.[1]) {
    memory = m[1];
    try {
      sessionStorage.setItem(KEY, memory);
    } catch {
      // Storage blocked: the token lives in memory for this page load.
    }
    history.replaceState(null, "", location.pathname + location.search);
    return memory;
  }
  if (memory) return memory;
  try {
    memory = sessionStorage.getItem(KEY);
  } catch {
    memory = null;
  }
  return memory;
}

function forgetToken(): void {
  memory = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
}

export class Unauthorized extends Error {}

export async function getJson<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  const token = takeToken();
  if (!token) throw new Unauthorized("no token");
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  const res = await fetch(`${path}${qs.size ? `?${qs}` : ""}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status === 401) {
    forgetToken();
    throw new Unauthorized("token rejected");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}
