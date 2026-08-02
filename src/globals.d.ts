/** esbuild bundles CSS imports; TypeScript just needs to know the module exists. */
declare module "*.css";

/** Injected by esbuild: "<ISO time> <short hash of src/>". */
declare const __BUILD_STAMP__: string;

/** Injected by esbuild: the contents of pty-bridge.py, written out at runtime. */
declare const __PTY_BRIDGE_SOURCE__: string;
