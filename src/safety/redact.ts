/**
 * Redaction for anything hamness stores or streams about a tool call: secret-named keys,
 * and secret-looking values inside any string (commands, file contents, headers).
 * The stored copy is redacted; the tool still runs with the real arguments.
 */

const R = "[redacted]";

const SECRET_KEY =
  /(api[_-]?key|access[_-]?key|secret|passw(or)?d|authorization|credential|private[_-]?key|(^|[_-])token$|^token)/i;

const SECRET_WORD = "(?:api[_-]?key|access[_-]?key|secret|token|passw(?:or)?d|credentials?|auth)";

/** Patterns and their replacements, applied in order. */
const RULES: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted private key]",
  ],
  // https://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, `$1${R}@`],
  // Authorization: Bearer xyz
  [/\b(bearer|basic|digest)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${R}`],
  // Well-known token shapes.
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, R],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, R],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, R],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, R],
  [/\bAKIA[0-9A-Z]{16}\b/g, R],
  [/\bAIza[0-9A-Za-z_-]{35}/g, R],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, R],
  [/\bhf_[A-Za-z0-9]{30,}/g, R],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, R],
  // "client_secret": "..."
  [new RegExp(`("[^"]*${SECRET_WORD}[^"]*"\\s*:\\s*)"[^"]*"`, "gi"), `$1"${R}"`],
  // --token abc, --password=abc
  [
    new RegExp(
      `(--?[A-Za-z0-9-]*${SECRET_WORD}[A-Za-z0-9-]*)(=|\\s+)("[^"]*"|'[^']*'|[^\\s"'-][^\\s"']*)`,
      "gi",
    ),
    `$1$2${R}`,
  ],
  // API_KEY=abc (shell, .env files)
  [
    new RegExp(`\\b([A-Za-z0-9_]*${SECRET_WORD}[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\\s;&|]+)`, "gi"),
    `$1=${R}`,
  ],
];

export function redactText(text: string): string {
  let out = text;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}

/** A copy of tool arguments safe to store and stream. */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? R : walk(v)]),
      );
    }
    return value;
  };
  return walk(args) as Record<string, unknown>;
}
