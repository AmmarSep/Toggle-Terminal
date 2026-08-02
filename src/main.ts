import {
	addIcon,
	apiVersion,
	FileSystemAdapter,
	getIconIds,
	Notice,
	Platform,
	Plugin,
	type Editor,
	type Menu,
	type WorkspaceLeaf,
} from "obsidian";
import * as path from "node:path";
import * as os from "node:os";

import "./styles.css";

import { TERMINAL_VIEW_TYPE, TerminalView } from "./terminal-view";
import { DEFAULT_SETTINGS, ToggleTerminalSettingTab, type ToggleTerminalSettings } from "./settings";
import { applyInitialHeight, hidePanel, isPanelHidden, showPanel } from "./panel";
import {
	availableBackend,
	defaultShellArgs,
	detectShell,
	findPython,
	installedPtyBinaries,
	parseArgs,
	probePty,
	terminalEnv,
	type SessionKind,
} from "./pty";
import { toShellCommand } from "./send";

/** Lucide "panel-bottom": a framed pane with the bottom section divided off. */
const LUCIDE_ICON = "panel-bottom";

/**
 * Same geometry, registered locally in case this Obsidian build ships a Lucide
 * set without `panel-bottom`. Obsidian's addIcon() assumes a 100x100 viewBox,
 * so the 24x24 source is scaled by 100/24.
 */
const FALLBACK_ICON = "toggle-terminal-panel-bottom";
const FALLBACK_ICON_SVG =
	'<g transform="scale(4.1667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
	'<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 15h18"/></g>';

export default class ToggleTerminalPlugin extends Plugin {
	/** `Plugin.settings` is declared as `unknown` upstream; narrow it here. */
	override settings: ToggleTerminalSettings = { ...DEFAULT_SETTINGS };

	private iconId: string = LUCIDE_ICON;

	override async onload(): Promise<void> {
		await this.loadSettings();
		this.iconId = this.resolveIcon();

		this.registerView(TERMINAL_VIEW_TYPE, (leaf: WorkspaceLeaf) => new TerminalView(leaf, this));
		this.addSettingTab(new ToggleTerminalSettingTab(this.app, this));
		this.addRibbonIcon(this.iconId, "Toggle terminal", () => {
			void this.togglePanel();
		});

		this.addCommand({
			id: "toggle",
			name: "Toggle panel",
			hotkeys: [{ modifiers: ["Ctrl"], key: "`" }],
			callback: () => {
				void this.togglePanel();
			},
		});

		this.addCommand({
			id: "focus",
			name: "Focus panel",
			checkCallback: (checking: boolean): boolean => {
				const view = this.terminalView();
				if (!view) return false;
				if (!checking) void this.revealPanel(view.leaf);
				return true;
			},
		});

		this.addCommand({
			id: "restart",
			name: "Restart session",
			checkCallback: (checking: boolean): boolean => {
				const view = this.terminalView();
				if (!view) return false;
				if (!checking) view.restart();
				return true;
			},
		});

		this.addCommand({
			id: "close",
			name: "Close panel and end session",
			checkCallback: (checking: boolean): boolean => {
				const view = this.terminalView();
				if (!view) return false;
				if (!checking) {
					showPanel(view.leaf);
					view.leaf.detach();
				}
				return true;
			},
		});

		this.addCommand({
			id: "send-selection",
			name: "Send selection to terminal",
			editorCallback: (editor: Editor) => {
				void this.sendToTerminal(this.selectionOrLine(editor));
			},
		});

		// Right-click inside a note. Only offered when something is selected —
		// the command above is the one that falls back to the current line.
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
				const selection = editor.getSelection();
				if (selection.trim().length === 0) return;
				menu.addItem((item) =>
					item
						.setTitle("Send to Toggle Terminal")
						.setIcon(this.iconId)
						.onClick(() => {
							void this.sendToTerminal(selection);
						}),
				);
			}),
		);

		// Obsidian restores the leaf itself; re-apply the collapsed state on top.
		this.app.workspace.onLayoutReady(() => {
			if (!this.settings.panelHidden) return;
			const view = this.terminalView();
			if (view) hidePanel(view.leaf);
		});
	}

	override onunload(): void {
		// Views are torn down by Obsidian, which triggers TerminalView.onunload
		// and kills the shell. Leaves are intentionally left in place.
	}

	/* ---------------------------------------------------------------- */
	/* Diagnostics                                                      */
	/* ---------------------------------------------------------------- */

	/** Build identity of this main.js. Identical on two machines = same code. */
	buildStamp(): string {
		return __BUILD_STAMP__;
	}

	/**
	 * Everything needed to work out why a machine is on the backend it is on.
	 * Meant to be copied out of settings and compared between devices.
	 */
	diagnosticsReport(): string {
		const pluginDir = this.pluginDirectory();
		const { file, args } = this.resolveShell();
		const binaries = installedPtyBinaries(pluginDir);
		const lines: string[] = [];

		lines.push(`Toggle Terminal ${this.manifest.version}`);
		lines.push(`build       ${this.buildStamp()}`);
		lines.push(`obsidian    ${apiVersion}`);
		lines.push(`platform    ${process.platform} ${process.arch}`);
		lines.push(`plugin dir  ${pluginDir ?? "(unknown — not a FileSystemAdapter)"}`);
		lines.push(`backend     ${this.backendKind()}`);
		lines.push(`shell       ${file} ${args.join(" ")}`.trimEnd());
		lines.push("");

		lines.push("pty candidates");
		for (const probe of probePty(pluginDir)) {
			lines.push(`  [${probe.result}] ${probe.candidate}`);
			if (probe.result !== "loaded") lines.push(`      ${probe.detail}`);
		}
		lines.push("");

		lines.push(`platform binaries in node_modules/@lydell (${binaries.length})`);
		for (const name of binaries) lines.push(`  ${name}`);
		if (binaries.length === 0) lines.push("  none — sync does not carry .node/.dll/.exe");
		lines.push("");

		if (!Platform.isWin) {
			lines.push(`python      ${findPython(this.settings.pythonPath || null) ?? "not found"}`);
		}

		// Fenced, because this gets pasted into chat and issue trackers, where
		// markdown otherwise eats the backslashes in Windows paths (\.obsidian
		// and \@lydell are valid escapes and silently vanish).
		return ["```", ...lines, "```"].join("\n");
	}

	/* ---------------------------------------------------------------- */
	/* Icon                                                             */
	/* ---------------------------------------------------------------- */

	/**
	 * Prefer Obsidian's bundled Lucide icon; register our own copy only if this
	 * build predates it, so the ribbon never renders as an empty square.
	 */
	private resolveIcon(): string {
		const available = getIconIds();
		if (available.includes(LUCIDE_ICON) || available.includes(`lucide-${LUCIDE_ICON}`)) {
			return LUCIDE_ICON;
		}
		addIcon(FALLBACK_ICON, FALLBACK_ICON_SVG);
		return FALLBACK_ICON;
	}

	/** Icon used by the ribbon button and the panel's tab. */
	iconName(): string {
		return this.iconId;
	}

	/* ---------------------------------------------------------------- */
	/* Toggle                                                           */
	/* ---------------------------------------------------------------- */

	async togglePanel(): Promise<void> {
		if (!Platform.isDesktopApp) {
			new Notice("Toggle Terminal requires the desktop app.");
			return;
		}

		const view = this.terminalView();
		if (!view) {
			await this.openPanel();
			return;
		}

		if (isPanelHidden(view.leaf)) {
			await this.revealPanel(view.leaf);
		} else {
			await this.collapsePanel(view.leaf);
		}
	}

	private async openPanel(): Promise<TerminalView | null> {
		const leaf = this.app.workspace.getLeaf("split", "horizontal");
		await leaf.setViewState({ type: TERMINAL_VIEW_TYPE, active: true });

		applyInitialHeight(leaf, this.settings.panelHeight);
		this.settings.panelHidden = false;
		await this.saveSettings();

		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		this.afterLayout(leaf);

		return leaf.view instanceof TerminalView ? leaf.view : null;
	}

	private async collapsePanel(leaf: WorkspaceLeaf): Promise<void> {
		hidePanel(leaf);
		this.settings.panelHidden = true;
		await this.saveSettings();
		// Hand focus back to the editor so typing does not vanish into a hidden pane.
		this.focusNonTerminalLeaf(leaf);
	}

	private focusNonTerminalLeaf(exclude: WorkspaceLeaf): void {
		const candidates: WorkspaceLeaf[] = [];
		this.app.workspace.iterateRootLeaves((candidate) => {
			if (candidate === exclude) return;
			if (candidate.view.getViewType() === TERMINAL_VIEW_TYPE) return;
			candidates.push(candidate);
		});
		const target = candidates[0];
		if (target) this.app.workspace.setActiveLeaf(target, { focus: true });
	}

	private async revealPanel(leaf: WorkspaceLeaf): Promise<void> {
		showPanel(leaf);
		this.settings.panelHidden = false;
		await this.saveSettings();
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		this.afterLayout(leaf);
	}

	/** Re-fit once the browser has laid the panel out again. */
	private afterLayout(leaf: WorkspaceLeaf): void {
		window.requestAnimationFrame(() => {
			const view = leaf.view;
			if (!(view instanceof TerminalView)) return;
			view.scheduleFit();
			if (this.settings.focusOnReveal) view.focusTerminal();
		});
	}

	/* ---------------------------------------------------------------- */
	/* Sending text to the terminal                                     */
	/* ---------------------------------------------------------------- */

	/** Selection if there is one, otherwise the line the cursor sits on. */
	private selectionOrLine(editor: Editor): string {
		const selection = editor.getSelection();
		return selection.length > 0 ? selection : editor.getLine(editor.getCursor().line);
	}

	/**
	 * Strip the markdown, make sure a panel is up, then paste. Nothing runs
	 * until you press Enter.
	 */
	async sendToTerminal(raw: string): Promise<void> {
		if (!Platform.isDesktopApp) return;

		const command = toShellCommand(raw);
		if (command.length === 0) {
			new Notice("Nothing to send — that selection is empty once markdown is stripped.");
			return;
		}

		const view = await this.ensurePanel();
		if (!view) {
			new Notice("Could not open the terminal panel.");
			return;
		}
		await view.paste(command);
	}

	/** Open, or reveal if collapsed, and hand back the live view. */
	private async ensurePanel(): Promise<TerminalView | null> {
		const view = this.terminalView();
		if (!view) return this.openPanel();

		if (isPanelHidden(view.leaf)) {
			await this.revealPanel(view.leaf);
		} else {
			this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
		}
		return view;
	}

	/** Called by the view when the user closes the tab manually. */
	handleViewClosed(): void {
		if (!this.settings.panelHidden) return;
		this.settings.panelHidden = false;
		void this.saveSettings();
	}

	private terminalView(): TerminalView | null {
		for (const leaf of this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE)) {
			if (leaf.view instanceof TerminalView) return leaf.view;
		}
		return null;
	}

	refreshOpenTerminals(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE)) {
			if (leaf.view instanceof TerminalView) leaf.view.applyTheme();
		}
	}

	/* ---------------------------------------------------------------- */
	/* Environment resolution                                           */
	/* ---------------------------------------------------------------- */

	detectedShell(): string {
		return detectShell();
	}

	/** Backend that a new session would use right now. */
	backendKind(): SessionKind {
		return availableBackend(this.pluginDirectory(), this.settings.pythonPath || null);
	}

	resolveShell(): { file: string; args: string[] } {
		const file = this.settings.shellPath || detectShell();
		const custom = parseArgs(this.settings.shellArgs);
		const args = custom.length > 0 ? custom : defaultShellArgs(file, this.settings.loginShell);
		return { file, args };
	}

	terminalEnvironment(): Record<string, string | undefined> {
		return terminalEnv();
	}

	/** Absolute path of the installed plugin folder, used to resolve node-pty. */
	pluginDirectory(): string | null {
		const basePath = this.vaultBasePath();
		const dir = this.manifest.dir;
		if (!basePath || !dir) return null;
		return path.join(basePath, dir);
	}

	resolveWorkingDirectory(): string | undefined {
		const basePath = this.vaultBasePath();

		switch (this.settings.startDirectory) {
			case "home":
				return os.homedir();
			case "custom":
				return this.settings.customDirectory || basePath || undefined;
			case "activeFile": {
				const file = this.app.workspace.getActiveFile();
				if (basePath && file?.parent) {
					return path.join(basePath, file.parent.path);
				}
				return basePath ?? undefined;
			}
			case "vault":
			default:
				return basePath ?? undefined;
		}
	}

	private vaultBasePath(): string | null {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
	}

	/* ---------------------------------------------------------------- */
	/* Settings                                                         */
	/* ---------------------------------------------------------------- */

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<ToggleTerminalSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
