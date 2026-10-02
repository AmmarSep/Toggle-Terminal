import type { IBufferCell, IBufferRange, ILink, ILinkProvider, Terminal } from "@xterm/xterm";

/**
 * Clickable vault paths in terminal output.
 *
 * Claude Code, git, grep and friends print paths all the time, and in a vault
 * those paths are notes. Spaces are normal in note names ("30-08-2026 Log.md"),
 * so a regex cannot know where a path starts. Instead every extension is an
 * anchor, and the longest run of text before it that names a real vault file
 * wins — a lookup per candidate, nothing touches the disk.
 */

/* -------------------------------------------------------------------------- */
/* Path helpers (no node:path, so this module is testable anywhere)           */
/* -------------------------------------------------------------------------- */

export function toForwardSlashes(value: string): string {
	return value.replace(/\\/g, "/");
}

export function isAbsolutePath(value: string): boolean {
	return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** Join and resolve `.`/`..` segments. Inputs use forward slashes. */
export function resolvePath(base: string, relative: string): string {
	const absolute = isAbsolutePath(relative) ? relative : `${base.replace(/\/+$/, "")}/${relative}`;
	const drive = /^[A-Za-z]:/.exec(absolute)?.[0] ?? "";
	const rest = absolute.slice(drive.length);
	const parts: string[] = [];
	for (const part of rest.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return `${drive}/${parts.join("/")}`;
}

export interface PathContext {
	/** Absolute vault root, forward slashes. */
	vaultBase: string | null;
	/** The session's working directory, forward slashes. */
	cwd: string | null;
	home: string | null;
	caseInsensitive: boolean;
}

/**
 * Vault-relative interpretations of `candidate`, best first. A relative path
 * is tried against the shell's directory and against the vault root, since
 * tools differ in which one they print relative to.
 */
export function vaultRelativeCandidates(rawCandidate: string, context: PathContext): string[] {
	const base = context.vaultBase ? toForwardSlashes(context.vaultBase).replace(/\/+$/, "") : null;
	let candidate = toForwardSlashes(rawCandidate.trim());
	if (candidate.startsWith("file://")) {
		// file://host/path — the host part (often empty) is skipped.
		const rest = candidate.slice("file://".length);
		const slash = rest.indexOf("/");
		if (slash < 0) return [];
		try {
			candidate = decodeURIComponent(rest.slice(slash));
		} catch {
			return [];
		}
		// file:///C:/x → /C:/x → C:/x
		if (/^\/[A-Za-z]:\//.test(candidate)) candidate = candidate.slice(1);
	}
	if (candidate.startsWith("~/") && context.home) {
		candidate = `${toForwardSlashes(context.home).replace(/\/+$/, "")}${candidate.slice(1)}`;
	}

	const results: string[] = [];
	const add = (value: string | null): void => {
		if (value && !results.includes(value)) results.push(value);
	};

	const relativeToVault = (absolute: string): string | null => {
		if (!base) return null;
		const resolved = resolvePath("/", absolute);
		const root = resolvePath("/", base);
		const a = context.caseInsensitive ? resolved.toLowerCase() : resolved;
		const r = context.caseInsensitive ? root.toLowerCase() : root;
		if (a === r) return null;
		if (!a.startsWith(`${r}/`)) return null;
		return resolved.slice(root.length + 1);
	};

	if (isAbsolutePath(candidate)) {
		add(relativeToVault(candidate));
		return results;
	}

	const cleaned = candidate.replace(/^\.\//, "");
	if (context.cwd) add(relativeToVault(resolvePath(toForwardSlashes(context.cwd), cleaned)));
	if (!cleaned.startsWith("../")) add(resolvePath("/", cleaned).slice(1));
	return results;
}

/* -------------------------------------------------------------------------- */
/* Finding links in a line of text                                            */
/* -------------------------------------------------------------------------- */

const EXTENSIONS =
	"md|canvas|base|pdf|png|jpe?g|gif|svg|webp|bmp|avif|heic|mp3|mp4|m4a|webm|wav|ogg|flac|mov|mkv|txt|csv|tsv|json|jsonl|js|mjs|ts|tsx|css|html?|py|sh|ya?ml|toml|excalidraw";

/** An extension that is not immediately continued by more path characters. */
const EXTENSION_PATTERN = new RegExp(`\\.(?:${EXTENSIONS})(?![\\w.-]*\\w)`, "gi");

/** Characters after which a path may begin. */
const START_DELIMITER = /[\s"'`(<[{=:,;@│|>*]/;

const WIKILINK_PATTERN = /\[\[([^\]|#^\n]+)(?:[#^][^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;

const MAX_PATH_LENGTH = 300;

export interface LinkMatch<T> {
	start: number;
	end: number;
	target: T;
	/** 1-based line from a `:12` or `:12:5` suffix. */
	line: number | null;
}

/**
 * @param resolvePathCandidate returns a target when `candidate` names a file.
 * @param resolveWikilink returns a target for the text inside `[[…]]`.
 */
export function findLinks<T>(
	text: string,
	resolvePathCandidate: (candidate: string) => T | null,
	resolveWikilink?: (linkpath: string) => T | null,
): LinkMatch<T>[] {
	const matches: LinkMatch<T>[] = [];

	if (resolveWikilink) {
		WIKILINK_PATTERN.lastIndex = 0;
		for (let m = WIKILINK_PATTERN.exec(text); m; m = WIKILINK_PATTERN.exec(text)) {
			const target = resolveWikilink(m[1].trim());
			if (target !== null) matches.push({ start: m.index, end: m.index + m[0].length, target, line: null });
		}
	}

	EXTENSION_PATTERN.lastIndex = 0;
	for (let m = EXTENSION_PATTERN.exec(text); m; m = EXTENSION_PATTERN.exec(text)) {
		const end = m.index + m[0].length;
		if (matches.some((existing) => m !== null && m.index >= existing.start && m.index < existing.end)) continue;

		const floor = Math.max(0, m.index - MAX_PATH_LENGTH);
		let found: { start: number; target: T } | null = null;
		// Longest first: walk the start position forward from the floor.
		for (let start = floor; start < m.index; start += 1) {
			if (start > 0 && !START_DELIMITER.test(text[start - 1])) continue;
			if (/\s/.test(text[start])) continue;
			const target = resolvePathCandidate(text.slice(start, end));
			if (target !== null) {
				found = { start, target };
				break;
			}
		}
		if (!found) continue;

		let linkEnd = end;
		let line: number | null = null;
		const suffix = /^(?::(\d+)(?::\d+)?|#L(\d+))/.exec(text.slice(end));
		if (suffix) {
			line = Number.parseInt(suffix[1] ?? suffix[2], 10);
			linkEnd += suffix[0].length;
		}
		matches.push({ start: found.start, end: linkEnd, target: found.target, line });
	}

	return matches.sort((a, b) => a.start - b.start);
}

/* -------------------------------------------------------------------------- */
/* xterm glue                                                                 */
/* -------------------------------------------------------------------------- */

interface CellPosition {
	/** 0-based column and buffer row. */
	x: number;
	y: number;
	width: number;
}

interface WrappedLine {
	text: string;
	/** One entry per UTF-16 code unit of `text`. */
	cells: CellPosition[];
}

const MAX_WRAPPED_ROWS = 12;

/** The logical line containing buffer row `row`, joined across soft wraps. */
export function readWrappedLine(terminal: Terminal, row: number): WrappedLine | null {
	const buffer = terminal.buffer.active;
	if (!buffer.getLine(row)) return null;

	let first = row;
	while (first > 0 && row - first < MAX_WRAPPED_ROWS && buffer.getLine(first)?.isWrapped) first -= 1;
	let last = row;
	while (last - first < MAX_WRAPPED_ROWS && buffer.getLine(last + 1)?.isWrapped) last += 1;

	const scratch: IBufferCell = buffer.getNullCell();
	let text = "";
	const cells: CellPosition[] = [];
	for (let y = first; y <= last; y += 1) {
		const line = buffer.getLine(y);
		if (!line) break;
		for (let x = 0; x < line.length; x += 1) {
			const cell = line.getCell(x, scratch);
			if (!cell) continue;
			const width = cell.getWidth();
			if (width === 0) continue; // right half of a wide character
			const chars = cell.getChars() || " ";
			for (let i = 0; i < chars.length; i += 1) cells.push({ x, y, width });
			text += chars;
		}
	}
	return { text, cells };
}

export function toBufferRange(line: WrappedLine, start: number, end: number): IBufferRange | null {
	const first = line.cells[start];
	const last = line.cells[end - 1];
	if (!first || !last) return null;
	return {
		start: { x: first.x + 1, y: first.y + 1 },
		end: { x: last.x + last.width, y: last.y + 1 },
	};
}

export interface VaultLinkHandlers<T> {
	resolvePath(candidate: string): T | null;
	resolveWikilink(linkpath: string): T | null;
	activate(event: MouseEvent, target: T, line: number | null): void;
	hover(event: MouseEvent, target: T): void;
	leave(): void;
}

export class VaultLinkProvider<T> implements ILinkProvider {
	constructor(
		private readonly terminal: Terminal,
		private readonly handlers: VaultLinkHandlers<T>,
	) {}

	provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
		const row = bufferLineNumber - 1;
		const line = readWrappedLine(this.terminal, row);
		if (!line || !/[.[]/.test(line.text)) {
			callback(undefined);
			return;
		}

		const links: ILink[] = [];
		for (const match of findLinks(
			line.text,
			(candidate) => this.handlers.resolvePath(candidate),
			(linkpath) => this.handlers.resolveWikilink(linkpath),
		)) {
			const range = toBufferRange(line, match.start, match.end);
			if (!range) continue;
			// xterm asks per row; only report links that touch this one.
			if (range.end.y < bufferLineNumber || range.start.y > bufferLineNumber) continue;
			links.push({
				range,
				text: line.text.slice(match.start, match.end),
				decorations: { pointerCursor: true, underline: true },
				activate: (event: MouseEvent) => this.handlers.activate(event, match.target, match.line),
				hover: (event: MouseEvent) => this.handlers.hover(event, match.target),
				leave: () => this.handlers.leave(),
			});
		}
		callback(links.length > 0 ? links : undefined);
	}
}
