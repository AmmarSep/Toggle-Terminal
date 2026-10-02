import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const redirect = {
	name: "harness-redirects",
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(here, "obsidian-mock.ts") }));
		build.onResolve({ filter: /^node:(path|os)$/ }, () => ({ path: path.join(here, "node-shims.ts") }));
		build.onResolve({ filter: /^\.\/pty$/ }, (args) =>
			args.importer.includes(`${path.sep}src${path.sep}`) ? { path: path.join(here, "pty-mock.ts") } : undefined,
		);
		build.onResolve({ filter: /\.css$/ }, () => ({ path: "ignored-css", namespace: "empty" }));
		build.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "", loader: "js" }));
	},
};

await esbuild.build({
	entryPoints: [path.join(here, "entry.ts")],
	bundle: true,
	outfile: path.join(here, ".out", "bundle.js"),
	format: "iife",
	platform: "browser",
	target: "es2020",
	sourcemap: "inline",
	define: { __BUILD_STAMP__: JSON.stringify("harness"), __PTY_BRIDGE_SOURCE__: JSON.stringify(""), "process.platform": '"linux"', "process.arch": '"x64"' },
	plugins: [redirect],
	logLevel: "warning",
});
console.log("built");
