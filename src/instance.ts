import { Keymap, Platform, setIcon, type TFile } from "obsidian";
import { Terminal, type IDisposable, type ILinkHandler, type IWindowsPty } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import * as os from "node:os";

import type ToggleTerminalPlugin from "./main";
import { routeKey, type KeyLike, type TerminalCommand } from "./keys";
import { VaultLinkProvider } from "./links";
import { createSession, SHELL_EOL, type SessionKind, type TerminalSession } from "./pty";
import { toSingleLine } from "./send";
import { obsidianMonospaceFont, obsidianTerminalTheme, themeHex } from "./theme";

/** What an instance needs from whoever hosts it (the dock). */
export interface InstanceHost {
	readonly plugin: ToggleTerminalPlugin;
	/** Title, activity, bell, progress or exit state changed. */
	instanceChanged(instance: TerminalInstance): void;
	/** The shell exited on its own. */
	instanceExited(instance: TerminalInstance, code: number): void;
	/** Is this instance on screen right now (panel shown, tab selected)? */
	isOnScreen(instance: TerminalInstance): boolean;
	/** Panel-level shortcuts pressed inside the terminal. */
	runPanelCommand(instance: TerminalInstance, command: TerminalCommand): void;
	showContextMenu(instance: TerminalInstance, event: MouseEvent): void;
	notify(instance: TerminalInstance, message: string, kind: "bell" | "message"): void;
}

export interface InstanceOptions {
	/** Absolute starting directory. Defaults to the configured working directory. */
	cwd?: string;
	/** Typed at the prompt once the shell is ready, then Enter. */
	command?: string;
	/** Fixed tab name, e.g. a launch profile's. */
	name?: string;
}

interface FindOptions {
	caseSensitive: boolean;
	regex: boolean;
	wholeWord: boolean;
}

/** OSC 9;4 progress, as emitted by Windows Terminal-aware CLIs. */
export interface ProgressState {
	/** 1 normal, 2 error, 3 indeterminate, 4 paused. */
	state: number;
	value: number;
}

const BACKEND_LABEL: Record<SessionKind, string> = {
	pty: "pty",
	bridge: "pty via bridge",
	piped: "no TTY · line mode",
};

/** Sessions younger than this may not have drawn a prompt yet. */
const FRESH_SESSION_MS = 6000;

const MAX_WEBGL_FAILURES = 3;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function baseName(file: string): string {
	return file.split(/[\\/]/).pop() ?? file;
}

/**
 * ConPTY does not move rows back into the viewport the way a Unix pty does —
 * it appends empty rows instead, so growing the terminal can drop data. Telling
 * xterm the pty is Windows-hosted enables its compensation for that.
 */
function windowsPtyInfo(): IWindowsPty | undefined {
	if (!Platform.isWin) return undefined;
	const build = Number.parseInt(os.release().split(".")[2] ?? "", 10);
	return {
		backend: "conpty",
		...(Number.isFinite(build) ? { buildNumber: build } : {}),
	};
}

/** `file://host/path%20x` → `/path x`; Windows drive paths lose the leading slash. */
export function parseFileUri(uri: string): string | null {
	if (!uri.startsWith("file://")) return null;
	const afterScheme = uri.slice("file://".length);
	const slash = afterScheme.indexOf("/");
	if (slash < 0) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(afterScheme.slice(slash));
	} catch {
		return null;
	}
	return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
}

/** Linear blend of two `#rrggbb` colours. */
function mix(a: string, b: string, amount: number): string {
	const channel = (hex: string, index: number): number => Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
	return (
		"#" +
		[0, 1, 2]
			.map((i) => Math.round(channel(a, i) * (1 - amount) + channel(b, i) * amount))
			.map((value) => Math.min(255, Math.max(0, value)).toString(16).padStart(2, "0"))
			.join("")
	);
}

export class TerminalInstance {
	private static nextId = 1;

	readonly id: number;
	/** Root element: the xterm surface plus the find bar. */
	readonly el: HTMLElement;
	private readonly surfaceEl: HTMLElement;

	private terminal: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private searchAddon: SearchAddon | null = null;
	private webgl: WebglAddon | null = null;
	/** Exceptions plus lost contexts; after a few, this terminal stays on the DOM renderer. */
	private webglFailures = 0;
	private session: TerminalSession | null = null;

	private readonly disposables: IDisposable[] = [];
	private readonly domCleanup: Array<() => void> = [];
	private resizeObserver: ResizeObserver | null = null;
	private pendingFit = 0;
	private resizeTimer = 0;
	private resizePending = false;
	private sentCols = 0;
	private sentRows = 0;

	private started = false;
	private disposed = false;
	private exited = false;
	private exitCode: number | null = null;
	private hasOutput = false;
	private lastOutputAt = 0;
	private sessionStartedAt = 0;

	/** Local line editing state, used only by the no-TTY fallback. */
	private lineBuffer = "";
	private promptTimer = 0;

	private copyTimer = 0;
	private processCheckAt = 0;
	private processTimer = 0;
	private lastNotifyAt = 0;
	private wheelZoomAt = 0;

	/** Which xterm renderer is active; surfaced in diagnostics. */
	renderer: "webgl" | "dom" = "dom";

	/** Set by the user; wins over everything else. */
	customTitle: string | null = null;
	private oscTitle = "";
	private processTitle = "";
	private readonly shellName: string;

	/** Unseen output while off screen. */
	activity = false;
	/** Bell or notification while off screen. */
	bell = false;
	progress: ProgressState | null = null;

	/** Directory the session started in. */
	readonly startDirectory: string | undefined;
	/** Latest directory reported by the shell (OSC 7), if it reports one. */
	private reportedDirectory: string | null = null;

	private findEl: HTMLElement | null = null;
	private findInput: HTMLInputElement | null = null;
	private findCountEl: HTMLElement | null = null;
	private findOptions: FindOptions = { caseSensitive: false, regex: false, wholeWord: false };

	constructor(
		private readonly host: InstanceHost,
		private readonly options: InstanceOptions = {},
	) {
		this.id = TerminalInstance.nextId++;
		this.el = createDiv({ cls: "tt-instance" });
		this.surfaceEl = this.el.createDiv({ cls: "tt-surface" });
		this.startDirectory = options.cwd ?? host.plugin.resolveWorkingDirectory();
		this.shellName = baseName(host.plugin.resolveShell().file).replace(/\.exe$/i, "");
	}

	/* ---------------------------------------------------------------- */
	/* Identity                                                         */
	/* ---------------------------------------------------------------- */

	get title(): string {
		return this.customTitle || this.oscTitle || this.processTitle || this.options.name || this.shellName;
	}

	get isExited(): boolean {
		return this.exited;
	}

	get backend(): SessionKind | null {
		return this.session?.kind ?? null;
	}

	get pid(): number | undefined {
		return this.session?.pid;
	}

	/** True when something other than the shell itself is in the foreground. */
	get isBusy(): boolean {
		if (this.exited || !this.session) return false;
		this.refreshProcessTitle(true);
		return this.processTitle.length > 0;
	}

	/** Best guess at the shell's current directory. */
	currentDirectory(): string | undefined {
		return this.reportedDirectory ?? this.startDirectory;
	}

	describe(): string {
		const parts = [this.shellName];
		if (this.session) parts.push(BACKEND_LABEL[this.session.kind]);
		if (this.session?.pid) parts.push(`pid ${this.session.pid}`);
		if (this.exited) parts.push(`exited (${this.exitCode ?? "?"})`);
		const cwd = this.currentDirectory();
		return cwd ? `${parts.join(" · ")}\n${cwd}` : parts.join(" · ");
	}

	/* ---------------------------------------------------------------- */
	/* Lifecycle                                                        */
	/* ---------------------------------------------------------------- */

	/**
	 * Attach to `parent` and spawn the shell. The parent must be laid out:
	 * xterm measures the font on open and the pty is created at that size.
	 */
	start(parent: HTMLElement): void {
		if (this.started) return;
		this.started = true;
		parent.appendChild(this.el);
		this.el.addClass("is-active");

		this.createTerminal();
		this.fitNow();
		this.startSession();

		this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
		this.resizeObserver.observe(this.surfaceEl);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.pendingFit !== 0) window.cancelAnimationFrame(this.pendingFit);
		window.clearTimeout(this.resizeTimer);
		window.clearTimeout(this.copyTimer);
		window.clearTimeout(this.processTimer);
		this.clearPromptTimer();
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		for (const disposable of this.disposables.splice(0)) {
			try {
				disposable.dispose();
			} catch {
				/* already gone */
			}
		}
		for (const cleanup of this.domCleanup.splice(0)) cleanup();
		this.session?.dispose();
		this.session = null;
		this.detachRenderer();
		this.terminal?.dispose();
		this.terminal = null;
		this.fitAddon = null;
		this.searchAddon = null;
		this.el.remove();
	}

	/** Tab switching. Hidden instances give their WebGL context back. */
	setVisible(visible: boolean): void {
		this.el.toggleClass("is-active", visible);
		if (!visible) {
			this.detachRenderer();
			return;
		}
		this.markSeen();
		this.attachRenderer();
		this.scheduleFit();
		const terminal = this.terminal;
		if (terminal) terminal.refresh(0, terminal.rows - 1);
	}

	/** Clears the activity and bell markers. */
	markSeen(): void {
		if (!this.activity && !this.bell) return;
		this.activity = false;
		this.bell = false;
		this.host.instanceChanged(this);
	}

	focus(): void {
		this.terminal?.focus();
	}

	hasFocus(): boolean {
		const active = this.el.ownerDocument.activeElement;
		return active !== null && this.el.contains(active);
	}

	private listen<K extends keyof HTMLElementEventMap>(
		el: HTMLElement,
		type: K,
		handler: (event: HTMLElementEventMap[K]) => void,
	): void {
		el.addEventListener(type, handler);
		this.domCleanup.push(() => el.removeEventListener(type, handler));
	}

	/* ---------------------------------------------------------------- */
	/* xterm                                                            */
	/* ---------------------------------------------------------------- */

	private createTerminal(): void {
		const { settings } = this.host.plugin;

		const terminal = new Terminal({
			allowProposedApi: true,
			cursorBlink: settings.cursorBlink,
			cursorStyle: settings.cursorStyle,
			cursorInactiveStyle: "outline",
			drawBoldTextInBrightColors: true,
			fontSize: this.host.plugin.effectiveFontSize(),
			fontFamily: settings.fontFamily || obsidianMonospaceFont(this.el),
			lineHeight: settings.lineHeight,
			macOptionIsMeta: true,
			macOptionClickForcesSelection: true,
			rightClickSelectsWord: Platform.isMacOS,
			rescaleOverlappingGlyphs: true,
			scrollback: settings.scrollback,
			theme: obsidianTerminalTheme(this.el),
			windowsPty: windowsPtyInfo(),
			linkHandler: this.hyperlinkHandler(),
		});
		this.terminal = terminal;

		this.fitAddon = new FitAddon();
		terminal.loadAddon(this.fitAddon);

		this.searchAddon = new SearchAddon({ highlightLimit: 2000 });
		terminal.loadAddon(this.searchAddon);
		this.disposables.push(this.searchAddon.onDidChangeResults((event) => this.updateFindCount(event.resultIndex, event.resultCount)));

		// Emoji and CJK are two columns wide in every modern terminal; xterm's
		// default (Unicode 6) makes them one, which shears TUIs like Claude Code.
		terminal.loadAddon(new Unicode11Addon());
		terminal.unicode.activeVersion = "11";

		terminal.loadAddon(
			new WebLinksAddon((event, uri) => this.openExternal(event, uri), {
				hover: () => this.showLinkHint("Open link"),
				leave: () => this.clearLinkHint(),
			}),
		);
		this.disposables.push(
			terminal.registerLinkProvider(
				new VaultLinkProvider<TFile>(terminal, {
					resolvePath: (candidate) => this.host.plugin.resolveVaultFile(candidate, this.currentDirectory()),
					resolveWikilink: (linkpath) => this.host.plugin.resolveWikilink(linkpath),
					activate: (event, file, line) => {
						if (!this.shouldActivateLink(event)) return;
						void this.host.plugin.openVaultFile(file, line, event);
					},
					hover: (_event, file) => this.showLinkHint(`Open ${file.path}`),
					leave: () => this.clearLinkHint(),
				}),
			),
		);

		terminal.open(this.surfaceEl);
		this.attachRenderer();

		this.disposables.push(
			terminal.onData((data) => this.handleInput(data)),
			terminal.onBinary((data) => this.handleInput(data)),
			terminal.onTitleChange((title) => {
				this.oscTitle = title.trim();
				this.host.instanceChanged(this);
			}),
			terminal.onBell(() => this.handleBell()),
			terminal.onSelectionChange(() => this.handleSelectionChange()),
		);
		this.registerOscHandlers(terminal);

		terminal.attachCustomKeyEventHandler((event) => this.handleKeyEvent(event));
		terminal.attachCustomWheelEventHandler((event) => this.handleWheel(event));

		// The padding around the canvas is not xterm's, so focus it by hand.
		this.listen(this.surfaceEl, "mousedown", (event) => {
			if (event.target === this.surfaceEl) window.setTimeout(() => this.focus(), 0);
		});
		this.listen(this.el, "contextmenu", (event) => this.handleContextMenu(event));
		this.listen(this.el, "dragover", (event) => this.handleDragOver(event));
		this.listen(this.el, "dragleave", (event) => {
			if (!(event.relatedTarget instanceof Node) || !this.el.contains(event.relatedTarget)) {
				this.el.removeClass("is-drop-target");
			}
		});
		this.listen(this.el, "drop", (event) => this.handleDrop(event));
	}

	/**
	 * xterm's DOM renderer struggles with ConPTY's redraw traffic and with
	 * Claude Code's full-screen repaints; WebGL does not. Lost contexts (GPU
	 * reset, driver update, too many contexts) fall back to the DOM renderer.
	 */
	private attachRenderer(): void {
		const terminal = this.terminal;
		if (!terminal || this.webgl) return;
		if (this.host.plugin.settings.renderer !== "auto" || this.webglFailures >= MAX_WEBGL_FAILURES) {
			this.renderer = "dom";
			return;
		}
		try {
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => {
				if (this.webgl !== webgl) return;
				this.webglFailures += 1;
				this.detachRenderer();
				// Try again once the GPU has settled, if this terminal is on screen.
				window.setTimeout(() => {
					if (!this.disposed && this.el.hasClass("is-active")) this.attachRenderer();
				}, 1000);
			});
			terminal.loadAddon(webgl);
			this.webgl = webgl;
			this.renderer = "webgl";
		} catch {
			this.webglFailures += 1;
			this.webgl = null;
			this.renderer = "dom";
		}
	}

	private detachRenderer(): void {
		const webgl = this.webgl;
		this.webgl = null;
		this.renderer = "dom";
		if (!webgl) return;
		try {
			webgl.dispose();
		} catch {
			/* context already gone */
		}
	}

	/** Re-read settings and theme. Cheap; called on any settings or CSS change. */
	applySettings(): void {
		const terminal = this.terminal;
		if (!terminal) return;
		const { settings } = this.host.plugin;
		terminal.options.theme = obsidianTerminalTheme(this.el);
		terminal.options.fontSize = this.host.plugin.effectiveFontSize();
		terminal.options.fontFamily = settings.fontFamily || obsidianMonospaceFont(this.el);
		terminal.options.lineHeight = settings.lineHeight;
		terminal.options.cursorStyle = settings.cursorStyle;
		terminal.options.cursorBlink = settings.cursorBlink;
		terminal.options.scrollback = settings.scrollback;

		if (settings.renderer === "auto") {
			if (this.el.hasClass("is-active")) this.attachRenderer();
		} else {
			this.detachRenderer();
		}
		this.scheduleFit();
	}

	/* ---------------------------------------------------------------- */
	/* Fitting                                                          */
	/* ---------------------------------------------------------------- */

	scheduleFit(): void {
		if (this.pendingFit !== 0 || this.disposed) return;
		this.pendingFit = window.requestAnimationFrame(() => {
			this.pendingFit = 0;
			this.fitNow();
		});
	}

	private fitNow(): void {
		const terminal = this.terminal;
		const fitAddon = this.fitAddon;
		if (!terminal || !fitAddon) return;

		// A hidden panel measures as zero, and fitting to that corrupts the buffer.
		if (this.surfaceEl.offsetParent === null) return;
		if (this.surfaceEl.clientWidth < 24 || this.surfaceEl.clientHeight < 12) return;

		const dimensions = fitAddon.proposeDimensions();
		if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return;
		const cols = Math.max(dimensions.cols, 2);
		const rows = Math.max(dimensions.rows, 1);
		if (cols !== terminal.cols || rows !== terminal.rows) {
			try {
				terminal.resize(cols, rows);
			} catch {
				return;
			}
		}
		this.queuePtyResize();
	}

	/**
	 * Every pty resize is a SIGWINCH and a full repaint for TUIs. Dragging the
	 * divider produces dozens per second, so the first goes out at once and the
	 * rest collapse into one trailing resize.
	 */
	private queuePtyResize(): void {
		if (this.resizeTimer !== 0) {
			this.resizePending = true;
			return;
		}
		this.sendPtyResize();
		this.resizeTimer = window.setTimeout(() => {
			this.resizeTimer = 0;
			if (this.resizePending) {
				this.resizePending = false;
				this.sendPtyResize();
			}
		}, 80);
	}

	private sendPtyResize(): void {
		const terminal = this.terminal;
		if (!terminal || !this.session) return;
		if (terminal.cols === this.sentCols && terminal.rows === this.sentRows) return;
		this.sentCols = terminal.cols;
		this.sentRows = terminal.rows;
		this.session.resize(terminal.cols, terminal.rows);
	}

	/* ---------------------------------------------------------------- */
	/* Session                                                          */
	/* ---------------------------------------------------------------- */

	private startSession(): void {
		const terminal = this.terminal;
		if (!terminal) return;
		const { plugin } = this.host;
		const { file, args } = plugin.resolveShell();

		this.exited = false;
		this.exitCode = null;
		this.hasOutput = false;
		this.lineBuffer = "";
		this.sessionStartedAt = Date.now();

		let session: TerminalSession;
		try {
			session = createSession({
				file,
				args,
				cwd: this.startDirectory,
				cols: terminal.cols,
				rows: terminal.rows,
				env: plugin.terminalEnvironment(),
				pluginDir: plugin.pluginDirectory(),
				pythonPath: plugin.settings.pythonPath || null,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			terminal.writeln(`\x1b[31mFailed to start ${file}: ${message}\x1b[0m`);
			terminal.writeln("\x1b[90mCheck the shell path in Settings → Toggle Terminal, then press Enter to retry.\x1b[0m");
			this.exited = true;
			this.host.instanceChanged(this);
			return;
		}

		this.session = session;
		this.sentCols = terminal.cols;
		this.sentRows = terminal.rows;
		session.onData((chunk) => {
			if (this.session === session) this.handleOutput(chunk);
		});
		session.onExit((code) => {
			if (this.session === session) this.handleExit(code);
		});

		this.announceBackend(session.kind);
		if (this.options.command) void this.typeCommand(this.options.command);
		this.host.instanceChanged(this);
	}

	private get lineMode(): boolean {
		return this.session?.kind === "piped";
	}

	/** One-line note when the session is running on a degraded backend. */
	private announceBackend(kind: SessionKind): void {
		const terminal = this.terminal;
		if (!terminal || kind !== "piped") return;

		terminal.writeln("\x1b[33mNo TTY available — line mode.\x1b[0m");
		terminal.writeln(
			"\x1b[90mType a command and press Enter. Interactive programs (vim, ssh prompts, claude) will not work here.\x1b[0m",
		);
		// The binaries do not travel over Obsidian Sync, so say what to run.
		terminal.writeln(
			`\x1b[90mFix: run \x1b[0mnpm install @lydell/node-pty\x1b[90m in ${this.host.plugin.pluginDirectory() ?? "the plugin folder"}, then reload the plugin.\x1b[0m`,
		);
		this.writePrompt();
	}

	private handleOutput(chunk: string): void {
		this.hasOutput = true;
		this.lastOutputAt = Date.now();
		this.terminal?.write(chunk);
		if (this.lineMode) this.schedulePrompt();

		if (!this.activity && !this.host.isOnScreen(this)) {
			this.activity = true;
			this.host.instanceChanged(this);
		}
		this.refreshProcessTitle(false);
	}

	/**
	 * Foreground program name for the tab ("vim", "claude"). Checked at most
	 * once a second, with a trailing check so the title cannot stay stuck on a
	 * program that finished inside the throttle window.
	 */
	private refreshProcessTitle(force: boolean): void {
		const now = Date.now();
		const wait = this.processCheckAt + 1000 - now;
		if (!force && wait > 0) {
			if (this.processTimer === 0) {
				this.processTimer = window.setTimeout(() => {
					this.processTimer = 0;
					this.refreshProcessTitle(true);
				}, wait);
			}
			return;
		}
		this.processCheckAt = now;

		const name = (this.session?.processName ?? "").replace(/^-/, "");
		const base = baseName(name).replace(/\.exe$/i, "");
		const next = base.length === 0 || base === this.shellName ? "" : base;
		if (next !== this.processTitle) {
			this.processTitle = next;
			this.host.instanceChanged(this);
		}
	}

	private handleInput(data: string): void {
		if (this.exited) {
			// Any Enter press after the shell exits starts a fresh session.
			if (data.includes("\r") || data.includes("\n")) this.restart();
			return;
		}
		if (this.lineMode) {
			this.handleLineModeInput(data);
			return;
		}
		this.session?.write(data);
	}

	private handleExit(code: number): void {
		this.exited = true;
		this.exitCode = code;
		this.processTitle = "";
		this.progress = null;
		this.terminal?.writeln(`\r\n\x1b[90m[process exited with code ${code}] press Enter to restart\x1b[0m`);
		this.host.instanceChanged(this);
		this.host.instanceExited(this, code);
	}

	restart(): void {
		if (!this.terminal) return;
		this.clearPromptTimer();
		this.lineBuffer = "";
		this.session?.dispose();
		this.session = null;
		this.oscTitle = "";
		this.processTitle = "";
		this.progress = null;
		this.reportedDirectory = null;
		this.terminal.reset();
		this.startSession();
		this.scheduleFit();
		this.focus();
	}

	/**
	 * A shell spawned moments ago has not drawn its prompt yet, and input sent
	 * before then can be swallowed by its startup. Wait for output to go quiet —
	 * but only for a fresh session: a busy long-running one never goes quiet.
	 */
	private async waitForFreshPrompt(quietMs: number): Promise<void> {
		const deadline = this.sessionStartedAt + FRESH_SESSION_MS;
		while (Date.now() < deadline && !this.disposed) {
			if (this.hasOutput && Date.now() - this.lastOutputAt >= quietMs) return;
			await delay(40);
		}
	}

	/** Type a command at the prompt and press Enter (launch profiles). */
	private async typeCommand(command: string): Promise<void> {
		await this.waitForFreshPrompt(300);
		if (this.exited || !this.session) return;
		if (this.lineMode) {
			this.lineBuffer = "";
			this.terminal?.write(command);
			this.lineBuffer = command;
			this.handleLineModeInput("\r");
			return;
		}
		this.session.write(`${command}\r`);
	}

	/* ---------------------------------------------------------------- */
	/* Sending text in                                                  */
	/* ---------------------------------------------------------------- */

	/**
	 * Drop text at the prompt the way a real paste does: xterm wraps it in
	 * bracketed-paste markers only when the running program asked for them,
	 * so multi-line text waits for Enter in a shell and arrives intact in vim
	 * or Claude Code. With `execute`, Enter is pressed afterwards.
	 */
	async paste(text: string, execute = false): Promise<void> {
		if (text.length === 0) return;
		if (this.exited) this.restart();
		await this.waitForFreshPrompt(150);

		const terminal = this.terminal;
		if (!terminal || !this.session) return;

		if (this.lineMode) {
			// No line discipline here, so our own editor owns the buffer and the
			// echo. It is single-line only, hence the collapse.
			const single = toSingleLine(text);
			this.lineBuffer += single;
			terminal.write(single);
			if (execute) this.handleLineModeInput("\r");
		} else {
			terminal.paste(text);
			if (execute) this.session.write("\r");
		}
		terminal.scrollToBottom();
		this.focus();
	}

	async copySelection(): Promise<void> {
		const terminal = this.terminal;
		if (!terminal || !terminal.hasSelection()) return;
		await navigator.clipboard.writeText(terminal.getSelection());
		if (!Platform.isMacOS) terminal.clearSelection();
	}

	async pasteFromClipboard(): Promise<void> {
		const text = await navigator.clipboard.readText();
		if (text.length > 0) await this.paste(text);
	}

	hasSelection(): boolean {
		return this.terminal?.hasSelection() ?? false;
	}

	selectAll(): void {
		this.terminal?.selectAll();
	}

	clear(): void {
		this.terminal?.clear();
		this.focus();
	}

	/* ---------------------------------------------------------------- */
	/* Keyboard, mouse, drops                                           */
	/* ---------------------------------------------------------------- */

	/** Returns false to stop xterm from handling the key. */
	private handleKeyEvent(event: KeyboardEvent): boolean {
		const { plugin } = this.host;
		const { settings } = plugin;
		const route = routeKey(event, {
			isMac: Platform.isMacOS,
			hasSelection: this.terminal?.hasSelection() ?? false,
			passAppShortcuts: settings.passAppShortcuts,
			shiftEnterNewline: settings.shiftEnterNewline,
			ctrlCopyPaste: settings.ctrlCopyPaste,
			isAppHotkey: (candidate: KeyLike) => plugin.isPluginHotkey(candidate),
		});

		switch (route.kind) {
			case "app":
				return false;
			case "shell":
				// Stop Obsidian's global hotkeys from stealing shell keystrokes.
				if (settings.captureKeyboard && event.type === "keydown") event.stopPropagation();
				return true;
			case "native":
				event.stopPropagation();
				return false;
			case "swallow":
				event.preventDefault();
				event.stopPropagation();
				return false;
			case "send":
				event.preventDefault();
				event.stopPropagation();
				this.handleInput(route.data);
				return false;
			case "command":
				event.preventDefault();
				event.stopPropagation();
				this.runCommand(route.command);
				return false;
		}
	}

	runCommand(command: TerminalCommand): void {
		switch (command) {
			case "copy":
				void this.copySelection();
				break;
			case "paste":
				void this.pasteFromClipboard();
				break;
			case "selectAll":
				this.selectAll();
				break;
			case "clear":
				this.clear();
				break;
			case "find":
				this.openFind();
				break;
			case "zoomIn":
				this.host.plugin.zoom(1);
				break;
			case "zoomOut":
				this.host.plugin.zoom(-1);
				break;
			case "zoomReset":
				this.host.plugin.zoom(0);
				break;
			default:
				this.host.runPanelCommand(this, command);
		}
	}

	/** ⌘/Ctrl + wheel (and trackpad pinch, which arrives as Ctrl + wheel) zooms. */
	private handleWheel(event: WheelEvent): boolean {
		const zoomModifier = event.ctrlKey || (Platform.isMacOS && event.metaKey);
		if (!zoomModifier || event.shiftKey || event.altKey) return true;
		event.preventDefault();
		const now = Date.now();
		if (now - this.wheelZoomAt > 60 && event.deltaY !== 0) {
			this.wheelZoomAt = now;
			this.host.plugin.zoom(event.deltaY < 0 ? 1 : -1);
		}
		return false;
	}

	private handleSelectionChange(): void {
		if (!this.host.plugin.settings.copyOnSelect) return;
		window.clearTimeout(this.copyTimer);
		this.copyTimer = window.setTimeout(() => {
			const terminal = this.terminal;
			if (terminal?.hasSelection()) void navigator.clipboard.writeText(terminal.getSelection());
		}, 150);
	}

	private handleContextMenu(event: MouseEvent): void {
		// The find field keeps its native cut/copy/paste menu.
		if (event.target instanceof Element && event.target.closest(".tt-find")) return;
		// Programs that track the mouse (vim, htop) get the right button; Shift
		// forces the menu, as in most terminals.
		const tracking = this.terminal?.modes.mouseTrackingMode ?? "none";
		if (tracking !== "none" && !event.shiftKey) return;
		event.preventDefault();
		event.stopPropagation();
		this.host.showContextMenu(this, event);
	}

	private handleDragOver(event: DragEvent): void {
		if (!this.host.plugin.canDropOnTerminal(event)) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		this.el.addClass("is-drop-target");
	}

	private handleDrop(event: DragEvent): void {
		this.el.removeClass("is-drop-target");
		const text = this.host.plugin.textForDrop(event, this);
		if (text === null) return;
		event.preventDefault();
		event.stopPropagation();
		void this.paste(`${text} `);
	}

	/* ---------------------------------------------------------------- */
	/* Links                                                            */
	/* ---------------------------------------------------------------- */

	private shouldActivateLink(event: MouseEvent): boolean {
		return this.host.plugin.settings.linkActivation === "click" || Keymap.isModifier(event, "Mod");
	}

	private linkHint(action: string): string {
		if (this.host.plugin.settings.linkActivation === "click") return `${action} (click)`;
		return `${action} (${Platform.isMacOS ? "⌘" : "Ctrl"}+click)`;
	}

	private showLinkHint(action: string): void {
		this.surfaceEl.setAttr("title", this.linkHint(action));
	}

	private clearLinkHint(): void {
		this.surfaceEl.removeAttribute("title");
	}

	private openExternal(event: MouseEvent, uri: string): void {
		if (!this.shouldActivateLink(event)) return;
		window.open(uri, "_blank");
	}

	/** OSC 8 hyperlinks: web links open outside, file:// links into the vault open as notes. */
	private hyperlinkHandler(): ILinkHandler {
		return {
			allowNonHttpProtocols: true,
			activate: (event, uri) => {
				if (!this.shouldActivateLink(event)) return;
				void this.host.plugin.openHyperlink(uri, event, this.currentDirectory());
			},
			hover: (_event, uri) => this.showLinkHint(uri.startsWith("file://") ? "Open file" : `Open ${uri}`),
			leave: () => this.clearLinkHint(),
		};
	}

	/* ---------------------------------------------------------------- */
	/* Escape sequences: notifications, cwd, clipboard, progress        */
	/* ---------------------------------------------------------------- */

	private registerOscHandlers(terminal: Terminal): void {
		const { parser } = terminal;
		this.disposables.push(
			// OSC 7 — the shell reports its directory as file://host/path.
			parser.registerOscHandler(7, (data) => {
				const directory = parseFileUri(data.trim());
				if (directory) this.reportedDirectory = directory;
				return true;
			}),
			// OSC 9 — iTerm2-style notification, plus ConEmu subcommands.
			parser.registerOscHandler(9, (data) => this.handleOsc9(data)),
			// OSC 777;notify;title;body — urxvt, Ghostty, WezTerm.
			parser.registerOscHandler(777, (data) => {
				const [kind, title = "", ...body] = data.split(";");
				if (kind === "notify") this.notify([title, body.join(";")].filter((part) => part.length > 0).join(": "));
				return true;
			}),
			// OSC 99 — kitty's notification protocol: metadata;payload.
			parser.registerOscHandler(99, (data) => {
				const separator = data.indexOf(";");
				const metadata = separator >= 0 ? data.slice(0, separator) : "";
				const payload = separator >= 0 ? data.slice(separator + 1) : data;
				// Only plain-text titles/bodies; base64 (e=1) and queries (p=?) are skipped.
				if (!/(^|:)e=1(:|$)/.test(metadata) && !/(^|:)p=\?/.test(metadata) && payload.length > 0) this.notify(payload);
				return true;
			}),
			// OSC 52 — a program copying to the clipboard (tmux, vim, ssh sessions).
			parser.registerOscHandler(52, (data) => {
				const payload = data.slice(data.indexOf(";") + 1);
				if (payload === "?" || payload.length === 0 || payload.length > 1_500_000) return true;
				try {
					const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
					void navigator.clipboard.writeText(new TextDecoder().decode(bytes));
				} catch {
					/* malformed payload */
				}
				return true;
			}),
		);
	}

	private handleOsc9(data: string): boolean {
		const sub = /^(\d+);([\s\S]*)$/.exec(data);
		if (sub) {
			if (sub[1] === "4") {
				const [state = 0, value = 0] = sub[2].split(";").map((part) => Number.parseInt(part, 10) || 0);
				this.progress = state === 0 ? null : { state, value: Math.min(100, Math.max(0, value)) };
				this.host.instanceChanged(this);
				return true;
			}
			if (sub[1] === "9") {
				const directory = sub[2].replace(/^"|"$/g, "");
				if (directory.length > 0) this.reportedDirectory = directory;
				return true;
			}
			// Other ConEmu subcommands (sleep, message box, …) are not notifications.
			if (Number.parseInt(sub[1], 10) <= 12) return true;
		}
		this.notify(data);
		return true;
	}

	private handleBell(): void {
		if (this.host.isOnScreen(this) && document.hasFocus()) return;
		if (!this.bell) {
			this.bell = true;
			this.host.instanceChanged(this);
		}
		if (this.host.plugin.settings.notifyOnBell) this.sendNotification("Bell", "bell");
	}

	private notify(message: string): void {
		if (!this.host.plugin.settings.notifyOnMessage) return;
		if (this.host.isOnScreen(this) && document.hasFocus()) return;
		if (!this.bell) {
			this.bell = true;
			this.host.instanceChanged(this);
		}
		this.sendNotification(message.trim() || "Notification", "message");
	}

	private sendNotification(message: string, kind: "bell" | "message"): void {
		const now = Date.now();
		if (now - this.lastNotifyAt < 3000) return;
		this.lastNotifyAt = now;
		this.host.notify(this, message, kind);
	}

	/* ---------------------------------------------------------------- */
	/* Find                                                             */
	/* ---------------------------------------------------------------- */

	openFind(): void {
		if (!this.terminal) return;
		const input = this.findInput ?? this.buildFind();
		this.findEl?.removeClass("is-hidden");
		this.terminal.options.overviewRuler = { width: 10 };
		const selection = this.terminal.getSelection();
		if (selection.length > 0 && !selection.includes("\n")) input.value = selection;
		input.focus();
		input.select();
		if (input.value.length > 0) this.find(true, true);
	}

	closeFind(): void {
		if (!this.findEl || this.findEl.hasClass("is-hidden")) return;
		this.findEl.addClass("is-hidden");
		this.searchAddon?.clearDecorations();
		if (this.terminal) this.terminal.options.overviewRuler = {};
		this.focus();
	}

	private searchOptions(incremental: boolean): ISearchOptions {
		const background = themeHex(this.el, "--background-primary", "#1e1e1e");
		const highlight = themeHex(this.el, "--color-yellow", "#e0c050");
		const accent = themeHex(this.el, "--interactive-accent", "#7f6df2");
		return {
			...this.findOptions,
			incremental,
			decorations: {
				matchBackground: mix(background, highlight, 0.35),
				matchOverviewRuler: highlight,
				activeMatchBackground: mix(background, accent, 0.7),
				activeMatchColorOverviewRuler: accent,
			},
		};
	}

	private find(forward: boolean, incremental = false): void {
		const term = this.findInput?.value ?? "";
		const search = this.searchAddon;
		if (!search) return;
		if (term.length === 0) {
			search.clearDecorations();
			this.updateFindCount(-1, 0);
			return;
		}
		try {
			if (forward) search.findNext(term, this.searchOptions(incremental));
			else search.findPrevious(term, this.searchOptions(false));
		} catch {
			// An unfinished regex while typing.
			this.updateFindCount(-1, 0);
		}
	}

	private updateFindCount(index: number, count: number): void {
		if (!this.findCountEl) return;
		const term = this.findInput?.value ?? "";
		this.findCountEl.setText(term.length === 0 ? "" : count === 0 ? "No results" : `${index + 1} of ${count}`);
		this.findEl?.toggleClass("has-no-results", term.length > 0 && count === 0);
	}

	private buildFind(): HTMLInputElement {
		const findEl = this.el.createDiv({ cls: "tt-find is-hidden" });
		const input = findEl.createEl("input", {
			cls: "tt-find-input",
			attr: { type: "text", placeholder: "Find", spellcheck: "false", "aria-label": "Find in terminal" },
		});
		this.findCountEl = findEl.createSpan({ cls: "tt-find-count" });

		const toggle = (label: string, text: string, key: keyof FindOptions): void => {
			const button = findEl.createEl("button", {
				cls: "tt-find-toggle",
				text,
				attr: { "aria-label": label, type: "button" },
			});
			this.listen(button, "click", () => {
				this.findOptions[key] = !this.findOptions[key];
				button.toggleClass("is-active", this.findOptions[key]);
				this.find(true, true);
				input.focus();
			});
		};
		toggle("Match case", "Aa", "caseSensitive");
		toggle("Whole word", "ab", "wholeWord");
		toggle("Regular expression", ".*", "regex");

		const action = (label: string, icon: string, run: () => void): void => {
			const button = findEl.createEl("button", { cls: "tt-find-button", attr: { "aria-label": label, type: "button" } });
			setIcon(button, icon);
			this.listen(button, "click", run);
		};
		action("Previous match (Shift+Enter)", "arrow-up", () => this.find(false));
		action("Next match (Enter)", "arrow-down", () => this.find(true));
		action("Close (Escape)", "x", () => this.closeFind());

		this.listen(input, "input", () => this.find(true, true));
		this.listen(input, "keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				event.stopPropagation();
				this.find(!event.shiftKey);
			} else if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				this.closeFind();
			}
		});

		this.findEl = findEl;
		this.findInput = input;
		return input;
	}

	/* ---------------------------------------------------------------- */
	/* Local line editing (no-TTY fallback only)                        */
	/* ---------------------------------------------------------------- */

	/**
	 * Without a TTY nothing echoes typed characters back, and the shell prints
	 * no prompt. This reproduces the minimum a user expects: visible input,
	 * backspace, Ctrl+C, and a prompt once output goes quiet.
	 */
	private handleLineModeInput(data: string): void {
		const terminal = this.terminal;
		if (!terminal) return;

		// Drop arrow keys and other escape sequences rather than echoing them.
		const cleaned = data.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, "").replace(/\x1b[^[]?/g, "");

		for (const char of cleaned) {
			if (char === "\r" || char === "\n") {
				terminal.write("\r\n");
				// cmd.exe and PowerShell want CRLF from a pipe; POSIX shells want LF.
				this.session?.write(`${this.lineBuffer}${SHELL_EOL}`);
				this.lineBuffer = "";
				this.schedulePrompt();
			} else if (char === "\x7f" || char === "\b") {
				if (this.lineBuffer.length > 0) {
					this.lineBuffer = this.lineBuffer.slice(0, -1);
					terminal.write("\b \b");
				}
			} else if (char === "\x03") {
				terminal.write("^C\r\n");
				this.lineBuffer = "";
				this.writePrompt();
			} else if (char === "\x15") {
				terminal.write("\r\x1b[2K");
				this.lineBuffer = "";
				this.writePrompt();
			} else if (char >= " ") {
				this.lineBuffer += char;
				terminal.write(char);
			}
		}
	}

	private writePrompt(): void {
		this.clearPromptTimer();
		this.terminal?.write("\x1b[36m❯\x1b[0m ");
	}

	/** Debounced: output arriving in bursts should produce one prompt, not many. */
	private schedulePrompt(): void {
		this.clearPromptTimer();
		this.promptTimer = window.setTimeout(() => {
			this.promptTimer = 0;
			this.terminal?.write("\x1b[36m❯\x1b[0m ");
		}, 200);
	}

	private clearPromptTimer(): void {
		if (this.promptTimer !== 0) {
			window.clearTimeout(this.promptTimer);
			this.promptTimer = 0;
		}
	}
}
