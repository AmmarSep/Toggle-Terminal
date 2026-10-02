import { App, Notice, Platform, PluginSettingTab, Setting, debounce } from "obsidian";
import type ToggleTerminalPlugin from "./main";
import { TEMPLATE_VARIABLES } from "./send";

export type StartDirectory = "vault" | "home" | "activeFile" | "custom";
export type DockPosition = "bottom" | "right" | "left";
export type StartupBehaviour = "restore" | "always" | "never";
export type ToggleBehaviour = "hide" | "focusFirst";
export type ExitBehaviour = "keep" | "close";
export type LinkActivation = "click" | "modClick";
export type RendererPreference = "auto" | "dom";
export type CursorStyle = "bar" | "block" | "underline";

export interface TerminalProfile {
	id: string;
	name: string;
	/** Typed at the prompt once the shell is ready. Supports {{file}}, {{folder}}, {{vault}}… */
	command: string;
}

export interface ToggleTerminalSettings {
	/* Shell */
	/** Shell executable. Empty string means "detect from the platform". */
	shellPath: string;
	/** Extra arguments, space separated. Empty string means "use platform defaults". */
	shellArgs: string;
	/** Start the shell as a login shell (POSIX only, ignored on Windows). */
	loginShell: boolean;
	startDirectory: StartDirectory;
	/** Used when startDirectory is "custom". */
	customDirectory: string;
	/** Interpreter used for the pty bridge. Empty string means "auto-detect". */
	pythonPath: string;
	/** Extra environment variables, KEY=value per line. */
	extraEnv: string;

	/* Panel */
	position: DockPosition;
	/** Bottom panel height in px until the divider is dragged. */
	panelHeight: number;
	/** Side panel width in px until the divider is dragged. */
	panelWidth: number;
	startup: StartupBehaviour;
	/** Move focus into the terminal whenever the panel is revealed. */
	focusOnReveal: boolean;
	toggleBehaviour: ToggleBehaviour;
	/** Leave the maximized state when a note is opened. */
	restoreOnFileOpen: boolean;
	onExit: ExitBehaviour;
	/** Ask before closing a terminal whose foreground program is not the shell. */
	confirmKillRunning: boolean;

	/* Appearance */
	/** Terminal font size in px. */
	fontSize: number;
	/** Empty string falls back to Obsidian's --font-monospace. */
	fontFamily: string;
	lineHeight: number;
	cursorStyle: CursorStyle;
	cursorBlink: boolean;
	/** Lines of scrollback retained by xterm. */
	scrollback: number;
	renderer: RendererPreference;

	/* Keyboard and mouse */
	/** Swallow keystrokes so Obsidian hotkeys do not fire while the terminal has focus. */
	captureKeyboard: boolean;
	/** macOS: ⌘ shortcuts the terminal does not use go to Obsidian. */
	passAppShortcuts: boolean;
	/** Shift+Enter inserts a newline in Claude Code and similar prompts. */
	shiftEnterNewline: boolean;
	/** Windows/Linux: Ctrl+C copies a selection, Ctrl+V pastes. */
	ctrlCopyPaste: boolean;
	copyOnSelect: boolean;
	linkActivation: LinkActivation;

	/* Notifications */
	notifyOnBell: boolean;
	/** OSC 9 / OSC 777 notifications sent by programs (Claude Code, build tools). */
	notifyOnMessage: boolean;

	profiles: TerminalProfile[];
}

/** Window state, kept apart from preferences. */
export interface PanelState {
	/** Visible when last changed; restored at startup. */
	open: boolean;
	/** Dragged sizes in px; null until the divider is first moved. */
	sizeBottom: number | null;
	sizeSide: number | null;
	maximized: boolean;
}

export const DEFAULT_SETTINGS: ToggleTerminalSettings = {
	shellPath: "",
	shellArgs: "",
	loginShell: true,
	startDirectory: "vault",
	customDirectory: "",
	pythonPath: "",
	extraEnv: "",

	position: "bottom",
	panelHeight: 300,
	panelWidth: 520,
	startup: "restore",
	focusOnReveal: true,
	toggleBehaviour: "hide",
	restoreOnFileOpen: true,
	onExit: "keep",
	confirmKillRunning: true,

	fontSize: 13,
	fontFamily: "",
	lineHeight: 1.1,
	cursorStyle: "bar",
	cursorBlink: true,
	scrollback: 10000,
	renderer: "auto",

	captureKeyboard: true,
	passAppShortcuts: true,
	shiftEnterNewline: true,
	ctrlCopyPaste: true,
	copyOnSelect: false,
	linkActivation: "modClick",

	notifyOnBell: true,
	notifyOnMessage: true,

	profiles: [{ id: "claude-code", name: "Claude Code", command: "claude" }],
};

export const DEFAULT_STATE: PanelState = {
	open: false,
	sizeBottom: null,
	sizeSide: null,
	maximized: false,
};

/** data.json: settings at the top level (as in 1.x), window state under `state`. */
export type StoredData = Record<string, unknown> & { state?: unknown };

const ENUMS: Partial<Record<keyof ToggleTerminalSettings, readonly string[]>> = {
	startDirectory: ["vault", "home", "activeFile", "custom"],
	position: ["bottom", "right", "left"],
	startup: ["restore", "always", "never"],
	toggleBehaviour: ["hide", "focusFirst"],
	onExit: ["keep", "close"],
	linkActivation: ["click", "modClick"],
	renderer: ["auto", "dom"],
	cursorStyle: ["bar", "block", "underline"],
};

function newProfileId(): string {
	return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function sanitiseProfiles(value: unknown): TerminalProfile[] | null {
	if (!Array.isArray(value)) return null;
	const profiles: TerminalProfile[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		profiles.push({
			id: typeof record.id === "string" && record.id.length > 0 ? record.id : newProfileId(),
			name: typeof record.name === "string" ? record.name : "",
			command: typeof record.command === "string" ? record.command : "",
		});
	}
	return profiles;
}

/**
 * Merge stored data over the defaults, dropping anything of the wrong type.
 * 1.x kept `panelHidden` (collapse state of the old leaf) and `showStatusBar`;
 * the first is returned for the leaf migration, the second has no successor.
 */
export function migrateSettings(stored: StoredData | null): {
	settings: ToggleTerminalSettings;
	state: PanelState;
	legacyPanelHidden: boolean | null;
} {
	const raw: StoredData = stored ?? {};
	const settings: ToggleTerminalSettings = {
		...DEFAULT_SETTINGS,
		profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({ ...profile })),
	};
	const target = settings as unknown as Record<string, unknown>;

	for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof ToggleTerminalSettings>) {
		if (key === "profiles") continue;
		const value = raw[key];
		if (value === undefined || typeof value !== typeof DEFAULT_SETTINGS[key]) continue;
		if (typeof value === "number" && !Number.isFinite(value)) continue;
		const allowed = ENUMS[key];
		if (allowed && !allowed.includes(value as string)) continue;
		target[key] = value;
	}
	settings.profiles = sanitiseProfiles(raw.profiles) ?? settings.profiles;

	const state: PanelState = { ...DEFAULT_STATE };
	if (typeof raw.state === "object" && raw.state !== null) {
		const storedState = raw.state as Record<string, unknown>;
		if (typeof storedState.open === "boolean") state.open = storedState.open;
		if (typeof storedState.maximized === "boolean") state.maximized = storedState.maximized;
		if (typeof storedState.sizeBottom === "number" && storedState.sizeBottom > 0) state.sizeBottom = storedState.sizeBottom;
		if (typeof storedState.sizeSide === "number" && storedState.sizeSide > 0) state.sizeSide = storedState.sizeSide;
	}

	return {
		settings,
		state,
		legacyPanelHidden: typeof raw.panelHidden === "boolean" ? raw.panelHidden : null,
	};
}

export function createProfile(): TerminalProfile {
	return { id: newProfileId(), name: "", command: "" };
}

export class ToggleTerminalSettingTab extends PluginSettingTab {
	private readonly plugin: ToggleTerminalPlugin;
	private readonly refreshProfileCommands: () => void;

	constructor(app: App, plugin: ToggleTerminalPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.refreshProfileCommands = debounce(() => plugin.registerProfileCommands(), 600, true);
	}

	private async save(applyToTerminals = false): Promise<void> {
		await this.plugin.saveSettings();
		if (applyToTerminals) this.plugin.dock?.applySettings();
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const { settings } = this.plugin;

		/* ------------------------------------------------------------ */
		new Setting(containerEl).setName("Panel").setHeading();

		new Setting(containerEl)
			.setName("Position")
			.setDesc("Where the panel docks. It stays docked whatever you open or close in the editor.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ bottom: "Bottom", right: "Right", left: "Left" })
					.setValue(settings.position)
					.onChange(async (value) => {
						const position = value as DockPosition;
						if (this.plugin.dock) {
							this.plugin.dock.setPosition(position);
						} else {
							settings.position = position;
							await this.save();
						}
					}),
			);

		new Setting(containerEl)
			.setName("Default size")
			.setDesc("Starting height (bottom) and width (sides) in pixels. Drag the panel's edge to resize; double-click the edge to maximize.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.addClass("tt-number-input");
				text.setPlaceholder("height")
					.setValue(String(settings.panelHeight))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (Number.isFinite(parsed) && parsed >= 80) {
							settings.panelHeight = parsed;
							await this.save();
						}
					});
			})
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.addClass("tt-number-input");
				text.setPlaceholder("width")
					.setValue(String(settings.panelWidth))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (Number.isFinite(parsed) && parsed >= 200) {
							settings.panelWidth = parsed;
							await this.save();
						}
					});
			})
			.addButton((button) =>
				button.setButtonText("Reset size").onClick(() => {
					this.plugin.state.sizeBottom = null;
					this.plugin.state.sizeSide = null;
					this.plugin.state.maximized = false;
					this.plugin.saveStateSoon();
					this.plugin.dock?.setMaximized(false, false);
					this.plugin.dock?.scheduleLayout();
				}),
			);

		new Setting(containerEl)
			.setName("On startup")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						restore: "Reopen if it was open",
						always: "Always open the panel",
						never: "Stay closed until toggled",
					})
					.setValue(settings.startup)
					.onChange(async (value) => {
						settings.startup = value as StartupBehaviour;
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName("Toggle hotkey when the panel is open but not focused")
			.setDesc("The toggle command defaults to Ctrl+` — change it under Settings → Hotkeys.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ hide: "Hide the panel", focusFirst: "Focus the terminal first" })
					.setValue(settings.toggleBehaviour)
					.onChange(async (value) => {
						settings.toggleBehaviour = value as ToggleBehaviour;
						await this.save();
					}),
			);

		this.toggle(containerEl, "Focus terminal when revealed", "", "focusOnReveal");
		this.toggle(
			containerEl,
			"Restore size when a note opens",
			"Leave the maximized state as soon as you open or switch notes.",
			"restoreOnFileOpen",
		);

		new Setting(containerEl)
			.setName("When the shell exits")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ keep: "Keep the tab (Enter restarts)", close: "Close the tab" })
					.setValue(settings.onExit)
					.onChange(async (value) => {
						settings.onExit = value as ExitBehaviour;
						await this.save();
					}),
			);

		this.toggle(
			containerEl,
			"Confirm before killing a running program",
			"Ask before closing a terminal where something other than the shell is running, such as Claude Code.",
			"confirmKillRunning",
		);

		/* ------------------------------------------------------------ */
		new Setting(containerEl).setName("Launch profiles").setHeading();

		const intro = containerEl.createDiv({ cls: "setting-item-description tt-settings-note" });
		intro.appendText("Each profile opens a new terminal tab and types its command at the prompt. Every profile also appears in the command palette and in the panel's ");
		intro.createEl("strong", { text: "⌄" });
		intro.appendText(" menu. Placeholders, quoted for your shell: ");
		TEMPLATE_VARIABLES.forEach((variable, index) => {
			intro.createEl("code", { text: `{{${variable.name}}}`, attr: { title: variable.description } });
			if (index < TEMPLATE_VARIABLES.length - 1) intro.appendText(" ");
		});

		for (const profile of settings.profiles) {
			const row = new Setting(containerEl)
				.addText((text) =>
					text
						.setPlaceholder("Name")
						.setValue(profile.name)
						.onChange(async (value) => {
							profile.name = value;
							await this.save();
							this.refreshProfileCommands();
						}),
				)
				.addText((text) => {
					text.inputEl.addClass("tt-profile-command");
					text.setPlaceholder("Command, e.g. claude \"{{file}}\"")
						.setValue(profile.command)
						.onChange(async (value) => {
							profile.command = value;
							await this.save();
							this.refreshProfileCommands();
						});
				})
				.addExtraButton((button) =>
					button
						.setIcon("play")
						.setTooltip("Launch now")
						.onClick(() => this.plugin.launchProfile(profile)),
				)
				.addExtraButton((button) =>
					button
						.setIcon("trash-2")
						.setTooltip("Delete profile")
						.onClick(async () => {
							settings.profiles = settings.profiles.filter((candidate) => candidate !== profile);
							await this.save();
							this.plugin.registerProfileCommands();
							this.display();
						}),
				);
			row.settingEl.addClass("tt-profile-row");
		}

		new Setting(containerEl).addButton((button) =>
			button.setButtonText("Add profile").onClick(async () => {
				settings.profiles.push(createProfile());
				await this.save();
				this.display();
			}),
		);

		/* ------------------------------------------------------------ */
		new Setting(containerEl).setName("Shell").setHeading();

		new Setting(containerEl)
			.setName("Shell path")
			.setDesc(
				Platform.isWin
					? "Leave empty to use %COMSPEC% — normally cmd.exe. Set powershell.exe or pwsh.exe here if you prefer."
					: "Leave empty to use $SHELL.",
			)
			.addText((text) =>
				text
					.setPlaceholder(this.plugin.detectedShell())
					.setValue(settings.shellPath)
					.onChange(async (value) => {
						settings.shellPath = value.trim();
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName("Shell arguments")
			.setDesc("Space separated; quotes group words. Leave empty for sensible defaults.")
			.addText((text) =>
				text
					.setPlaceholder("--norc -i")
					.setValue(settings.shellArgs)
					.onChange(async (value) => {
						settings.shellArgs = value;
						await this.save();
					}),
			);

		this.toggle(
			containerEl,
			"Login shell",
			"Pass -l so profile files load. Ignored on Windows and when custom arguments are set.",
			"loginShell",
		);

		new Setting(containerEl).setName("Working directory").addDropdown((dropdown) =>
			dropdown
				.addOptions({
					vault: "Vault root",
					activeFile: "Folder of the active note",
					home: "Home directory",
					custom: "Custom path",
				})
				.setValue(settings.startDirectory)
				.onChange(async (value) => {
					settings.startDirectory = value as StartDirectory;
					await this.save();
					this.display();
				}),
		);

		if (settings.startDirectory === "custom") {
			new Setting(containerEl).setName("Custom path").addText((text) =>
				text
					.setPlaceholder("/absolute/path")
					.setValue(settings.customDirectory)
					.onChange(async (value) => {
						settings.customDirectory = value.trim();
						await this.save();
					}),
			);
		}

		new Setting(containerEl)
			.setName("Environment variables")
			.setDesc("KEY=value, one per line. Applied to new sessions. OBSIDIAN_VAULT_PATH and OBSIDIAN_VAULT_NAME are always set.")
			.addTextArea((area) => {
				area.inputEl.rows = 3;
				area.inputEl.addClass("tt-env-input");
				area.setPlaceholder("EDITOR=vim")
					.setValue(settings.extraEnv)
					.onChange(async (value) => {
						settings.extraEnv = value;
						await this.save();
					});
			});

		/* ------------------------------------------------------------ */
		new Setting(containerEl).setName("Appearance").setHeading();

		new Setting(containerEl)
			.setName("Font size")
			.setDesc("⌘/Ctrl + and − (or ⌘/Ctrl + scroll) zoom the terminal temporarily; ⌘/Ctrl 0 resets.")
			.addSlider((slider) =>
				slider
					.setLimits(8, 28, 1)
					.setValue(settings.fontSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.fontSize = value;
						await this.save(true);
					}),
			);

		new Setting(containerEl)
			.setName("Font family")
			.setDesc("Leave empty to inherit Obsidian's monospace font.")
			.addText((text) =>
				text
					.setPlaceholder("JetBrains Mono, monospace")
					.setValue(settings.fontFamily)
					.onChange(async (value) => {
						settings.fontFamily = value.trim();
						await this.save(true);
					}),
			);

		new Setting(containerEl).setName("Line height").addSlider((slider) =>
			slider
				.setLimits(1, 1.6, 0.05)
				.setValue(settings.lineHeight)
				.setDynamicTooltip()
				.onChange(async (value) => {
					settings.lineHeight = value;
					await this.save(true);
				}),
		);

		new Setting(containerEl)
			.setName("Cursor")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ bar: "Bar", block: "Block", underline: "Underline" })
					.setValue(settings.cursorStyle)
					.onChange(async (value) => {
						settings.cursorStyle = value as CursorStyle;
						await this.save(true);
					}),
			)
			.addToggle((toggle) =>
				toggle
					.setTooltip("Blink")
					.setValue(settings.cursorBlink)
					.onChange(async (value) => {
						settings.cursorBlink = value;
						await this.save(true);
					}),
			);

		new Setting(containerEl)
			.setName("Scrollback")
			.setDesc("Lines kept in history per terminal.")
			.addSlider((slider) =>
				slider
					.setLimits(1000, 100000, 1000)
					.setValue(settings.scrollback)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.scrollback = value;
						await this.save(true);
					}),
			);

		new Setting(containerEl)
			.setName("Renderer")
			.setDesc("GPU rendering is faster and smoother for full-screen programs. Switch to DOM if text renders incorrectly.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ auto: "GPU (WebGL), DOM fallback", dom: "DOM" })
					.setValue(settings.renderer)
					.onChange(async (value) => {
						settings.renderer = value as RendererPreference;
						await this.save(true);
					}),
			);

		/* ------------------------------------------------------------ */
		new Setting(containerEl).setName("Keyboard and mouse").setHeading();

		this.toggle(
			containerEl,
			"Capture keyboard",
			"Send keystrokes to the shell instead of Obsidian while the terminal is focused. This plugin's own hotkeys always work.",
			"captureKeyboard",
		);

		if (Platform.isMacOS) {
			this.toggle(
				containerEl,
				"Let ⌘ shortcuts reach Obsidian",
				"⌘P, ⌘O, ⌘, and other ⌘ shortcuts the terminal does not use work while it is focused. ⌘C/V/A/K/F/T and ⌘+/− stay with the terminal; ⌘W does nothing, so it cannot close the note behind it.",
				"passAppShortcuts",
			);
		} else {
			this.toggle(
				containerEl,
				"Ctrl+C copies, Ctrl+V pastes",
				"Ctrl+C copies when text is selected and interrupts otherwise. Ctrl+Shift+C/V always work.",
				"ctrlCopyPaste",
			);
		}

		this.toggle(
			containerEl,
			"Shift+Enter inserts a newline",
			"Sends ESC+Enter, which Claude Code and most line editors read as a new line instead of submitting.",
			"shiftEnterNewline",
		);
		this.toggle(containerEl, "Copy on select", "Selecting text copies it to the clipboard.", "copyOnSelect");

		new Setting(containerEl)
			.setName("Open links and note paths with")
			.setDesc("URLs, file paths of notes in this vault, and [[wikilinks]] in terminal output are clickable.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ modClick: Platform.isMacOS ? "⌘ + click" : "Ctrl + click", click: "Click" })
					.setValue(settings.linkActivation)
					.onChange(async (value) => {
						settings.linkActivation = value as LinkActivation;
						await this.save();
					}),
			);

		/* ------------------------------------------------------------ */
		new Setting(containerEl).setName("Notifications").setHeading();

		this.toggle(
			containerEl,
			"Bell",
			"When a terminal rings the bell while it is hidden or Obsidian is in the background, show a notification and mark its tab.",
			"notifyOnBell",
		);
		this.toggle(
			containerEl,
			"Program notifications",
			"Show OSC 9 / OSC 777 notifications sent by programs — for example Claude Code with its notification channel set to iTerm2 or a terminal bell.",
			"notifyOnMessage",
		);

		/* ------------------------------------------------------------ */
		new Setting(containerEl).setName("Diagnostics").setHeading();

		const backendDescription: Record<string, string> = {
			pty: "node-pty. Full TTY: interactive programs, colours and live resizing.",
			bridge:
				"Bundled Python pty bridge. Real TTY with live resizing — functionally the same as node-pty, one extra process. Nothing to install.",
			piped: Platform.isWin
				? "Plain pipes, no TTY — the pty bridge is POSIX-only. Run `npm install @lydell/node-pty` in the plugin folder for a real ConPTY terminal; it downloads a prebuilt binary, no compiler needed. Until then: line mode, simple commands only, no interactive programs."
				: "Plain pipes, no TTY. Line mode with local echo: simple commands only, no vim or password prompts.",
		};

		const backend = this.plugin.backendKind();
		new Setting(containerEl).setName("Backend").setDesc(backendDescription[backend] ?? "Unknown.");

		new Setting(containerEl)
			.setName("Build")
			.setDesc(
				`${this.plugin.buildStamp()} — identifies the running main.js. Two devices showing the same stamp run the same code; if they differ, sync has not landed yet.`,
			)
			.addButton((button) =>
				button
					.setButtonText("Copy diagnostics")
					.setTooltip("Platform, backend, panel geometry, pty candidates and why each one failed")
					.onClick(async () => {
						await navigator.clipboard.writeText(this.plugin.diagnosticsReport());
						new Notice("Diagnostics copied to clipboard");
					}),
			);

		// The bridge cannot run on Windows at all, so the setting would only mislead.
		if (!Platform.isWin) {
			new Setting(containerEl)
				.setName("Python path")
				.setDesc(
					backend === "piped"
						? "No usable python3 was found, so the pty bridge is unavailable. Set an absolute path here, or install node-pty (see the README)."
						: "Runs the pty bridge when node-pty is not installed. Leave empty to auto-detect Homebrew and system python3.",
				)
				.addText((text) =>
					text
						.setPlaceholder("/opt/homebrew/bin/python3")
						.setValue(settings.pythonPath)
						.onChange(async (value) => {
							settings.pythonPath = value.trim();
							await this.save();
						}),
				);
		}
	}

	/** A plain boolean setting. */
	private toggle(
		containerEl: HTMLElement,
		name: string,
		description: string,
		key: { [K in keyof ToggleTerminalSettings]: ToggleTerminalSettings[K] extends boolean ? K : never }[keyof ToggleTerminalSettings],
	): void {
		const setting = new Setting(containerEl).setName(name);
		if (description.length > 0) setting.setDesc(description);
		setting.addToggle((toggle) =>
			toggle.setValue(this.plugin.settings[key]).onChange(async (value) => {
				this.plugin.settings[key] = value;
				await this.save(true);
			}),
		);
	}
}
