import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

import type ToggleTerminalPlugin from "./main";
import { createSession, SHELL_EOL, type SessionKind, type TerminalSession } from "./pty";
import { obsidianMonospaceFont, obsidianTerminalTheme } from "./theme";
import { bracketedPaste, toSingleLine } from "./send";

export const TERMINAL_VIEW_TYPE = "toggle-terminal-view";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const BACKEND_LABEL: Record<SessionKind, string> = {
	pty: "pty",
	bridge: "pty via bridge",
	piped: "no TTY · line mode",
};

export class TerminalView extends ItemView {
	private readonly plugin: ToggleTerminalPlugin;

	private terminal: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private session: TerminalSession | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private pendingFit = 0;

	private surfaceEl!: HTMLElement;
	private statusEl: HTMLElement | null = null;
	private statusDotEl: HTMLElement | null = null;
	private statusTextEl: HTMLElement | null = null;
	private statusLabel = "Starting…";
	private statusExited = false;
	private exited = false;
	/** Set on the shell's first byte, so pasted text is not sent before the prompt exists. */
	private hasOutput = false;

	/** Local line editing state, used only by the no-TTY fallback. */
	private lineBuffer = "";
	private promptTimer = 0;

	constructor(leaf: WorkspaceLeaf, plugin: ToggleTerminalPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.navigation = false;
	}

	override getViewType(): string {
		return TERMINAL_VIEW_TYPE;
	}

	override getDisplayText(): string {
		return "Terminal";
	}

	override getIcon(): string {
		return this.plugin.iconName();
	}

	/* ---------------------------------------------------------------- */
	/* Lifecycle                                                        */
	/* ---------------------------------------------------------------- */

	override async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("toggle-terminal-view");

		this.buildStatusBar();
		this.surfaceEl = this.contentEl.createDiv({ cls: "toggle-terminal-surface" });

		this.createTerminal();
		this.startSession();

		this.registerEvent(this.app.workspace.on("css-change", () => this.applyTheme()));
		this.registerDomEvent(this.surfaceEl, "mousedown", () => this.focusTerminal());

		this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
		this.resizeObserver.observe(this.surfaceEl);
		this.scheduleFit();
	}

	override async onClose(): Promise<void> {
		this.teardown();
		this.plugin.handleViewClosed();
	}

	override onunload(): void {
		this.teardown();
		super.onunload();
	}

	override onResize(): void {
		this.scheduleFit();
	}

	private teardown(): void {
		if (this.pendingFit !== 0) {
			window.cancelAnimationFrame(this.pendingFit);
			this.pendingFit = 0;
		}
		this.clearPromptTimer();
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.session?.dispose();
		this.session = null;
		this.terminal?.dispose();
		this.terminal = null;
		this.fitAddon = null;
	}

	/* ---------------------------------------------------------------- */
	/* Terminal + session                                               */
	/* ---------------------------------------------------------------- */

	private createTerminal(): void {
		const { settings } = this.plugin;

		const terminal = new Terminal({
			allowProposedApi: false,
			cursorBlink: true,
			cursorStyle: "bar",
			drawBoldTextInBrightColors: true,
			fontSize: settings.fontSize,
			fontFamily: settings.fontFamily || obsidianMonospaceFont(this.contentEl),
			macOptionIsMeta: true,
			scrollback: settings.scrollback,
			theme: obsidianTerminalTheme(this.contentEl),
		});

		const fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.loadAddon(
			new WebLinksAddon((_event, uri) => {
				window.open(uri, "_blank");
			}),
		);

		terminal.open(this.surfaceEl);
		terminal.onData((data) => this.handleInput(data));
		terminal.onBinary((data) => this.handleInput(data));
		terminal.attachCustomKeyEventHandler((event) => this.handleKeyEvent(event));

		this.terminal = terminal;
		this.fitAddon = fitAddon;
	}

	private startSession(): void {
		if (!this.terminal) return;

		const { file, args } = this.plugin.resolveShell();
		this.exited = false;
		this.hasOutput = false;

		try {
			this.session = createSession({
				file,
				args,
				cwd: this.plugin.resolveWorkingDirectory(),
				cols: this.terminal.cols,
				rows: this.terminal.rows,
				env: this.plugin.terminalEnvironment(),
				pluginDir: this.plugin.pluginDirectory(),
				pythonPath: this.plugin.settings.pythonPath || null,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.terminal.writeln(`\x1b[31mFailed to start ${file}: ${message}\x1b[0m`);
			this.setStatus(`Failed to start ${file}`, true);
			this.exited = true;
			return;
		}

		this.session.onData((chunk) => this.handleOutput(chunk));
		this.session.onExit((code) => this.handleExit(code));

		const shellName = file.split(/[\\/]/).pop() ?? file;
		const pid = this.session.pid ? ` · pid ${this.session.pid}` : "";
		this.setStatus(`${shellName} · ${BACKEND_LABEL[this.session.kind]}${pid}`, false);
		this.announceBackend(this.session.kind);
	}

	/** One-line note when the session is running on a degraded backend. */
	private announceBackend(kind: SessionKind): void {
		const terminal = this.terminal;
		if (!terminal || kind === "pty" || kind === "bridge") return;

		terminal.writeln("\x1b[33mNo TTY available — line mode.\x1b[0m");
		terminal.writeln(
			"\x1b[90mType a command and press Enter. Interactive programs (vim, ssh prompts, claude) will not work here.\x1b[0m",
		);
		// The binaries do not travel over Obsidian Sync, so say what to run.
		terminal.writeln(
			`\x1b[90mFix: run \x1b[0mnpm install @lydell/node-pty\x1b[90m in ${this.plugin.pluginDirectory() ?? "the plugin folder"}, then reload the plugin.\x1b[0m`,
		);
		this.writePrompt();
	}

	private get lineMode(): boolean {
		return this.session?.kind === "piped";
	}

	private handleOutput(chunk: string): void {
		this.hasOutput = true;
		this.terminal?.write(chunk);
		if (this.lineMode) this.schedulePrompt();
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

	private handleExit(code: number): void {
		this.exited = true;
		this.terminal?.writeln(`\r\n\x1b[90m[process exited with code ${code}] press Enter to restart\x1b[0m`);
		this.setStatus(`Exited (${code})`, true);
	}

	/* ---------------------------------------------------------------- */
	/* Sending text in                                                  */
	/* ---------------------------------------------------------------- */

	/**
	 * Drop text at the prompt without running it, the way a real paste behaves.
	 * The caller is expected to have cleaned markdown off it already.
	 */
	async paste(text: string): Promise<void> {
		if (text.length === 0) return;
		await this.waitForPrompt();

		const terminal = this.terminal;
		const session = this.session;
		if (!terminal || !session) return;

		if (this.lineMode) {
			// No line discipline here, so our own editor owns the buffer and the
			// echo. It is single-line only, hence the collapse.
			const single = toSingleLine(text);
			this.lineBuffer += single;
			terminal.write(single);
		} else {
			session.write(bracketedPaste(text));
		}

		this.focusTerminal();
	}

	/**
	 * A shell spawned moments ago has not drawn its prompt yet, and input sent
	 * before then is swallowed. Wait for first output, then let it settle.
	 */
	private async waitForPrompt(timeoutMs = 4000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!this.hasOutput && Date.now() < deadline) {
			await delay(40);
		}
		if (this.hasOutput) await delay(120);
	}

	restart(): void {
		this.clearPromptTimer();
		this.lineBuffer = "";
		this.session?.dispose();
		this.session = null;
		this.terminal?.reset();
		this.startSession();
		this.scheduleFit();
		this.focusTerminal();
	}

	/* ---------------------------------------------------------------- */
	/* Keyboard                                                         */
	/* ---------------------------------------------------------------- */

	/** Returns false to let the key fall through to Obsidian instead of the shell. */
	private handleKeyEvent(event: KeyboardEvent): boolean {
		if (event.type !== "keydown") return true;

		// Never swallow the toggle hotkey, otherwise the panel traps focus.
		const isToggle =
			event.ctrlKey && !event.altKey && !event.metaKey && (event.key === "`" || event.code === "Backquote");
		if (isToggle) return false;

		if (this.plugin.settings.captureKeyboard) {
			// Stop Obsidian's global hotkeys from stealing shell keystrokes.
			event.stopPropagation();
		}
		return true;
	}

	/* ---------------------------------------------------------------- */
	/* Layout + theming                                                 */
	/* ---------------------------------------------------------------- */

	scheduleFit(): void {
		if (this.pendingFit !== 0) return;
		this.pendingFit = window.requestAnimationFrame(() => {
			this.pendingFit = 0;
			this.fit();
		});
	}

	private fit(): void {
		const terminal = this.terminal;
		const fitAddon = this.fitAddon;
		if (!terminal || !fitAddon) return;

		// Fitting a collapsed panel yields zero dimensions and corrupts the buffer.
		if (this.surfaceEl.offsetParent === null) return;
		if (this.surfaceEl.clientWidth < 16 || this.surfaceEl.clientHeight < 16) return;

		try {
			fitAddon.fit();
		} catch {
			return;
		}
		this.session?.resize(terminal.cols, terminal.rows);
	}

	applyTheme(): void {
		const terminal = this.terminal;
		if (!terminal) return;
		const { settings } = this.plugin;
		terminal.options.theme = obsidianTerminalTheme(this.contentEl);
		terminal.options.fontSize = settings.fontSize;
		terminal.options.fontFamily = settings.fontFamily || obsidianMonospaceFont(this.contentEl);
		terminal.options.scrollback = settings.scrollback;
		this.syncStatusBar();
		this.scheduleFit();
	}

	focusTerminal(): void {
		this.terminal?.focus();
	}

	private setStatus(text: string, exited: boolean): void {
		this.statusLabel = text;
		this.statusExited = exited;
		this.statusTextEl?.setText(text);
		this.statusDotEl?.toggleClass("is-exited", exited);
	}

	/* ---------------------------------------------------------------- */
	/* Status strip                                                     */
	/* ---------------------------------------------------------------- */

	/**
	 * One slim row carrying the session state and the two actions. Obsidian's
	 * view header is hidden for this view in styles.css — the tab already shows
	 * the title, so the header only cost vertical space — which is why the
	 * actions live here rather than in `addAction()`.
	 */
	private buildStatusBar(): void {
		if (!this.plugin.settings.showStatusBar) return;

		const statusEl = this.contentEl.createDiv({ cls: "toggle-terminal-status" });
		this.statusEl = statusEl;
		this.statusDotEl = statusEl.createDiv({ cls: "toggle-terminal-status-dot" });
		this.statusTextEl = statusEl.createSpan({ cls: "toggle-terminal-status-text" });
		statusEl.createDiv({ cls: "toggle-terminal-status-spacer" });
		this.addStatusButton(statusEl, "eraser", "Clear terminal", () => this.terminal?.clear());
		this.addStatusButton(statusEl, "rotate-ccw", "Restart session", () => this.restart());

		this.statusTextEl.setText(this.statusLabel);
		this.statusDotEl.toggleClass("is-exited", this.statusExited);
	}

	private addStatusButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
		const button = parent.createEl("button", {
			cls: "toggle-terminal-status-button",
			attr: { "aria-label": label, type: "button" },
		});
		setIcon(button, icon);
		this.registerDomEvent(button, "click", (event: MouseEvent) => {
			event.preventDefault();
			onClick();
		});
	}

	/** Add or remove the strip when the setting changes, terminal untouched. */
	private syncStatusBar(): void {
		const wanted = this.plugin.settings.showStatusBar;
		if (wanted === (this.statusEl !== null)) return;

		if (wanted) {
			this.buildStatusBar();
			if (this.statusEl) this.contentEl.insertBefore(this.statusEl, this.surfaceEl);
		} else {
			this.statusEl?.remove();
			this.statusEl = null;
			this.statusDotEl = null;
			this.statusTextEl = null;
		}
		this.scheduleFit();
	}
}
