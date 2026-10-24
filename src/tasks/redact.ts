/**
 * Masks secrets in free text (command output) before hamness stores it.
 * Key-based argument redaction lives in `src/safety` (`redactArgs`); this is its text twin.
 */

const SECRET_NAME = /(api[_-]?key|token|secret|passw(or)?d|authorization|credential|private[_-]?key)/i;

const PATTERNS: RegExp[] = [
  // NAME=value, NAME: value, "name": "value" where the name looks secret.
  /((?:[\w-]*(?:api[_-]?key|token|secret|passw(?:or)?d|credential|private[_-]?key)[\w-]*)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,
  /(\bBearer\s+)[\w.~+/=-]+/gi,
  /(\bBasic\s+)[A-Za-z0-9+/=]{8,}/g,
  /()\bsk-[\w-]{16,}/g,
  /()\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g,
  /()\bAKIA[0-9A-Z]{16}\b/g,
  /()\bxox[abprs]-[\w-]{10,}/g,
  /()-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

export function redactText(text: string, env: Record<string, string | undefined> = process.env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 8 && SECRET_NAME.test(name)) out = out.split(value).join("[redacted]");
  }
  for (const re of PATTERNS) out = out.replace(re, "$1[redacted]");
  return out;
}
