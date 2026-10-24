/**
 * The two pattern languages of safety rules.
 *
 * Commands (bash): `*` is any text (spaces and slashes too), `?` one character, `{a,b}` either,
 * `\x` a literal x. A trailing ` *` also matches nothing, so `ls *` matches `ls`.
 *
 * Paths: `*` stays inside one folder, `**` crosses folders, `**\/` may be empty,
 * `?` is one character, `{a,b}` either (an empty choice is allowed), `\x` a literal x.
 */

const cache = new Map<string, RegExp>();

const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function compile(pattern: string, kind: "command" | "path"): RegExp {
  const key = `${kind}\0${pattern}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let body = pattern;
  let optionalTail = false;
  if (kind === "command" && body.endsWith(" *") && !body.endsWith("\\ *")) {
    body = body.slice(0, -2);
    optionalTail = true;
  }

  let re = "";
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c === "\\" && i + 1 < body.length) {
      re += escapeRe(body[++i] as string);
    } else if (c === "*") {
      if (kind === "path" && body[i + 1] === "*") {
        i++;
        if (body[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += kind === "path" ? "[^/]*" : "[\\s\\S]*";
      }
    } else if (c === "?") {
      re += kind === "path" ? "[^/]" : "[\\s\\S]";
    } else if (c === "{") {
      depth++;
      re += "(?:";
    } else if (c === "}" && depth > 0) {
      depth--;
      re += ")";
    } else if (c === "," && depth > 0) {
      re += "|";
    } else {
      re += escapeRe(c);
    }
  }
  re += ")".repeat(depth);
  if (optionalTail) re += "(?: [\\s\\S]*)?";

  const compiled = new RegExp(`^${re}$`);
  cache.set(key, compiled);
  return compiled;
}

export function matchCommand(pattern: string, command: string): boolean {
  return compile(pattern, "command").test(command);
}

export function matchPath(pattern: string, path: string): boolean {
  return compile(pattern, "path").test(path);
}
