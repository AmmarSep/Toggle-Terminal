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

function isDarkTheme(el: HTMLElement): boolean {
	const body = el.ownerDocument.body;
	if (body.classList.contains("theme-light")) return false;
	return true;
}

/** Builds an xterm theme from the Obsidian CSS variables in scope for `el`. */
export function obsidianTerminalTheme(el: HTMLElement): ITheme {
	const styles = getComputedStyle(el);

	const read = (variable: string, fallback: string): string => {
		const value = styles.getPropertyValue(variable).trim();
		return isValidColor(value) ? value : fallback;
	};

	const dark = isDarkTheme(el);
	const foreground = read("--text-normal", dark ? "#dadada" : "#222222");
	const background = read("--background-primary", dark ? "#1e1e1e" : "#ffffff");
	const selection = read("--text-selection", "rgba(128, 128, 128, 0.35)");

	// ANSI black/white mean "dark"/"light" ink regardless of the theme, so they
	// are mapped differently in light mode — otherwise black text vanishes on
	// a light background.
	const ink = dark
		? {
				black: read("--color-base-30", "#3b3b3b"),
				brightBlack: read("--color-base-50", "#5c6370"),
				white: read("--text-muted", "#d7dae0"),
				brightWhite: read("--text-normal", "#e6e6e6"),
			}
		: {
				black: read("--text-normal", "#222222"),
				brightBlack: read("--text-muted", "#5c6370"),
				white: read("--color-base-50", "#a0a0a0"),
				brightWhite: read("--color-base-70", "#5a5a5a"),
			};

	return {
		background,
		foreground,
		cursor: read("--text-accent", foreground),
		cursorAccent: background,
		selectionBackground: selection,
		selectionInactiveBackground: selection,
		overviewRulerBorder: background,
		scrollbarSliderBackground: read("--scrollbar-thumb-bg", "rgba(128, 128, 128, 0.25)"),
		scrollbarSliderHoverBackground: read("--scrollbar-active-thumb-bg", "rgba(128, 128, 128, 0.45)"),
		scrollbarSliderActiveBackground: read("--scrollbar-active-thumb-bg", "rgba(128, 128, 128, 0.55)"),
		red: read("--color-red", "#e05561"),
		green: read("--color-green", "#8cc265"),
		yellow: read("--color-yellow", "#d18f52"),
		blue: read("--color-blue", "#4aa5f0"),
		magenta: read("--color-purple", "#c162de"),
		cyan: read("--color-cyan", "#42b3c2"),
		brightRed: read("--color-red", "#ff616e"),
		brightGreen: read("--color-green", "#a5e075"),
		brightYellow: read("--color-yellow", "#f0a45d"),
		brightBlue: read("--color-blue", "#4dc4ff"),
		brightMagenta: read("--color-purple", "#de73ff"),
		brightCyan: read("--color-cyan", "#4cd1e0"),
		...ink,
	};
}

/** Obsidian's monospace stack, used when the user has not overridden the font. */
export function obsidianMonospaceFont(el: HTMLElement): string {
	const value = getComputedStyle(el).getPropertyValue("--font-monospace").trim();
	return value.length > 0 ? value : "monospace";
}

/**
 * Resolve any CSS colour to `#rrggbb`. The search addon only accepts that
 * form, while theme variables are often `rgba()` or `hsl()`.
 */
export function cssColorToHex(value: string, el: HTMLElement, fallback: string): string {
	if (!isValidColor(value)) return fallback;
	const probe = el.ownerDocument.createElement("span");
	probe.style.color = value;
	probe.style.display = "none";
	el.appendChild(probe);
	const computed = getComputedStyle(probe).color;
	probe.remove();

	const match = computed.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
	if (!match) return fallback;
	return (
		"#" +
		[match[1], match[2], match[3]]
			.map((channel) => Number.parseInt(channel, 10).toString(16).padStart(2, "0"))
			.join("")
	);
}

/** Read a variable from `el`'s scope as `#rrggbb`. */
export function themeHex(el: HTMLElement, variable: string, fallback: string): string {
	const value = getComputedStyle(el).getPropertyValue(variable).trim();
	return cssColorToHex(value, el, fallback);
}
