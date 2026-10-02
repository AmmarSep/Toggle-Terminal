import {
	addIcon,
	apiVersion,
	FileSystemAdapter,
	getIconIds,
	MarkdownView,
	Menu,
	Notice,
	normalizePath,
	Platform,
	Plugin,
	TFile,
	TFolder,
	type Command,
	type Editor,
	type TAbstractFile,
	type WorkspaceLeaf,
} from "obsidian";
import * as path from "node:path";
import * as os from "node:os";

import "./styles.css";

import { TerminalDock } from "./dock";
import type { TerminalInstance } from "./instance";
import { hotkeyMatches, type HotkeyLike, type KeyLike } from "./keys";
import { LEGACY_VIEW_TYPE, LegacyTerminalView } from "./legacy-view";
import { vaultRelativeCandidates } from "./links";
import {
	availableBackend,
	defaultShellArgs,
	detectShell,
	findPython,
	installedPtyBinaries,
	parseArgs,
	parseEnvLines,
	probePty,
	terminalEnv,
	type SessionKind,
} from "./pty";
import { claudeMention, expandTemplate, shellQuote, toShellCommand, type TemplateVariables } from "./send";
import {
	DEFAULT_SETTINGS,
	DEFAULT_STATE,
	migrateSettings,
	ToggleTerminalSettingTab,
	type PanelState,
	type StoredData,
	type TerminalProfile,
	type ToggleTerminalSettings,
} from "./settings";
import { parseFileUri } from "./instance";

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

/** The parts of Obsidian's internal hotkey manager this plugin reads. */
interface HotkeyManagerLike {
	getHotkeys?(command: string): HotkeyLike[] | undefined;
	getDefaultHotkeys?(command: string): HotkeyLike[] | undefined;
}

/** Obsidian's in-progress drag (file explorer, tab headers, links). */
interface DraggableLike {
	type?: string;
	file?: TAbstractFile;
	files?: TAbstractFile[];
	linktext?: string;
	sourcePath?: string;
}

const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 40;

export default class ToggleTerminalPlugin extends Plugin {
	/** `Plugin.settings` is declared as `unknown` upstream; narrow it here. */
	override settings: ToggleTerminalSettings = { ...DEFAULT_SETTINGS };
	state: PanelState = { ...DEFAULT_STATE };
	dock: TerminalDock | null = null;

	private iconId: string = LUCIDE_ICON;
	private ribbonEl: HTMLElement | null = null;
	/** 1.x collapse flag, read once for the leaf migration. */
	private legacyPanelHidden: boolean | null = null;
	/** Temporary zoom from ⌘+/⌘−, not saved. */
	private fontSizeOffset = 0;
	private saveTimer = 0;

	/** Full ids of every command this plugin registered, for hotkey pass-through. */
	private readonly commandIds = new Set<string>();
	private readonly declaredHotkeys = new Map<string, HotkeyLike[]>();
	private profileCommandIds: string[] = [];

	override async onload(): Promise<void> {
		await this.loadSettings();
		this.iconId = this.resolveIcon();

		this.registerView(LEGACY_VIEW_TYPE, (leaf: WorkspaceLeaf) => new LegacyTerminalView(leaf, this.iconId));
		this.addSettingTab(new ToggleTerminalSettingTab(this.app, this));

		this.ribbonEl = this.addRibbonIcon(this.iconId, "Toggle terminal", () => this.togglePanel());
		this.registerDomEvent(this.ribbonEl, "contextmenu", (event: MouseEvent) => {
			event.preventDefault();
			this.showRibbonMenu(event);
		});

		this.registerCommands();
		this.registerProfileCommands();
		this.registerMenus();

		this.app.workspace.onLayoutReady(() => this.initialiseDock());
	}

	override onunload(): void {
		if (this.saveTimer !== 0) {
			window.clearTimeout(this.saveTimer);
			void this.saveSettings();
		}
		// Ends every session: a terminal outliving its plugin has no UI left.
		this.dock?.unmount();
		this.dock = null;
	}

	/** Obsidian Sync (or another device) rewrote data.json. */
	override async onExternalSettingsChange(): Promise<void> {
		const liveState = this.state;
		await this.loadSettings();
		// Window state belongs to this device's session; keep it.
		this.state = liveState;
		this.registerProfileCommands();
		this.dock?.applySettings();
	}

	private initialiseDock(): void {
		if (!Platform.isDesktopApp) return;
		const dock = new TerminalDock(this);
		this.dock = dock;
		dock.mount();

		const { workspace } = this.app;
		this.registerEvent(workspace.on("layout-change", () => dock.onWorkspaceChanged()));
		this.registerEvent(workspace.on("resize", () => dock.scheduleLayout()));
		this.registerEvent(
			workspace.on("css-change", () => {
				dock.applySettings();
				dock.onWorkspaceChanged();
			}),
		);
		this.registerEvent(workspace.on("file-open", () => dock.onNoteOpened()));
		this.registerEvent(
			workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => {
				if (leaf && leaf.getRoot() === workspace.rootSplit) dock.onNoteOpened();
			}),
		);

		const legacyWasVisible = this.migrateLegacyLeaves();
		const { startup } = this.settings;
		if (startup === "always" || (startup === "restore" && (this.state.open || legacyWasVisible))) {
			dock.show(false);
		}
	}

	/**
	 * Replace 1.x's terminal leaf with the panel. Returns true when that leaf
	 * was on screen, so the panel opens in its place.
	 */
	private migrateLegacyLeaves(): boolean {
		const leaves = this.app.workspace.getLeavesOfType(LEGACY_VIEW_TYPE);
		const wasVisible = leaves.length > 0 && this.legacyPanelHidden === false;
		for (const leaf of leaves) leaf.detach();
		if (this.legacyPanelHidden !== null) {
			this.legacyPanelHidden = null;
			void this.saveSettings(); // drops the 1.x keys from data.json
		}
		return wasVisible;
	}

	/* ---------------------------------------------------------------- */
	/* Commands                                                         */
	/* ---------------------------------------------------------------- */

	private command(command: Command): void {
		// Read before registering: addCommand prefixes the object's id in place.
		const fullId = `${this.manifest.id}:${command.id}`;
		const hotkeys = command.hotkeys;
		this.addCommand(command);
		this.commandIds.add(fullId);
		if (hotkeys) this.declaredHotkeys.set(fullId, hotkeys);
	}

	/** Runs `run` with the panel's active terminal; palette entry hidden when there is none. */
	private withActive(run: (instance: TerminalInstance, dock: TerminalDock) => void): (checking: boolean) => boolean {
		return (checking: boolean): boolean => {
			const dock = this.dock;
			const instance = dock?.getActive();
			if (!dock || !instance) return false;
			if (!checking) run(instance, dock);
			return true;
		};
	}

	private registerCommands(): void {
		this.command({
			id: "toggle",
			name: "Toggle panel",
			hotkeys: [{ modifiers: ["Ctrl"], key: "`" }],
			callback: () => this.togglePanel(),
		});

		this.command({
			id: "focus",
			name: "Focus terminal",
			callback: () => this.requireDock()?.show(true),
		});

		this.command({
			id: "toggle-focus",
			name: "Switch focus between terminal and editor",
			callback: () => {
				const dock = this.requireDock();
				if (!dock) return;
				if (dock.hasFocus()) this.focusEditor();
				else dock.show(true);
			},
		});

		this.command({
			id: "new",
			name: "New terminal",
			callback: () => this.requireDock()?.createInstance({}, { focus: true }),
		});

		this.command({
			id: "new-in-folder",
			name: "New terminal in the active note's folder",
			checkCallback: (checking: boolean): boolean => {
				const folder = this.activeFileFolder();
				if (!folder) return false;
				if (!checking) this.requireDock()?.createInstance({ cwd: folder }, { focus: true });
				return true;
			},
		});

		this.command({
			id: "maximize",
			name: "Maximize or restore panel",
			callback: () => this.requireDock()?.toggleMaximized(),
		});

		this.command({
			id: "next",
			name: "Next terminal",
			checkCallback: this.withActive((_instance, dock) => dock.activateRelative(1)),
		});

		this.command({
			id: "previous",
			name: "Previous terminal",
			checkCallback: this.withActive((_instance, dock) => dock.activateRelative(-1)),
		});

		this.command({
			id: "rename",
			name: "Rename terminal",
			checkCallback: this.withActive((instance, dock) => {
				dock.show(false);
				dock.beginRename(instance);
			}),
		});

		this.command({
			id: "clear",
			name: "Clear terminal",
			checkCallback: this.withActive((instance) => instance.clear()),
		});

		this.command({
			id: "find",
			name: "Find in terminal",
			checkCallback: this.withActive((instance, dock) => {
				dock.show(false);
				instance.openFind();
			}),
		});

		this.command({
			id: "restart",
			name: "Restart session",
			checkCallback: this.withActive((instance) => instance.restart()),
		});

		this.command({
			id: "kill",
			name: "Kill active terminal",
			checkCallback: this.withActive((instance, dock) => void dock.closeInstance(instance, true)),
		});

		this.command({
			id: "close",
			name: "Close panel and end all sessions",
			checkCallback: (checking: boolean): boolean => {
				const dock = this.dock;
				if (!dock || dock.getInstances().length === 0) return false;
				if (!checking) void dock.closeAll(true);
				return true;
			},
		});

		for (const position of ["bottom", "right", "left"] as const) {
			this.command({
				id: `move-${position}`,
				name: `Move panel to the ${position}`,
				checkCallback: (checking: boolean): boolean => {
					if (!this.dock || this.settings.position === position) return false;
					if (!checking) this.dock.setPosition(position);
					return true;
				},
			});
		}

		this.command({
			id: "send-selection",
			name: "Send selection to terminal",
			editorCallback: (editor: Editor) => {
				void this.sendToTerminal(this.selectionOrLine(editor), false);
			},
		});

		this.command({
			id: "run-selection",
			name: "Run selection in terminal",
			editorCallback: (editor: Editor) => {
				void this.sendToTerminal(this.selectionOrLine(editor), true);
			},
		});

		this.command({
			id: "insert-path",
			name: "Insert active note's path into terminal",
			checkCallback: (checking: boolean): boolean => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) void this.insertPaths([file], "path");
				return true;
			},
		});

		this.command({
			id: "insert-mention",
			name: "Insert active note as @mention (Claude Code)",
			checkCallback: (checking: boolean): boolean => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) void this.insertPaths([file], "mention");
				return true;
			},
		});
	}

	/** One palette command per launch profile. Re-run whenever profiles change. */
	registerProfileCommands(): void {
		for (const id of this.profileCommandIds) {
			this.removeCommand(id);
			this.commandIds.delete(`${this.manifest.id}:${id}`);
		}
		this.profileCommandIds = [];
		for (const profile of this.validProfiles()) {
			const id = `launch-${profile.id}`;
			this.command({ id, name: `New terminal: ${profile.name}`, callback: () => this.launchProfile(profile) });
			this.profileCommandIds.push(id);
		}
		this.dock?.applySettings();
	}

	private registerMenus(): void {
		// Right-click inside a note. Only offered when something is selected —
		// the commands fall back to the current line.
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
				const selection = editor.getSelection();
				if (selection.trim().length === 0) return;
				menu.addItem((item) =>
					item
						.setTitle("Send to terminal")
						.setIcon(this.iconId)
						.onClick(() => void this.sendToTerminal(selection, false)),
				);
				menu.addItem((item) =>
					item
						.setTitle("Run in terminal")
						.setIcon("play")
						.onClick(() => void this.sendToTerminal(selection, true)),
				);
			}),
		);

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
				const folder = file instanceof TFolder ? file : file.parent;
				const base = this.vaultBasePath();
				if (folder && base) {
					menu.addItem((item) =>
						item
							.setTitle("Open in terminal")
							.setIcon(this.iconId)
							.onClick(() => this.requireDock()?.createInstance({ cwd: path.join(base, folder.path) }, { focus: true })),
					);
				}
				menu.addItem((item) =>
					item
						.setTitle("Insert path into terminal")
						.setIcon("text-cursor-input")
						.onClick(() => void this.insertPaths([file], "path")),
				);
			}),
		);

		this.registerEvent(
			this.app.workspace.on("files-menu", (menu: Menu, files: TAbstractFile[]) => {
				menu.addItem((item) =>
					item
						.setTitle("Insert paths into terminal")
						.setIcon("text-cursor-input")
						.onClick(() => void this.insertPaths(files, "path")),
				);
			}),
		);
	}

	private showRibbonMenu(event: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("New terminal")
				.setIcon("plus")
				.onClick(() => this.requireDock()?.createInstance({}, { focus: true })),
		);
		for (const profile of this.validProfiles()) {
			menu.addItem((item) =>
				item
					.setTitle(`New: ${profile.name}`)
					.setIcon("play")
					.onClick(() => this.launchProfile(profile)),
			);
		}
		menu.addSeparator();
		menu.addItem((item) => item.setTitle("Terminal settings").setIcon("settings").onClick(() => this.openSettings()));
		menu.showAtMouseEvent(event);
	}

	/* ---------------------------------------------------------------- */
	/* Panel                                                            */
	/* ---------------------------------------------------------------- */

	private requireDock(): TerminalDock | null {
		if (!Platform.isDesktopApp) {
			new Notice("Toggle Terminal requires the desktop app.");
			return null;
		}
		if (!this.dock) new Notice("Toggle Terminal is still starting — try again in a moment.");
		return this.dock;
	}

	togglePanel(): void {
		this.requireDock()?.toggle();
	}

	/** Give the keyboard back to the most recent note. */
	focusEditor(): void {
		const { workspace } = this.app;
		const leaf = workspace.getMostRecentLeaf(workspace.rootSplit) ?? workspace.getMostRecentLeaf();
		if (!leaf) return;
		workspace.setActiveLeaf(leaf, { focus: true });
		const view = leaf.view;
		if (view instanceof MarkdownView) view.editor.focus();
	}

	updateRibbonBadge(): void {
		const dock = this.dock;
		this.ribbonEl?.toggleClass("tt-has-bell", dock !== null && !dock.isShown() && dock.hasUnseenBell());
	}

	openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open?(): void; openTabById?(id: string): void } }).setting;
		setting?.open?.();
		setting?.openTabById?.(this.manifest.id);
	}

	/** Font size after temporary zoom. */
	effectiveFontSize(): number {
		return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, this.settings.fontSize + this.fontSizeOffset));
	}

	/** +1 / −1 zoom every terminal, 0 resets. Session-only, like a terminal app's zoom. */
	zoom(direction: 1 | -1 | 0): void {
		const before = this.effectiveFontSize();
		this.fontSizeOffset = direction === 0 ? 0 : this.fontSizeOffset + direction;
		this.fontSizeOffset = this.effectiveFontSize() - this.settings.fontSize;
		if (this.effectiveFontSize() !== before) this.dock?.applySettings();
	}

	/* ---------------------------------------------------------------- */
	/* Hotkeys                                                          */
	/* ---------------------------------------------------------------- */

	/**
	 * True when `event` is bound to one of this plugin's commands — custom
	 * bindings from Settings → Hotkeys first, then defaults. These reach
	 * Obsidian even while the terminal captures the keyboard, so a rebound
	 * toggle hotkey can still close the panel.
	 */
	isPluginHotkey(event: KeyLike): boolean {
		const manager = (this.app as unknown as { hotkeyManager?: HotkeyManagerLike }).hotkeyManager;
		for (const id of this.commandIds) {
			let hotkeys: HotkeyLike[] | undefined;
			try {
				hotkeys = manager?.getHotkeys?.(id) ?? manager?.getDefaultHotkeys?.(id);
			} catch {
				hotkeys = undefined;
			}
			hotkeys ??= this.declaredHotkeys.get(id);
			if (hotkeys?.some((hotkey) => hotkeyMatches(hotkey, event, Platform.isMacOS))) return true;
		}
		return false;
	}

	/* ---------------------------------------------------------------- */
	/* Sending text and paths                                           */
	/* ---------------------------------------------------------------- */

	/** Selection if there is one, otherwise the line the cursor sits on. */
	private selectionOrLine(editor: Editor): string {
		const selection = editor.getSelection();
		return selection.length > 0 ? selection : editor.getLine(editor.getCursor().line);
	}

	/**
	 * Strip the markdown, make sure a terminal is up, then paste. Nothing runs
	 * unless `execute` is set.
	 */
	async sendToTerminal(raw: string, execute: boolean): Promise<void> {
		const command = toShellCommand(raw);
		if (command.length === 0) {
			new Notice("Nothing to send — that selection is empty once markdown is stripped.");
			return;
		}
		const instance = this.requireDock()?.show(true);
		if (instance) await instance.paste(command, execute);
	}

	async insertPaths(files: TAbstractFile[], mode: "path" | "mention"): Promise<void> {
		if (files.length === 0) return;
		const instance = this.requireDock()?.show(true);
		if (!instance) return;
		const text = files
			.map((file) =>
				mode === "mention"
					? claudeMention(this.pathForTerminal(file.path, instance))
					: shellQuote(this.pathForTerminal(file.path, instance), Platform.isWin),
			)
			.join(" ");
		await instance.paste(`${text} `);
	}

	/**
	 * A vault path as the shell should see it: relative when the file is under
	 * the terminal's directory (the usual case, since terminals start in the
	 * vault), absolute otherwise.
	 */
	pathForTerminal(vaultPath: string, instance: TerminalInstance): string {
		const base = this.vaultBasePath();
		if (!base) return vaultPath;
		const absolute = path.join(base, vaultPath);
		const cwd = instance.currentDirectory();
		if (!cwd) return absolute;
		const relative = path.relative(cwd, absolute);
		if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) return absolute;
		return relative;
	}

	private draggable(): DraggableLike | null {
		const manager = (this.app as unknown as { dragManager?: { draggable?: DraggableLike | null } }).dragManager;
		return manager?.draggable ?? null;
	}

	canDropOnTerminal(event: DragEvent): boolean {
		const draggable = this.draggable();
		if (draggable && (draggable.file || draggable.files?.length || draggable.linktext)) return true;
		const types = Array.from(event.dataTransfer?.types ?? []);
		return types.includes("Files") || types.includes("text/plain") || types.includes("text/uri-list");
	}

	/** Notes from the file explorer become paths, OS files absolute paths, text stays text. */
	textForDrop(event: DragEvent, instance: TerminalInstance): string | null {
		const draggable = this.draggable();
		const vaultFiles = draggable?.files?.length ? draggable.files : draggable?.file ? [draggable.file] : [];
		if (vaultFiles.length > 0) {
			return vaultFiles.map((file) => shellQuote(this.pathForTerminal(file.path, instance), Platform.isWin)).join(" ");
		}
		if (draggable?.linktext) {
			const target = this.app.metadataCache.getFirstLinkpathDest(draggable.linktext, draggable.sourcePath ?? "");
			if (target) return shellQuote(this.pathForTerminal(target.path, instance), Platform.isWin);
		}

		const osFiles = Array.from(event.dataTransfer?.files ?? []);
		const osPaths = osFiles.map((file) => this.osFilePath(file)).filter((value): value is string => value !== null);
		if (osPaths.length > 0) return osPaths.map((value) => shellQuote(value, Platform.isWin)).join(" ");

		const text = event.dataTransfer?.getData("text/plain") ?? "";
		return text.length > 0 ? text : null;
	}

	/** Electron 32 removed File.path; webUtils replaces it. */
	private osFilePath(file: File): string | null {
		try {
			const electron = (window as unknown as { require?: (id: string) => unknown }).require?.("electron") as
				| { webUtils?: { getPathForFile?(file: File): string } }
				| undefined;
			const resolved = electron?.webUtils?.getPathForFile?.(file);
			if (resolved) return resolved;
		} catch {
			/* not Electron */
		}
		const legacy = (file as File & { path?: string }).path;
		return legacy && legacy.length > 0 ? legacy : null;
	}

	/* ---------------------------------------------------------------- */
	/* Links from terminal output                                       */
	/* ---------------------------------------------------------------- */

	resolveVaultFile(candidate: string, cwd: string | undefined): TFile | null {
		const candidates = vaultRelativeCandidates(candidate, {
			vaultBase: this.vaultBasePath(),
			cwd: cwd ?? null,
			home: os.homedir(),
			caseInsensitive: Platform.isWin || Platform.isMacOS,
		});
		for (const relative of candidates) {
			const file = this.app.vault.getAbstractFileByPath(normalizePath(relative));
			if (file instanceof TFile) return file;
		}
		return null;
	}

	resolveWikilink(linkpath: string): TFile | null {
		return this.app.metadataCache.getFirstLinkpathDest(linkpath, "");
	}

	async openVaultFile(file: TFile, line: number | null, event: MouseEvent): Promise<void> {
		const leaf = this.app.workspace.getLeaf(event.altKey ? "split" : false);
		await leaf.openFile(file, line !== null ? { eState: { line: Math.max(0, line - 1) } } : {});
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	/** OSC 8 hyperlinks. Only web, mail and Obsidian links leave the app. */
	async openHyperlink(uri: string, event: MouseEvent, cwd: string | undefined): Promise<void> {
		if (uri.startsWith("file://")) {
			const file = this.resolveVaultFile(uri, cwd);
			if (file) await this.openVaultFile(file, null, event);
			else new Notice(`Not a note in this vault: ${parseFileUri(uri) ?? uri}`);
			return;
		}
		if (/^(https?|mailto|obsidian):/i.test(uri)) {
			window.open(uri, "_blank");
			return;
		}
		new Notice(`Link not opened — unsupported scheme: ${uri}`);
	}

	/* ---------------------------------------------------------------- */
	/* Launch profiles                                                  */
	/* ---------------------------------------------------------------- */

	validProfiles(): TerminalProfile[] {
		return this.settings.profiles.filter((profile) => profile.name.trim().length > 0 && profile.command.trim().length > 0);
	}

	launchProfile(profile: TerminalProfile): void {
		const dock = this.requireDock();
		if (!dock) return;
		const command = expandTemplate(profile.command.trim(), this.templateVariables(), (value) =>
			shellQuote(value, Platform.isWin),
		);
		dock.launch(profile, command);
	}

	private templateVariables(): TemplateVariables {
		const base = this.vaultBasePath();
		const file = this.app.workspace.getActiveFile();
		const selection = this.app.workspace.activeEditor?.editor?.getSelection() ?? "";
		return {
			vault: base,
			file: file?.path ?? null,
			fileAbs: base && file ? path.join(base, file.path) : null,
			folder: this.activeFileFolder(),
			name: file?.basename ?? null,
			selection: selection.length > 0 ? selection : null,
		};
	}

	/* ---------------------------------------------------------------- */
	/* Diagnostics                                                      */
	/* ---------------------------------------------------------------- */

	/** Build identity of this main.js. Identical on two machines = same code. */
	buildStamp(): string {
		return __BUILD_STAMP__;
	}

	/**
	 * Everything needed to work out why a machine behaves the way it does.
	 * Meant to be copied out of settings and compared between devices.
	 */
	diagnosticsReport(): string {
		const pluginDir = this.pluginDirectory();
		const { file, args } = this.resolveShell();
		const binaries = installedPtyBinaries(pluginDir);
		const dock = this.dock;
		const active = dock?.getActive() ?? null;
		const lines: string[] = [];

		lines.push(`Toggle Terminal ${this.manifest.version}`);
		lines.push(`build       ${this.buildStamp()}`);
		lines.push(`obsidian    ${apiVersion}`);
		lines.push(`platform    ${process.platform} ${process.arch}`);
		lines.push(`plugin dir  ${pluginDir ?? "(unknown — not a FileSystemAdapter)"}`);
		lines.push(`backend     ${this.backendKind()}`);
		lines.push(`shell       ${file} ${args.join(" ")}`.trimEnd());
		lines.push(`panel       ${dock ? `${this.settings.position}, ${dock.isShown() ? "shown" : "hidden"}${dock.isMaximized() ? ", maximized" : ""}` : "(not mounted)"}`);
		if (dock?.isShown()) {
			const rect = dock.el.getBoundingClientRect();
			lines.push(`geometry    ${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
		}
		lines.push(`terminals   ${dock?.getInstances().length ?? 0}`);
		lines.push(`renderer    ${active?.renderer ?? "(no terminal open)"}`);
		lines.push(`locale      LANG=${process.env.LANG ?? "(unset)"} navigator=${navigator.language}`);
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
		// markdown otherwise eats the backslashes in Windows paths.
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

	/** Icon used by the ribbon button and menus. */
	iconName(): string {
		return this.iconId;
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
		return terminalEnv({
			vaultPath: this.vaultBasePath(),
			vaultName: this.app.vault.getName(),
			pluginVersion: this.manifest.version,
			extra: parseEnvLines(this.settings.extraEnv),
		});
	}

	/** Absolute path of the installed plugin folder, used to resolve node-pty. */
	pluginDirectory(): string | null {
		const basePath = this.vaultBasePath();
		const dir = this.manifest.dir;
		if (!basePath || !dir) return null;
		return path.join(basePath, dir);
	}

	/** Absolute folder of the active note, if any. */
	activeFileFolder(): string | null {
		const base = this.vaultBasePath();
		const file = this.app.workspace.getActiveFile();
		if (!base || !file?.parent) return null;
		return path.join(base, file.parent.path);
	}

	resolveWorkingDirectory(): string | undefined {
		const basePath = this.vaultBasePath();

		switch (this.settings.startDirectory) {
			case "home":
				return os.homedir();
			case "custom":
				return this.settings.customDirectory || basePath || undefined;
			case "activeFile":
				return this.activeFileFolder() ?? basePath ?? undefined;
			case "vault":
			default:
				return basePath ?? undefined;
		}
	}

	vaultBasePath(): string | null {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
	}

	/* ---------------------------------------------------------------- */
	/* Settings                                                         */
	/* ---------------------------------------------------------------- */

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as StoredData | null;
		const migrated = migrateSettings(stored);
		this.settings = migrated.settings;
		this.state = migrated.state;
		this.legacyPanelHidden = migrated.legacyPanelHidden;
	}

	async saveSettings(): Promise<void> {
		if (this.saveTimer !== 0) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = 0;
		}
		await this.saveData({ ...this.settings, state: this.state });
	}

	/** Coalesce rapid state changes (dragging the divider) into one write. */
	saveStateSoon(): void {
		if (this.saveTimer !== 0) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = 0;
			void this.saveSettings();
		}, 500);
	}
}
