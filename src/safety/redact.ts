/**
 * Redaction for anything hamness stores or streams about a tool call: secret-named keys,
 * and secret-looking values inside any string (commands, file contents, headers).
 * The stored copy is redacted; the tool still runs with the real arguments.
 */

const R = "[redacted]";
/** Assistant replies render as Markdown, where `[redacted]` could read as a link label. */
const REPLY_MARK = "‹redacted›";

const SECRET_KEY =
  /(api[_-]?key|access[_-]?key|secret|passw(or)?d|authorization|credential|private[_-]?key|(^|[_-])token$|^token)/i;

/** `auth` only as a word of its own (`AUTH_TOKEN`, `--auth`), never `author` or `authority`. */
const SECRET_WORD =
  "(?:api[_-]?key|access[_-]?key|secret|token|passw(?:or)?d|credentials?|auth(?![a-z]))";

/** Where a bare value ends: space, a shell separator, or Markdown and code punctuation. */
const VALUE_END = "\\s;&|`'\"()\\[\\]{}<>";

/**
 * The unmistakable ones, in order: private key blocks, passwords in URLs and well-known token
 * shapes. Safe on prose: they never match text that only names a secret.
 */
function secretRules(mark: string): Array<[RegExp, string]> {
  return [
    [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      mark === R ? "[redacted private key]" : `${mark} private key`,
    ],
    // https://user:password@host
    [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, `$1${mark}@`],
    [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, mark],
    [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, mark],
    [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, mark],
    [/\bglpat-[A-Za-z0-9_-]{20,}/g, mark],
    [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, mark],
    [/\bAKIA[0-9A-Z]{16}\b/g, mark],
    [/\bAIza[0-9A-Za-z_-]{35}/g, mark],
    [/\bnpm_[A-Za-z0-9]{36}\b/g, mark],
    [/\bhf_[A-Za-z0-9]{30,}/g, mark],
    [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, mark],
  ];
}

/** Patterns and their replacements, applied in order. */
const RULES: Array<[RegExp, string]> = [
  ...secretRules(R).slice(0, 2),
  // Authorization: Bearer xyz
  [/\b(bearer|basic|digest)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${R}`],
  ...secretRules(R).slice(2),
  // "client_secret": "..."
  [new RegExp(`("[^"]*${SECRET_WORD}[^"]*"\\s*:\\s*)"[^"]*"`, "gi"), `$1"${R}"`],
  // --token abc, --password=abc
  [
    new RegExp(
      `(--?[A-Za-z0-9-]*${SECRET_WORD}[A-Za-z0-9-]*)(=|\\s+)("[^"]*"|'[^']*'|[^${VALUE_END}-][^${VALUE_END}]*)`,
      "gi",
    ),
    `$1$2${R}`,
  ],
  // API_KEY=abc (shell, .env files)
  [
    new RegExp(
      `\\b([A-Za-z0-9_]*${SECRET_WORD}[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^${VALUE_END}]+)`,
      "gi",
    ),
    `$1=${R}`,
  ],
];

const REPLY_RULES = secretRules(REPLY_MARK);

export function redactText(text: string): string {
  let out = text;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}

/**
 * An assistant reply with only the unmistakable secrets taken out (`secretRules`): a reply
 * that explains `API_KEY=…` or `--token` in Markdown or code reads as written.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of REPLY_RULES) out = out.replace(re, replacement);
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
