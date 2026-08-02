/**
 * Preparing a note selection for a shell prompt.
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

/**
 * Bracketed paste. Without it a multi-line selection executes line by line as
 * the newlines arrive; inside the brackets the shell treats the whole thing as
 * literal input and waits for Enter. Supported by zsh 5.1+ and bash 4.4+.
 */
export function bracketedPaste(text: string): string {
	return `\x1b[200~${text}\x1b[201~`;
}

/** Collapse to one line, for the no-TTY fallback where we echo input ourselves. */
export function toSingleLine(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join(" ");
}
