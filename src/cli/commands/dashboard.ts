import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ensureDaemon } from "../../client/client.ts";
import { dataPaths } from "../../config/paths.ts";
import type { CliContext } from "../run.ts";

export const DASHBOARD_USAGE = [
  "Usage: hamness dashboard [--no-open]",
  "",
  "Opens the web dashboard served by the daemon (started if it is not running).",
  "The link carries the daemon's token after '#', which the browser never sends to a server.",
  "  --no-open  Print the link instead of opening a browser",
].join("\n");

type Opener = (url: string) => Promise<void>;

/** Opens a URL in the default browser (`open` on macOS, `xdg-open` elsewhere). */
const openInBrowser: Opener = (url) =>
  new Promise((resolve, reject) => {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

export function dashboardCommandWith(open: Opener) {
  return async ({ args, dataDir, env, io }: CliContext): Promise<number> => {
    let values: { "no-open"?: boolean; help?: boolean };
    try {
      ({ values } = parseArgs({
        args,
        options: { "no-open": { type: "boolean" }, help: { type: "boolean", short: "h" } },
        strict: true,
        allowPositionals: false,
      }));
    } catch (e) {
      io.err(`hamness dashboard: ${(e as Error).message}`);
      io.err(DASHBOARD_USAGE);
      return 2;
    }
    if (values.help) {
      io.out(DASHBOARD_USAGE);
      return 0;
    }
    let base: string;
    try {
      base = (await ensureDaemon(dataDir, { env })).url;
    } catch (e) {
      io.err(`hamness dashboard: ${(e as Error).message}`);
      return 1;
    }
    const token = readFileSync(dataPaths(dataDir).token, "utf8").trim();
    const page = `${base}/dash`;
    const link = `${page}#token=${token}`;
    if (values["no-open"]) {
      io.out(link);
      return 0;
    }
    try {
      await open(link);
      io.out(`Opened the hamness dashboard: ${page}`);
    } catch (e) {
      io.err(`hamness dashboard: could not open a browser (${(e as Error).message})`);
      io.out(`Open this link: ${link}`);
    }
    return 0;
  };
}

export const dashboardCommand = dashboardCommandWith(openInBrowser);
