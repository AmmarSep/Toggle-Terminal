import { createApp } from "./obsidian-mock";
import ToggleTerminalPlugin from "../../src/main";
import { ToggleTerminalSettingTab } from "../../src/settings";

declare global {
	interface Window {
		__tt: {
			plugin: ToggleTerminalPlugin;
			app: ReturnType<typeof createApp>;
			run(id: string): void;
			ready: boolean;
			renderSettings(): number;
		};
	}
}

const params = new URLSearchParams(location.search);
const stored = params.get("data") ? JSON.parse(params.get("data") as string) : {
	// The user's real 1.x data.json.
	shellPath: "", shellArgs: "", loginShell: true, startDirectory: "vault", customDirectory: "",
	fontSize: 13, fontFamily: "", scrollback: 5000, panelHeight: 260, showStatusBar: false,
	focusOnReveal: true, captureKeyboard: true, pythonPath: "", panelHidden: false,
};

const app = createApp("/root/vault", [
	"06-JOURNAL/2026/30-08-2026 Log.md",
	"06-JOURNAL/Scribble/How to make the cue strong?.md",
	"notes/a.md",
]);
const plugin = new (ToggleTerminalPlugin as unknown as new (a: unknown, m: unknown, d: unknown) => ToggleTerminalPlugin)(
	app,
	{ id: "toggle-terminal", version: "2.0.0", dir: ".obsidian/plugins/toggle-terminal" },
	stored,
);

window.__tt = {
	plugin,
	app,
	ready: false,
	renderSettings() {
		const tab = new ToggleTerminalSettingTab(app as never, plugin);
		tab.display();
		return tab.containerEl.querySelectorAll(".setting-item").length;
	},
	run(id: string) {
		const command = (plugin as unknown as { commands: Map<string, { callback?: () => void; checkCallback?: (c: boolean) => void }> }).commands.get(`toggle-terminal:${id}`);
		if (!command) throw new Error(`no command ${id}`);
		if (command.callback) command.callback();
		else command.checkCallback?.(false);
	},
};

// Obsidian's hotkey manager listens on the document; mimic it for the plugin's commands.
document.addEventListener("keydown", (event) => {
	(window as unknown as { __appKeys: string[] }).__appKeys.push(`${event.metaKey ? "Meta+" : ""}${event.ctrlKey ? "Ctrl+" : ""}${event.shiftKey ? "Shift+" : ""}${event.key}`);
	if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key === "`") {
		event.preventDefault();
		window.__tt.run("toggle");
	}
});
(window as unknown as { __appKeys: string[] }).__appKeys = [];

void plugin.onload().then(() => {
	window.setTimeout(() => {
		window.__tt.ready = true;
	}, 50);
});
