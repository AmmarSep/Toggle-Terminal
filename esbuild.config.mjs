import esbuild from "esbuild";
import builtins from "builtin-modules";
import process from "node:process";
import { writeFile, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const production = process.argv[2] === "production";

/**
 * Identifies the build. Two machines showing the same stamp are running the
 * same main.js — which is the quickest way to tell whether sync has landed.
 */
async function buildStamp() {
  const dir = path.resolve("src");
  const names = (await readdir(dir)).sort();
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name);
    hash.update(await readFile(path.join(dir, name)));
  }
  return `${new Date().toISOString().replace(/\.\d+Z$/, "Z")} ${hash.digest("hex").slice(0, 8)}`;
}

const stamp = await buildStamp();

/*
 * Obsidian installs only main.js, manifest.json and styles.css from a release,
 * so the bridge cannot ship as its own file. Embed the source and let the
 * plugin write it out at runtime.
 */
const bridgeSource = await readFile(path.resolve("pty-bridge.py"), "utf8");

const banner = `/*
Obsidian Toggle Terminal - generated bundle, do not edit.
Source lives in src/. Build with: npm run build
*/
`;

/**
 * esbuild names the bundled CSS after the JS outfile (`main.css`), but Obsidian
 * only loads `styles.css`. Writing the outputs ourselves avoids the race you get
 * from renaming a file esbuild may still be writing.
 */
const cssOutputPlugin = {
  name: "css-output",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      for (const file of result.outputFiles ?? []) {
        const name = path.basename(file.path);
        const target = path.resolve(name === "main.css" ? "styles.css" : name);
        await writeFile(target, file.contents);
      }
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  write: false, // the css-output plugin writes the files
  format: "cjs",
  target: "es2018",
  platform: "browser",
  logLevel: "info",
  banner: { js: banner },
  define: {
    __BUILD_STAMP__: JSON.stringify(stamp),
    __PTY_BRIDGE_SOURCE__: JSON.stringify(bridgeSource),
  },
  sourcemap: production ? false : "inline",
  treeShaking: true,
  minify: production,
  // node-pty is required at runtime from the plugin folder, never bundled.
  external: [
    "obsidian",
    "electron",
    "node-pty",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
    ...builtins.map((name) => `node:${name}`),
  ],
  plugins: [cssOutputPlugin],
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
