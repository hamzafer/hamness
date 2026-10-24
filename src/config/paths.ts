import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Where hamness keeps its database, token and daemon state.
 * HAMNESS_HOME overrides everything (tests point it at a temp dir).
 */
export function resolveDataDir(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const override = env.HAMNESS_HOME;
  if (override) return resolve(override);
  if (platform === "darwin") return join(home, "Library", "Application Support", "hamness");
  const xdg = env.XDG_DATA_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, "hamness");
  return join(home, ".local", "share", "hamness");
}

/** hamness's user config: `safety`, `trust` and other settings. Never in a repo. */
export const userConfigFile = (dataDir: string) => join(dataDir, "config.json");

/** The files hamness keeps in its data dir. */
export function dataPaths(dataDir: string) {
  return {
    dataDir,
    database: join(dataDir, "hamness.sqlite"),
    token: join(dataDir, "token"),
    daemonState: join(dataDir, "daemon.json"),
  } as const;
}

export type DataPaths = ReturnType<typeof dataPaths>;
