/**
 * A conservative shell splitter for safety checks. It does not run or expand anything: it finds
 * every simple command a bash string would run, so each can be checked on its own.
 *
 * - `&&`, `||`, `;`, `|`, `&` and newlines split commands; `(...)` and `{ ...; }` are opened up.
 * - `$(...)`, backticks and `<(...)` / `>(...)` become commands of their own, and the command
 *   holding them is marked `dynamic` (its words are only known at run time), as are `$VAR`s.
 * - Redirections are pulled out with their targets, so `> file` can be checked as a write.
 * - Anything it does not understand (heredocs, unclosed quotes) is refused: the caller asks.
 */

export interface Redirect {
  op: ">" | ">>" | "<";
  target: string;
}

export interface Segment {
  /** The command's words, quotes removed. A substitution shows as `$(…)`. */
  words: string[];
  redirects: Redirect[];
  /** True when a word depends on run time: a variable or a command substitution. */
  dynamic: boolean;
  /** True when this command reads the previous one's output through `|`. */
  pipedFrom: boolean;
}

export type ParsedCommand = { ok: true; segments: Segment[] } | { ok: false; error: string };

const PLACEHOLDER = "$(…)";

class ParseError extends Error {}

class Parser {
  i = 0;
  constructor(private readonly src: string) {}

  /** Parses until `terminator` (consumed) or the end of input. Returns every segment found. */
  list(terminator: ")" | null): Segment[] {
    const out: Segment[] = [];
    let words: string[] = [];
    let redirects: Redirect[] = [];
    let nested: Segment[] = [];
    let dynamic = false;
    let pipedFrom = false;
    let nextPiped = false;

    let word = "";
    let started = false;
    let quoted = false;
    let pending: Redirect["op"] | "skip" | "dup" | undefined;

    const endWord = () => {
      if (!started) return;
      if (pending === "dup") {
        // `>&2` duplicates a descriptor; `>&file` writes to the file.
        if (!/^(\d+|-)$/.test(word)) redirects.push({ op: ">", target: word });
        pending = undefined;
      } else if (pending === "skip") {
        pending = undefined;
      } else if (pending) {
        redirects.push({ op: pending, target: word });
        pending = undefined;
      } else if (quoted || (word !== "{" && word !== "}")) {
        words.push(word);
      }
      word = "";
      started = false;
      quoted = false;
    };

    const endSegment = (piped: boolean) => {
      endWord();
      if (pending) throw new ParseError("a redirection has no target");
      if (words.length > 0 || redirects.length > 0) {
        out.push({ words, redirects, dynamic, pipedFrom });
      }
      out.push(...nested);
      words = [];
      redirects = [];
      nested = [];
      dynamic = false;
      pipedFrom = piped;
      nextPiped = false;
    };

    const substitution = () => {
      nested.push(...this.list(")"));
      word += PLACEHOLDER;
      started = true;
      dynamic = true;
    };

    const backtick = () => {
      const close = this.findBacktick();
      const inner = this.src.slice(this.i, close);
      this.i = close + 1;
      nested.push(...new Parser(inner).list(null));
      word += PLACEHOLDER;
      started = true;
      dynamic = true;
    };

    const dollar = () => {
      // At `$`. Handles `$(`, `${`, and `$NAME`.
      const next = this.src[this.i + 1];
      if (next === "(") {
        this.i += 2;
        substitution();
        return;
      }
      if (next === "{") {
        word += this.braced(nested);
      } else {
        word += "$";
        this.i++;
      }
      started = true;
      dynamic = true;
    };

    while (this.i < this.src.length) {
      const c = this.src[this.i] as string;
      const next = this.src[this.i + 1];

      if (c === ")" && terminator === ")") {
        this.i++;
        endSegment(false);
        return out;
      }
      if (c === " " || c === "\t") {
        endWord();
        this.i++;
        continue;
      }
      if (c === "\n" || c === ";") {
        endSegment(false);
        this.i++;
        continue;
      }
      if (c === "&") {
        if (next === "&") {
          endSegment(false);
          this.i += 2;
        } else if (next === ">") {
          endWord();
          this.i += 2;
          if (this.src[this.i] === ">") this.i++;
          pending = ">";
        } else {
          endSegment(false);
          this.i++;
        }
        continue;
      }
      if (c === "|") {
        if (next === "|") {
          endSegment(false);
          this.i += 2;
        } else {
          nextPiped = true;
          endSegment(true);
          this.i += next === "&" ? 2 : 1;
        }
        continue;
      }
      if (c === "(") {
        if (started) throw new ParseError("unexpected (");
        this.i++;
        nested.push(...this.list(")"));
        endSegment(nextPiped);
        continue;
      }
      if (c === ">" || c === "<") {
        if (started && !quoted && /^\d+$/.test(word)) {
          // `2>`: the digits name a descriptor, not a word.
          word = "";
          started = false;
        } else {
          endWord();
        }
        if (next === "(") {
          this.i += 2;
          substitution();
          continue;
        }
        if (c === "<" && next === "<") {
          if (this.src[this.i + 2] !== "<") throw new ParseError("heredocs are not checked");
          this.i += 3;
          pending = "skip";
          continue;
        }
        if (next === "&") {
          this.i += 2;
          pending = c === ">" ? "dup" : "skip";
          continue;
        }
        if (c === ">" && next === ">") {
          this.i += 2;
          pending = ">>";
          continue;
        }
        if (c === ">" && next === "|") {
          this.i += 2;
          pending = ">";
          continue;
        }
        if (c === "<" && next === ">") {
          this.i += 2;
          pending = ">";
          continue;
        }
        this.i++;
        pending = c;
        continue;
      }
      if (c === "#" && !started) {
        const nl = this.src.indexOf("\n", this.i);
        this.i = nl < 0 ? this.src.length : nl;
        continue;
      }
      if (c === "'") {
        const close = this.src.indexOf("'", this.i + 1);
        if (close < 0) throw new ParseError("an unclosed '");
        word += this.src.slice(this.i + 1, close);
        this.i = close + 1;
        started = true;
        quoted = true;
        continue;
      }
      if (c === '"') {
        this.i++;
        started = true;
        quoted = true;
        for (;;) {
          if (this.i >= this.src.length) throw new ParseError('an unclosed "');
          const d = this.src[this.i] as string;
          if (d === '"') {
            this.i++;
            break;
          }
          if (d === "\\") {
            const e = this.src[this.i + 1];
            if (e !== undefined && '"\\$`'.includes(e)) word += e;
            else if (e !== "\n") word += `\\${e ?? ""}`;
            this.i += 2;
          } else if (d === "$") {
            dollar();
          } else if (d === "`") {
            this.i++;
            backtick();
          } else {
            word += d;
            this.i++;
          }
        }
        continue;
      }
      if (c === "\\") {
        if (next !== undefined && next !== "\n") {
          word += next;
          started = true;
        }
        this.i += 2;
        continue;
      }
      if (c === "`") {
        this.i++;
        backtick();
        continue;
      }
      if (c === "$") {
        dollar();
        continue;
      }
      word += c;
      started = true;
      this.i++;
    }

    if (terminator) throw new ParseError("an unclosed (");
    endSegment(false);
    return out;
  }

  /**
   * At `${`: reads to the matching `}`. A `$(...)` or backtick inside (`${x:-$(cmd)}`) runs, so
   * it becomes a command of its own in `nested`, and the word shows as a substitution.
   */
  private braced(nested: Segment[]): string {
    const start = this.i;
    this.i += 2;
    let depth = 1;
    let substituted = false;
    let inDouble = false;
    while (this.i < this.src.length) {
      const d = this.src[this.i] as string;
      if (d === "\\") {
        this.i += 2;
      } else if (d === "'" && !inDouble) {
        const close = this.src.indexOf("'", this.i + 1);
        if (close < 0) throw new ParseError("an unclosed '");
        this.i = close + 1;
      } else if (d === '"') {
        inDouble = !inDouble;
        this.i++;
      } else if (d === "$" && this.src[this.i + 1] === "(") {
        this.i += 2;
        nested.push(...this.list(")"));
        substituted = true;
      } else if (d === "`") {
        this.i++;
        const close = this.findBacktick();
        nested.push(...new Parser(this.src.slice(this.i, close)).list(null));
        this.i = close + 1;
        substituted = true;
      } else if (d === "$" && this.src[this.i + 1] === "{") {
        depth++;
        this.i += 2;
      } else if (d === "}" && !inDouble) {
        this.i++;
        if (--depth === 0) return substituted ? PLACEHOLDER : this.src.slice(start, this.i);
      } else {
        this.i++;
      }
    }
    throw new ParseError("an unclosed ${");
  }

  private findBacktick(): number {
    for (let j = this.i; j < this.src.length; j++) {
      if (this.src[j] === "\\") j++;
      else if (this.src[j] === "`") return j;
    }
    throw new ParseError("an unclosed `");
  }
}

export function parseCommand(command: string): ParsedCommand {
  try {
    return { ok: true, segments: new Parser(command).list(null) };
  } catch (err) {
    if (err instanceof ParseError) return { ok: false, error: err.message };
    throw err;
  }
}
