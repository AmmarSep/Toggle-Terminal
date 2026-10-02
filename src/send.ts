/**
 * Text that travels from notes to the shell.
 *
 * Notes wrap commands in markdown: fences, `$ ` prompt decoration, blockquotes.
 * Pasting that verbatim makes the shell choke on the decoration rather than
 * running the command. This strips the markdown and leaves the command.
 */

const FENCE = /^\s*(```|~~~)/;
const PROMPT = /^(\s*)[$%]\s+/;
const QUOTE = /^\s*>\s?/;

/**
 * Windows prompt decoration: `PS C:\src>`, `PS>`, `C:\src>`. Deliberately
 * requires either the `PS` marker or a drive path, so a bare `> file` stays a
 * redirect rather than being mistaken for a prompt.
 */
const WIN_PROMPT = /^(\s*)(?:PS\s+[A-Za-z]:\\[^>]*>|PS>|[A-Za-z]:\\[^>]*>)\s+/;

export function toShellCommand(raw: string): string {
	const lines = raw.replace(/\r\n?/g, "\n").split("\n");

	// Fence markers, with or without a language tag.
	const unfenced = lines.filter((line) => !FENCE.test(line));

	// Only unwrap blockquotes when the whole selection is quoted — otherwise a
	// leading `>` is a redirect and must survive.
	const content = unfenced.filter((line) => line.trim().length > 0);
	const fullyQuoted = content.length > 0 && content.every((line) => QUOTE.test(line));
	const unquoted = fullyQuoted ? unfenced.map((line) => line.replace(QUOTE, "")) : unfenced;

	// `$ ` and `% ` are prompt decoration in docs, never part of the command.
	// The space is required, so `$HOME/bin` and `%s` formats are left alone.
	const cleaned = unquoted.map((line) =>
		line.replace(WIN_PROMPT, "$1").replace(PROMPT, "$1").replace(/\s+$/, ""),
	);

	// Drop blank lines at the edges, keep interior structure.
	let start = 0;
	let end = cleaned.length;
	while (start < end && cleaned[start].trim().length === 0) start += 1;
	while (end > start && cleaned[end - 1].trim().length === 0) end -= 1;

	return cleaned.slice(start, end).join("\n");
}

/** Collapse to one line, for the no-TTY fallback where we echo input ourselves. */
export function toSingleLine(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join(" ");
}

/* -------------------------------------------------------------------------- */
/* Quoting                                                                    */
/* -------------------------------------------------------------------------- */

const POSIX_SAFE = /^[\w@%+=:,./-]+$/;
const WINDOWS_SAFE = /^[\w@%+=:,./\\-]+$/;

/**
 * Quote one argument for the user's shell. POSIX shells get single quotes
 * (nothing inside is special); cmd.exe and PowerShell both accept double
 * quotes with embedded quotes doubled.
 */
export function shellQuote(value: string, windows: boolean): string {
	if (value.length === 0) return windows ? '""' : "''";
	if (windows) {
		return WINDOWS_SAFE.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
	}
	return POSIX_SAFE.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/** Claude Code's file mention syntax; quoted when the path contains spaces. */
export function claudeMention(relativePath: string): string {
	const normalised = relativePath.replace(/\\/g, "/");
	return /\s/.test(normalised) ? `@"${normalised}"` : `@${normalised}`;
}

/* -------------------------------------------------------------------------- */
/* Launch-profile templates                                                   */
/* -------------------------------------------------------------------------- */

export type TemplateVariables = Record<string, string | null | undefined>;

/** Placeholders a profile command may use. Values are shell-quoted on expansion. */
export const TEMPLATE_VARIABLES: ReadonlyArray<{ name: string; description: string }> = [
	{ name: "vault", description: "absolute path of the vault" },
	{ name: "file", description: "active note, relative to the vault" },
	{ name: "fileAbs", description: "active note, absolute path" },
	{ name: "folder", description: "folder of the active note, absolute path" },
	{ name: "name", description: "active note's name without extension" },
	{ name: "selection", description: "selected text in the active editor" },
];

/**
 * `{{name}}` → quoted value. Unknown names are left exactly as written so a
 * typo is visible in the terminal rather than silently becoming nothing.
 */
export function expandTemplate(
	template: string,
	variables: TemplateVariables,
	quote: (value: string) => string,
): string {
	return template.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (match: string, name: string) => {
		if (!Object.prototype.hasOwnProperty.call(variables, name)) return match;
		const value = variables[name];
		return value ? quote(value) : "";
	});
}
