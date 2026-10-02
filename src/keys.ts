/**
 * Keyboard routing for a focused terminal.
 *
 * Every keydown inside xterm has to go to exactly one of three places: the
 * shell, Obsidian, or a terminal-level action (copy, find, zoom…). Getting
 * this wrong is how a terminal panel ends up trapping focus or eating the
 * command palette, so the decision lives here as a pure function that can be
 * tested without a DOM.
 */

/** The subset of KeyboardEvent the router reads. */
export interface KeyLike {
	type: string;
	key: string;
	code: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	isComposing?: boolean;
}

export type TerminalCommand =
	| "copy"
	| "paste"
	| "selectAll"
	| "clear"
	| "find"
	| "zoomIn"
	| "zoomOut"
	| "zoomReset"
	| "newTab"
	| "nextTab"
	| "previousTab"
	| "toggleMaximize";

export type KeyRoute =
	/** Let the event bubble to Obsidian; xterm ignores it. */
	| { kind: "app" }
	/** xterm handles it and sends it to the shell. */
	| { kind: "shell" }
	/** Neither xterm nor Obsidian: let the browser default run (copy/paste events). */
	| { kind: "native" }
	/** Drop it entirely. */
	| { kind: "swallow" }
	| { kind: "command"; command: TerminalCommand }
	/** Send these bytes to the shell instead of what xterm would send. */
	| { kind: "send"; data: string };

export interface KeyPolicy {
	isMac: boolean;
	hasSelection: boolean;
	/** macOS: ⌘ shortcuts the terminal does not use go to Obsidian (command palette, quick switcher…). */
	passAppShortcuts: boolean;
	/** Shift+Enter sends ESC CR, which Claude Code and most line editors treat as "insert newline". */
	shiftEnterNewline: boolean;
	/** Windows/Linux: Ctrl+C copies when there is a selection, Ctrl+V pastes. */
	ctrlCopyPaste: boolean;
	/** True when the event is bound to one of this plugin's commands. */
	isAppHotkey: (event: KeyLike) => boolean;
}

const SHELL: KeyRoute = { kind: "shell" };
const APP: KeyRoute = { kind: "app" };
const NATIVE: KeyRoute = { kind: "native" };
const SWALLOW: KeyRoute = { kind: "swallow" };

function command(name: TerminalCommand): KeyRoute {
	return { kind: "command", command: name };
}

function send(data: string): KeyRoute {
	return { kind: "send", data };
}

/** Layout-independent name for punctuation and digits, from `KeyboardEvent.code`. */
const CODE_KEYS: Record<string, string> = {
	Backquote: "`",
	Minus: "-",
	Equal: "=",
	BracketLeft: "[",
	BracketRight: "]",
	Backslash: "\\",
	Semicolon: ";",
	Quote: "'",
	Comma: ",",
	Period: ".",
	Slash: "/",
	Space: " ",
	NumpadAdd: "+",
	NumpadSubtract: "-",
	NumpadEnter: "Enter",
};

/** `KeyA` → `a`, `Digit1` → `1`, `Backquote` → `` ` ``; anything else unchanged. */
export function codeToKey(code: string): string {
	if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
	if (/^Digit[0-9]$/.test(code)) return code.slice(5);
	if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
	return CODE_KEYS[code] ?? code;
}

/**
 * Normalised key name: lower-case letters, unshifted punctuation, named keys
 * ("Enter", "ArrowLeft") unchanged.
 *
 * The character wins, so ⌘A means the key labelled A on AZERTY too. The
 * physical code is used only where the character is unreliable: Option turns
 * letters into symbols on macOS (⌥P = π), and Shift turns `=` into `+`.
 */
export function keyName(event: KeyLike): string {
	const key = event.key;
	const printable = key.length === 1 && key >= " " && key <= "~";

	if (printable && !event.altKey) {
		const isAlphanumeric = /^[a-z0-9]$/i.test(key);
		if (event.shiftKey && !isAlphanumeric) {
			const fromCode = codeToKey(event.code);
			if (fromCode.length === 1) return fromCode.toLowerCase();
		}
		return key.toLowerCase();
	}

	const fromCode = codeToKey(event.code);
	if (fromCode.length === 1) return fromCode.toLowerCase();
	return key.length === 1 ? key.toLowerCase() : key;
}

export interface HotkeyLike {
	modifiers: readonly string[] | string | null;
	key: string | null;
}

/** Same matching rules Obsidian uses: exact modifier set, key by character or physical code. */
export function hotkeyMatches(hotkey: HotkeyLike, event: KeyLike, isMac: boolean): boolean {
	if (!hotkey.key) return false;
	const modifiers =
		typeof hotkey.modifiers === "string"
			? hotkey.modifiers.split(",").map((m) => m.trim())
			: [...(hotkey.modifiers ?? [])];

	let ctrl = false;
	let meta = false;
	let alt = false;
	let shift = false;
	for (const modifier of modifiers) {
		switch (modifier) {
			case "Mod":
				if (isMac) meta = true;
				else ctrl = true;
				break;
			case "Ctrl":
				ctrl = true;
				break;
			case "Meta":
				meta = true;
				break;
			case "Alt":
				alt = true;
				break;
			case "Shift":
				shift = true;
				break;
			default:
				break;
		}
	}
	if (event.ctrlKey !== ctrl || event.metaKey !== meta || event.altKey !== alt || event.shiftKey !== shift) {
		return false;
	}

	const wanted = hotkey.key.toLowerCase();
	return event.key.toLowerCase() === wanted || codeToKey(event.code).toLowerCase() === wanted;
}

export function routeKey(event: KeyLike, policy: KeyPolicy): KeyRoute {
	if (event.type !== "keydown" || event.isComposing) return SHELL;

	// The plugin's own hotkeys always reach Obsidian, otherwise the panel could
	// never be hidden from inside it.
	if (policy.isAppHotkey(event)) return APP;

	const key = keyName(event);
	const { ctrlKey: ctrl, metaKey: meta, altKey: alt, shiftKey: shift } = event;

	if (key === "Enter" && shift && !ctrl && !meta && !alt) {
		return policy.shiftEnterNewline ? send("\x1b\r") : SHELL;
	}

	if (key === "Tab" && ctrl && !meta && !alt) {
		return command(shift ? "previousTab" : "nextTab");
	}

	return policy.isMac ? routeMac(event, key, policy) : routeOther(event, key, policy);
}

function routeMac(event: KeyLike, key: string, policy: KeyPolicy): KeyRoute {
	const { ctrlKey: ctrl, metaKey: meta, altKey: alt, shiftKey: shift } = event;
	if (!meta || ctrl) return SHELL;

	// ⌘⌥ combinations are never terminal keys.
	if (alt) return policy.passAppShortcuts ? APP : SWALLOW;

	if (!shift) {
		switch (key) {
			case "c":
			case "v":
				// The browser's own copy/paste events, which xterm already handles.
				return NATIVE;
			case "a":
				return command("selectAll");
			case "k":
				return command("clear");
			case "f":
				return command("find");
			case "t":
				return command("newTab");
			case "w":
				// Closing the note behind the terminal, or killing a running
				// session, are both too destructive for a reflex shortcut.
				return SWALLOW;
			case "=":
				return command("zoomIn");
			case "-":
				return command("zoomOut");
			case "0":
				return command("zoomReset");
			case "Backspace":
				return send("\x15"); // kill to start of line
			case "ArrowLeft":
				return send("\x01"); // beginning of line
			case "ArrowRight":
				return send("\x05"); // end of line
			default:
				break;
		}
	} else {
		switch (key) {
			case "=":
				return command("zoomIn"); // ⌘+ on US layouts is ⌘⇧=
			case "Enter":
				return command("toggleMaximize");
			case "[":
				return command("previousTab");
			case "]":
				return command("nextTab");
			default:
				break;
		}
	}

	return policy.passAppShortcuts ? APP : SWALLOW;
}

function routeOther(event: KeyLike, key: string, policy: KeyPolicy): KeyRoute {
	const { ctrlKey: ctrl, metaKey: meta, altKey: alt, shiftKey: shift } = event;
	if (!ctrl || meta || alt) return SHELL;

	if (shift) {
		switch (key) {
			case "c":
				return command("copy");
			case "v":
				return command("paste");
			case "f":
				return command("find");
			case "t":
				return command("newTab");
			case "a":
				return command("selectAll");
			case "Enter":
				return command("toggleMaximize");
			case "=":
				return command("zoomIn");
			case "-":
				return command("zoomOut");
			case "0":
				return command("zoomReset");
			default:
				return SHELL;
		}
	}

	switch (key) {
		case "c":
			return policy.ctrlCopyPaste && policy.hasSelection ? command("copy") : SHELL;
		case "v":
			return policy.ctrlCopyPaste ? NATIVE : SHELL;
		case "PageUp":
			return command("previousTab");
		case "PageDown":
			return command("nextTab");
		default:
			return SHELL;
	}
}
