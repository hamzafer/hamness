import { resolve } from "node:path";
import { type BunPlugin, type PluginBuilder, plugin } from "bun";

// OpenTUI's Solid JSX needs a Bun transform plugin. bunfig.toml preloads it only when hamness
// runs from this repo's dir, and the stock plugin skips every file under node_modules, which
// is where `bun install -g` puts hamness. So hamness registers the same transform for its own
// .tsx files when it runs from there.

type LoadHandler = Parameters<PluginBuilder["onLoad"]>[1];

/** The stock preload (no types): also redirects solid-js to its browser build. */
const SOLID_PRELOAD = "@opentui/solid/preload";
const SRC = resolve(import.meta.dir, "..");
const UNDER_NODE_MODULES = /[/\\]node_modules[/\\]/;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const registered = new Set<string>();

/** OpenTUI's Solid source transform, taken from its stock plugin. */
async function solidSourceHandler(): Promise<LoadHandler> {
  const { createSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
  const stock: BunPlugin = createSolidTransformPlugin();
  let handler: LoadHandler | undefined;
  const probe = {
    onLoad(opts: { filter: RegExp }, cb: LoadHandler) {
      if (opts.filter.test("/probe/app.tsx")) handler = cb;
      return probe;
    },
  };
  await stock.setup(probe as unknown as PluginBuilder);
  if (!handler) throw new Error("OpenTUI's Solid plugin has no source transform");
  return handler;
}

/** Compiles the Solid JSX in `dir`'s .tsx files, also when `dir` is under node_modules. */
export async function registerSolidTransform(dir: string): Promise<void> {
  await import(SOLID_PRELOAD);
  if (!UNDER_NODE_MODULES.test(dir) || registered.has(dir)) return;
  registered.add(dir);
  const handler = await solidSourceHandler();
  plugin({
    name: `hamness-solid:${dir}`,
    setup(build) {
      build.onLoad(
        { filter: new RegExp(`^${escapeRegExp(dir)}[/\\\\].*\\.tsx(?:[?#].*)?$`) },
        handler,
      );
    },
  });
}

/** Loads the TUI module, wherever hamness is installed. */
export async function loadTui(): Promise<typeof import("./main.tsx")> {
  await registerSolidTransform(SRC);
  return import("./main.tsx");
}
