import type { ITheme } from "@xterm/xterm";

/**
 * xterm throws on colours it cannot parse, and Obsidian themes can leave
 * variables undefined or set them to values xterm does not understand.
 */
function isValidColor(value: string): boolean {
	if (value.length === 0) return false;
	if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
		return CSS.supports("color", value);
	}
	return true;
}

/** Builds an xterm theme from the Obsidian CSS variables in scope for `el`. */
export function obsidianTerminalTheme(el: HTMLElement): ITheme {
	const styles = getComputedStyle(el);

	const read = (variable: string, fallback: string): string => {
		const value = styles.getPropertyValue(variable).trim();
		return isValidColor(value) ? value : fallback;
	};

	const foreground = read("--text-normal", "#dadada");
	const background = read("--background-primary", "#1e1e1e");

	return {
		background,
		foreground,
		cursor: read("--text-accent", foreground),
		cursorAccent: background,
		selectionBackground: read("--text-selection", "rgba(128, 128, 128, 0.35)"),
		black: read("--color-base-30", "#3b3b3b"),
		red: read("--color-red", "#e05561"),
		green: read("--color-green", "#8cc265"),
		yellow: read("--color-yellow", "#d18f52"),
		blue: read("--color-blue", "#4aa5f0"),
		magenta: read("--color-purple", "#c162de"),
		cyan: read("--color-cyan", "#42b3c2"),
		white: read("--text-muted", "#d7dae0"),
		brightBlack: read("--color-base-40", "#5c6370"),
		brightRed: read("--color-red", "#ff616e"),
		brightGreen: read("--color-green", "#a5e075"),
		brightYellow: read("--color-yellow", "#f0a45d"),
		brightBlue: read("--color-blue", "#4dc4ff"),
		brightMagenta: read("--color-purple", "#de73ff"),
		brightCyan: read("--color-cyan", "#4cd1e0"),
		brightWhite: read("--text-normal", "#e6e6e6"),
	};
}

/** Obsidian's monospace stack, used when the user has not overridden the font. */
export function obsidianMonospaceFont(el: HTMLElement): string {
	const value = getComputedStyle(el).getPropertyValue("--font-monospace").trim();
	return value.length > 0 ? value : "monospace";
}
