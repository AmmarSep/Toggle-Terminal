import { spawn as spawnPiped, type ChildProcess, type StdioOptions } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Writable } from "node:stream";
import { Platform } from "obsidian";

/* -------------------------------------------------------------------------- */
/* Structural typings for node-pty                                            */
/* -------------------------------------------------------------------------- */
/*
 * node-pty is a native module. It is resolved at runtime from the plugin
 * folder rather than bundled, so we describe only the surface we use instead
 * of taking a compile-time dependency on its typings.
 */

interface NodePtyDisposable {
	dispose(): void;
}

interface NodePtyExitEvent {
	exitCode: number;
	signal?: number | undefined;
}

interface NodePtyProcess {
	readonly pid: number;
	readonly cols: number;
	readonly rows: number;
	onData(listener: (data: string) => void): NodePtyDisposable;
	onExit(listener: (event: NodePtyExitEvent) => void): NodePtyDisposable;
	write(data: string): void;
	resize(columns: number, rows: number): void;
	kill(signal?: string): void;
}

interface NodePtySpawnOptions {
	name?: string;
	cols?: number;
	rows?: number;
	cwd?: string;
	env?: Record<string, string | undefined>;
	encoding?: string | null;
	useConpty?: boolean;
}

interface NodePtyModule {
	spawn(file: string, args: readonly string[] | string, options: NodePtySpawnOptions): NodePtyProcess;
}

function isNodePtyModule(value: unknown): value is NodePtyModule {
	return typeof value === "object" && value !== null && typeof (value as NodePtyModule).spawn === "function";
}

/** Electron exposes CommonJS `require` on `window`; esbuild must not rewrite it. */
type RuntimeRequire = (id: string) => unknown;

function runtimeRequire(): RuntimeRequire | null {
	const candidate = (window as unknown as { require?: unknown }).require;
	return typeof candidate === "function" ? (candidate as RuntimeRequire) : null;
}

let cachedPty: NodePtyModule | null | undefined;

/**
 * Packages providing the same `spawn()` surface, best first.
 *
 * `@lydell/node-pty` ships prebuilt N-API binaries per platform (including
 * ConPTY for Windows), so it needs no compiler and no electron-rebuild —
 * N-API is ABI-stable across Node and Electron. Upstream `node-pty` is tried
 * second for anyone who already built it.
 */
const PTY_PACKAGES = ["@lydell/node-pty", "node-pty"];

/**
 * Try to load a pty module. Obsidian's `require` does not resolve from the
 * plugin folder, so absolute candidates are tried first.
 *
 * @param pluginDir Absolute path to the installed plugin directory, if known.
 */
export function loadNodePty(pluginDir: string | null): NodePtyModule | null {
	if (cachedPty !== undefined) return cachedPty;

	const req = runtimeRequire();
	if (!req) {
		cachedPty = null;
		return cachedPty;
	}

	for (const candidate of ptyCandidates(pluginDir)) {
		try {
			const loaded = req(candidate);
			if (isNodePtyModule(loaded)) {
				cachedPty = loaded;
				return cachedPty;
			}
		} catch {
			/* try the next candidate */
		}
	}

	cachedPty = null;
	return cachedPty;
}

export function resetPtyCache(): void {
	cachedPty = undefined;
}

/** Absolute plugin-folder paths first; `path.join` keeps Windows separators sane. */
function ptyCandidates(pluginDir: string | null): string[] {
	const candidates: string[] = [];
	for (const pkg of PTY_PACKAGES) {
		if (pluginDir) candidates.push(path.join(pluginDir, "node_modules", ...pkg.split("/")));
		candidates.push(pkg);
	}
	return candidates;
}

export interface PtyProbe {
	candidate: string;
	result: "loaded" | "missing" | "error";
	detail: string;
}

/**
 * Try every candidate and report what happened, for the diagnostics panel.
 * "It failed" is not actionable; "MODULE_NOT_FOUND at <path>" is.
 */
export function probePty(pluginDir: string | null): PtyProbe[] {
	const req = runtimeRequire();
	if (!req) return [{ candidate: "window.require", result: "error", detail: "not available" }];

	return ptyCandidates(pluginDir).map((candidate) => {
		try {
			const loaded = req(candidate);
			return isNodePtyModule(loaded)
				? { candidate, result: "loaded" as const, detail: "spawn() present" }
				: { candidate, result: "error" as const, detail: "loaded but has no spawn()" };
		} catch (error) {
			const err = error as { code?: string; message?: string };
			const missing = err.code === "MODULE_NOT_FOUND";
			return {
				candidate,
				result: missing ? ("missing" as const) : ("error" as const),
				detail: (err.message ?? String(error)).split("\n")[0].slice(0, 160),
			};
		}
	});
}

/** Which platform binaries are actually sitting in the plugin folder. */
export function installedPtyBinaries(pluginDir: string | null): string[] {
	if (!pluginDir) return [];
	const scope = path.join(pluginDir, "node_modules", "@lydell");
	try {
		return readdirSync(scope)
			.filter((name) => name.startsWith("node-pty-"))
			.sort();
	} catch {
		return [];
	}
}

/* -------------------------------------------------------------------------- */
/* Session abstraction                                                        */
/* -------------------------------------------------------------------------- */

/**
 * - `pty`    real TTY through node-pty.
 * - `bridge` real TTY through the bundled Python pty bridge.
 * - `piped`  plain pipes, no TTY. The view supplies local echo.
 *
 * The first two are equivalent from the user's point of view; both are
 * resizable and run interactive programs.
 */
export type SessionKind = "pty" | "bridge" | "piped";

export interface TerminalSession {
	readonly kind: SessionKind;
	readonly pid: number | undefined;
	readonly alive: boolean;
	onData(listener: (chunk: string) => void): void;
	onExit(listener: (exitCode: number) => void): void;
	write(data: string): void;
	resize(columns: number, rows: number): void;
	dispose(): void;
}

export interface SpawnRequest {
	file: string;
	args: readonly string[];
	cwd: string | undefined;
	cols: number;
	rows: number;
	env: Record<string, string | undefined>;
	pluginDir: string | null;
	/** Settings override for the interpreter that runs the pty bridge. */
	pythonPath: string | null;
}

interface Command {
	file: string;
	args: string[];
}

abstract class BaseSession implements TerminalSession {
	protected dataListeners: Array<(chunk: string) => void> = [];
	protected exitListeners: Array<(exitCode: number) => void> = [];
	protected disposed = false;

	abstract readonly kind: SessionKind;
	abstract readonly pid: number | undefined;

	get alive(): boolean {
		return !this.disposed;
	}

	onData(listener: (chunk: string) => void): void {
		this.dataListeners.push(listener);
	}

	onExit(listener: (exitCode: number) => void): void {
		this.exitListeners.push(listener);
	}

	protected emitData(chunk: string): void {
		for (const listener of this.dataListeners) listener(chunk);
	}

	protected emitExit(exitCode: number): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const listener of this.exitListeners) listener(exitCode);
	}

	abstract write(data: string): void;
	abstract resize(columns: number, rows: number): void;
	abstract dispose(): void;
}

class PtySession extends BaseSession {
	override readonly kind = "pty" as const;
	private readonly process: NodePtyProcess;
	private readonly subscriptions: NodePtyDisposable[] = [];

	constructor(module: NodePtyModule, request: SpawnRequest) {
		super();
		this.process = module.spawn(request.file, [...request.args], {
			name: "xterm-256color",
			cols: request.cols,
			rows: request.rows,
			cwd: request.cwd,
			env: request.env,
			encoding: "utf8",
		});
		this.subscriptions.push(this.process.onData((data) => this.emitData(data)));
		this.subscriptions.push(this.process.onExit((event) => this.emitExit(event.exitCode)));
	}

	override get pid(): number | undefined {
		return this.process.pid;
	}

	override write(data: string): void {
		if (this.disposed) return;
		this.process.write(data);
	}

	override resize(columns: number, rows: number): void {
		if (this.disposed) return;
		if (columns < 1 || rows < 1) return;
		try {
			this.process.resize(columns, rows);
		} catch {
			/* the pty may have exited between the resize observer and this call */
		}
	}

	override dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const subscription of this.subscriptions) subscription.dispose();
		this.subscriptions.length = 0;
		try {
			this.process.kill();
		} catch {
			/* already gone */
		}
	}
}

/**
 * Child process over plain pipes. Used for both the Python pty bridge and the
 * bare no-TTY fallback; only the command, the stdio shape and the kind differ.
 */
class ChildSession extends BaseSession {
	override readonly kind: SessionKind;
	private readonly child: ChildProcess;
	private readonly detached: boolean;
	private processExited = false;

	constructor(request: SpawnRequest, command: Command, kind: SessionKind) {
		super();
		this.kind = kind;
		// A process group lets dispose() take the bridge's whole subtree down.
		this.detached = kind === "bridge" && !Platform.isWin;

		const env = kind === "piped" ? { ...request.env, TERM: "dumb" } : { ...request.env };
		// fd 3 is the bridge's resize channel.
		const stdio: StdioOptions =
			kind === "bridge" ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"];

		this.child = spawnPiped(command.file, command.args, {
			cwd: request.cwd,
			env: env as NodeJS.ProcessEnv,
			windowsHide: true,
			detached: this.detached,
			stdio,
		});

		this.child.stdout?.setEncoding("utf8");
		this.child.stderr?.setEncoding("utf8");
		this.child.stdout?.on("data", (chunk: string) => this.emitData(chunk));
		this.child.stderr?.on("data", (chunk: string) => this.emitData(chunk));
		this.child.stdin?.on("error", () => {
			/* the shell closed stdin first; nothing to recover */
		});
		this.child.on("error", (error: Error) => this.emitData(`\r\n[toggle-terminal] ${error.message}\r\n`));
		this.child.on("exit", (code) => {
			this.processExited = true;
			this.emitExit(code ?? 0);
		});
	}

	override get pid(): number | undefined {
		return this.child.pid;
	}

	override write(data: string): void {
		if (this.disposed) return;
		this.child.stdin?.write(data);
	}

	override resize(columns: number, rows: number): void {
		if (this.disposed || this.kind !== "bridge") return;
		if (columns < 1 || rows < 1) return;
		try {
			this.controlStream()?.write(`${rows} ${columns}\n`);
		} catch {
			/* the bridge exited between the resize observer and this call */
		}
	}

	/** fd 3, where the bridge listens for "<rows> <cols>" lines. */
	private controlStream(): Writable | null {
		const stream = this.child.stdio[3];
		if (stream && typeof (stream as Writable).write === "function") {
			return stream as Writable;
		}
		return null;
	}

	override dispose(): void {
		if (this.disposed) return;
		this.disposed = true;

		if (Platform.isWin) {
			this.killTreeOnWindows();
			return;
		}

		this.signal("SIGTERM");
		// An interactive shell ignores SIGTERM, so escalate. SIGKILL on the whole
		// process group also reaps background jobs the user started.
		window.setTimeout(() => {
			if (!this.processExited) this.signal("SIGKILL");
		}, 400);
	}

	/**
	 * Windows has no process groups to signal, and `child.kill()` terminates
	 * only the shell — anything it launched is orphaned. taskkill /T walks the
	 * tree, which is the closest equivalent to SIGKILL on a process group.
	 */
	private killTreeOnWindows(): void {
		const pid = this.child.pid;
		if (pid === undefined) return;
		try {
			const killer = spawnPiped("taskkill", ["/PID", String(pid), "/T", "/F"], {
				windowsHide: true,
				stdio: "ignore",
			});
			killer.unref();
		} catch {
			try {
				this.child.kill();
			} catch {
				/* already gone */
			}
		}
	}

	private signal(signal: NodeJS.Signals): void {
		const pid = this.child.pid;
		try {
			if (this.detached && pid !== undefined) {
				process.kill(-pid, signal);
			} else {
				this.child.kill(signal);
			}
		} catch {
			/* already gone */
		}
	}
}

/* -------------------------------------------------------------------------- */
/* Backend selection                                                          */
/* -------------------------------------------------------------------------- */

export const BRIDGE_SCRIPT = "pty-bridge.py";

/**
 * Materialise the bridge next to main.js.
 *
 * Obsidian only installs main.js, manifest.json and styles.css from a release,
 * so the script is embedded in the bundle at build time and written here on
 * demand. Rewritten whenever the contents differ, which covers both a fresh
 * install and a plugin update carrying a newer bridge.
 */
export function ensureBridgeScript(pluginDir: string | null): string | null {
	if (!pluginDir) return null;

	const target = path.join(pluginDir, BRIDGE_SCRIPT);
	try {
		let current: string | null = null;
		try {
			current = readFileSync(target, "utf8");
		} catch {
			current = null;
		}
		if (current !== __PTY_BRIDGE_SOURCE__) {
			writeFileSync(target, __PTY_BRIDGE_SOURCE__, "utf8");
		}
		return target;
	} catch {
		// Read-only plugin folder: nothing we can do, the caller falls back.
		return existsSync(target) ? target : null;
	}
}

const PYTHON_CANDIDATES = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];

/**
 * macOS ships a `/usr/bin/python3` stub that pops up the Xcode installer when
 * the Command Line Tools are missing. Only trust it if they are present.
 */
function macPythonUsable(): boolean {
	return (
		existsSync("/Library/Developer/CommandLineTools/usr/bin/python3") || existsSync("/Applications/Xcode.app")
	);
}

export function findPython(override: string | null): string | null {
	if (Platform.isWin) return null;
	if (override && existsSync(override)) return override;

	for (const candidate of PYTHON_CANDIDATES) {
		if (!existsSync(candidate)) continue;
		if (candidate === "/usr/bin/python3" && Platform.isMacOS && !macPythonUsable()) continue;
		return candidate;
	}
	return null;
}

/**
 * `python3 pty-bridge.py <rows> <cols> <shell> [args…]`
 *
 * The bridge allocates a real pty and proxies it over pipes. Unlike script(1)
 * it tolerates a non-tty stdin — which is what Obsidian gives a child process —
 * and it accepts resize messages on fd 3.
 */
function bridgeCommand(request: SpawnRequest): Command | null {
	if (Platform.isWin || !request.pluginDir) return null;

	const bridge = ensureBridgeScript(request.pluginDir);
	if (!bridge) return null;

	const python = findPython(request.pythonPath);
	if (!python) return null;

	return {
		file: python,
		args: [
			bridge,
			String(Math.max(request.rows, 1)),
			String(Math.max(request.cols, 1)),
			request.file,
			...request.args,
		],
	};
}

/** Which backend would be used right now, without spawning anything. */
export function availableBackend(pluginDir: string | null, pythonPath: string | null): SessionKind {
	if (loadNodePty(pluginDir)) return "pty";
	if (!Platform.isWin && ensureBridgeScript(pluginDir) && findPython(pythonPath)) {
		return "bridge";
	}
	return "piped";
}

export function createSession(request: SpawnRequest): TerminalSession {
	const module = loadNodePty(request.pluginDir);
	if (module) return new PtySession(module, request);

	const bridge = bridgeCommand(request);
	if (bridge) return new ChildSession(request, bridge, "bridge");

	return new ChildSession(request, { file: request.file, args: [...request.args] }, "piped");
}

/* -------------------------------------------------------------------------- */
/* Platform defaults                                                          */
/* -------------------------------------------------------------------------- */

/** COMSPEC on Windows (normally cmd.exe), $SHELL elsewhere. */
export function detectShell(): string {
	if (Platform.isWin) {
		return process.env.COMSPEC ?? "powershell.exe";
	}
	return process.env.SHELL ?? "/bin/bash";
}

/** Line terminator the platform's shells expect from piped input. */
export const SHELL_EOL = Platform.isWin ? "\r\n" : "\n";

export function defaultShellArgs(shell: string, loginShell: boolean): string[] {
	const name = (shell.split(/[\\/]/).pop() ?? shell).toLowerCase();

	if (Platform.isWin) {
		// /Q turns echo off. Without it cmd repeats every command it reads from
		// the pipe, which shows up twice next to the fallback's own local echo.
		return name === "cmd.exe" ? ["/Q"] : [];
	}

	if (name === "cmd.exe" || name === "nu") return [];
	return loginShell ? ["-l"] : [];
}

/** Split a settings string into argv, honouring simple quoting. */
export function parseArgs(raw: string): string[] {
	const matches = raw.match(/"[^"]*"|'[^']*'|\S+/g);
	if (!matches) return [];
	return matches.map((token) =>
		(token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))
			? token.slice(1, -1)
			: token,
	);
}

export function terminalEnv(): Record<string, string | undefined> {
	return {
		...process.env,
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
		TERM_PROGRAM: "Obsidian",
	};
}
