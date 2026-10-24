import { redactText } from "../safety/index.ts";

/** Names of environment variables whose values are secrets. */
const SECRET_NAME =
  /(api[_-]?key|access[_-]?key|token|secret|passw(or)?d|authorization|credential|private[_-]?key)/i;

/**
 * Masks secrets in command output before hamness stores it: the safety layer's text patterns,
 * plus the literal values of secret-named environment variables (a command can print them in
 * any shape).
 */
export function redactOutput(
  text: string,
  env: Record<string, string | undefined> = process.env,
): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 8 && SECRET_NAME.test(name)) {
      out = out.split(value).join("[redacted]");
    }
  }
  return redactText(out);
}
