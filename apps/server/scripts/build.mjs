// Bundles the server into dist/main.mjs, and the Sentry start-up into
// dist/instrument.mjs (loaded first with node --import). npm dependencies stay
// external (they are installed in the image), @sentry/node too: its tracing
// hooks into packages such as pg as they load, which does not work from
// inside a bundle. The workspace package (@handbook/shared) is bundled, and so
// is @meldgrove/ui/updates/server: @meldgrove/ui is a root devDependency, not
// one of the server's, so the image's production install leaves out the
// package and its React peers.
import { build } from "esbuild";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith("@handbook/"));

await rm(path.join(root, "dist"), { recursive: true, force: true });
await build({
  entryPoints: { main: path.join(root, "src/main.ts"), instrument: path.join(root, "src/instrument.ts") },
  outdir: path.join(root, "dist"),
  outExtension: { ".js": ".mjs" },
  // One copy of shared code (Sentry) for both entry points.
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  external,
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
  // Some dependencies still call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
