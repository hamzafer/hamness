import { redactSecrets } from "../safety/index.ts";

/** Characters held back from a streaming reply, so a secret split across deltas is still caught. */
const HOLD = 64;

/**
 * Redacts an assistant reply as it streams (`redactSecrets`). Each push sends what is safe: all
 * but the last `HOLD` characters, cut at a space (the secrets it looks for have none), and never
 * past an unfinished private key block. `flush` sends the rest when the reply ends.
 */
export class ReplyRedactor {
  private pending = "";

  push(delta: string): string {
    this.pending += delta;
    let cut = this.pending.length - HOLD;
    if (cut <= 0) return "";
    // Back to just after a space, so no token is split.
    const space = this.pending.lastIndexOf(" ", cut - 1);
    const newline = this.pending.lastIndexOf("\n", cut - 1);
    cut = Math.max(space, newline) + 1;
    // A private key block the cut would split waits whole, until its end is in and sent.
    for (const begin of this.pending.matchAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g)) {
      if (begin.index >= cut) break;
      const end = /-----END [A-Z ]*PRIVATE KEY-----/.exec(this.pending.slice(begin.index));
      const endsAt = end ? begin.index + end.index + end[0].length : Number.POSITIVE_INFINITY;
      if (endsAt > cut) {
        cut = begin.index;
        break;
      }
    }
    if (cut <= 0) return "";
    const out = redactSecrets(this.pending.slice(0, cut));
    this.pending = this.pending.slice(cut);
    return out;
  }

  flush(): string {
    const out = redactSecrets(this.pending);
    this.pending = "";
    return out;
  }
}
