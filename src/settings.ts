import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type ToggleTerminalPlugin from "./main";

export type StartDirectory = "vault" | "home" | "activeFile" | "custom";

export interface ToggleTerminalSettings {
	/** Shell executable. Empty string means "detect from the platform". */
	shellPath: string;
	/** Extra arguments, space separated. Empty string means "use platform defaults". */
	shellArgs: string;
	/** Start the shell as a login shell (POSIX only, ignored on Windows). */
	loginShell: boolean;
	/** Where the shell starts. */
	startDirectory: StartDirectory;
	/** Used when startDirectory is "custom". */
	customDirectory: string;
	/** Terminal font size in px. */
	fontSize: number;
	/** Empty string falls back to Obsidian's --font-monospace. */
	fontFamily: string;
	/** Lines of scrollback retained by xterm. */
	scrollback: number;
	/** Initial height of the bottom panel in px. */
	panelHeight: number;
	/** Slim strip with the session state and the clear/restart buttons. */
	showStatusBar: boolean;
	/** Move focus into the terminal whenever the panel is revealed. */
	focusOnReveal: boolean;
	/** Swallow keystrokes so Obsidian hotkeys do not fire while the terminal has focus. */
	captureKeyboard: boolean;
	/** Interpreter used for the pty bridge. Empty string means "auto-detect". */
	pythonPath: string;
	/** Persisted collapse state so the panel stays hidden across restarts. */
	panelHidden: boolean;
}

export const DEFAULT_SETTINGS: ToggleTerminalSettings = {
	shellPath: "",
	shellArgs: "",
	loginShell: true,
	startDirectory: "vault",
	customDirectory: "",
	fontSize: 13,
	fontFamily: "",
	scrollback: 5000,
	panelHeight: 260,
	showStatusBar: true,
	focusOnReveal: true,
	captureKeyboard: true,
	pythonPath: "",
	panelHidden: false,
};

export class ToggleTerminalSettingTab extends PluginSettingTab {
	private readonly plugin: ToggleTerminalPlugin;

	constructor(app: App, plugin: ToggleTerminalPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

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
					.setValue(this.plugin.settings.shellPath)
					.onChange(async (value) => {
						this.plugin.settings.shellPath = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Shell arguments")
			.setDesc("Space separated. Leave empty for sensible defaults.")
			.addText((text) =>
				text
					.setPlaceholder("--norc -i")
					.setValue(this.plugin.settings.shellArgs)
					.onChange(async (value) => {
						this.plugin.settings.shellArgs = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Login shell")
			.setDesc("Pass -l so profile files load. Ignored on Windows and when custom arguments are set.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.loginShell).onChange(async (value) => {
					this.plugin.settings.loginShell = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Working directory")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						vault: "Vault root",
						activeFile: "Folder of the active file",
						home: "Home directory",
						custom: "Custom path",
					})
					.setValue(this.plugin.settings.startDirectory)
					.onChange(async (value) => {
						this.plugin.settings.startDirectory = value as StartDirectory;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (this.plugin.settings.startDirectory === "custom") {
			new Setting(containerEl).setName("Custom path").addText((text) =>
				text
					.setPlaceholder("/absolute/path")
					.setValue(this.plugin.settings.customDirectory)
					.onChange(async (value) => {
						this.plugin.settings.customDirectory = value.trim();
						await this.plugin.saveSettings();
					}),
			);
		}

		new Setting(containerEl).setName("Appearance").setHeading();

		new Setting(containerEl)
			.setName("Font size")
			.addSlider((slider) =>
				slider
					.setLimits(8, 24, 1)
					.setValue(this.plugin.settings.fontSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.fontSize = value;
						await this.plugin.saveSettings();
						this.plugin.refreshOpenTerminals();
					}),
			);

		new Setting(containerEl)
			.setName("Font family")
			.setDesc("Leave empty to inherit Obsidian's monospace font.")
			.addText((text) =>
				text
					.setPlaceholder("JetBrains Mono, monospace")
					.setValue(this.plugin.settings.fontFamily)
					.onChange(async (value) => {
						this.plugin.settings.fontFamily = value.trim();
						await this.plugin.saveSettings();
						this.plugin.refreshOpenTerminals();
					}),
			);

		new Setting(containerEl)
			.setName("Panel height")
			.setDesc("Initial height of the bottom panel, in pixels.")
			.addSlider((slider) =>
				slider
					.setLimits(120, 800, 10)
					.setValue(this.plugin.settings.panelHeight)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.panelHeight = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Status bar")
			.setDesc(
				"22px strip showing the shell, backend and pid, with the clear and restart buttons. Turn off for a panel that is nothing but terminal — the commands stay in the palette.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showStatusBar).onChange(async (value) => {
					this.plugin.settings.showStatusBar = value;
					await this.plugin.saveSettings();
					this.plugin.refreshOpenTerminals();
				}),
			);

		new Setting(containerEl)
			.setName("Scrollback")
			.setDesc("Number of lines kept in history.")
			.addSlider((slider) =>
				slider
					.setLimits(500, 50000, 500)
					.setValue(this.plugin.settings.scrollback)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.scrollback = value;
						await this.plugin.saveSettings();
						this.plugin.refreshOpenTerminals();
					}),
			);

		new Setting(containerEl).setName("Behaviour").setHeading();

		new Setting(containerEl)
			.setName("Focus terminal when revealed")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.focusOnReveal).onChange(async (value) => {
					this.plugin.settings.focusOnReveal = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Capture keyboard")
			.setDesc(
				"Send keystrokes to the shell instead of Obsidian while the terminal is focused. The toggle hotkey always works.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.captureKeyboard).onChange(async (value) => {
					this.plugin.settings.captureKeyboard = value;
					await this.plugin.saveSettings();
				}),
			);

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
				`${this.plugin.buildStamp()} — this identifies the running main.js. Two devices showing the same stamp are on the same code; if they differ, sync has not landed yet.`,
			)
			.addButton((button) =>
				button
					.setButtonText("Copy diagnostics")
					.setTooltip("Full report: platform, backend, pty candidates and why each one failed")
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
						: "Runs the pty bridge. Leave empty to auto-detect Homebrew and system python3.",
				)
				.addText((text) =>
					text
						.setPlaceholder("/opt/homebrew/bin/python3")
						.setValue(this.plugin.settings.pythonPath)
						.onChange(async (value) => {
							this.plugin.settings.pythonPath = value.trim();
							await this.plugin.saveSettings();
						}),
				);
		}
	}
}
