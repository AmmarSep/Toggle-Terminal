import { test } from "node:test";
import assert from "node:assert/strict";

import { setPlatform } from "./obsidian-stub";
import { codeToKey, hotkeyMatches, keyName, routeKey, type KeyLike, type KeyPolicy } from "../src/keys";
import { claudeMention, expandTemplate, shellQuote, toShellCommand } from "../src/send";
import { findLinks, resolvePath, vaultRelativeCandidates } from "../src/links";
import { clampSize, dockRect } from "../src/geometry";
import { localeEnv, parseEnvLines, utf8Locale } from "../src/pty";
import { DEFAULT_SETTINGS, migrateSettings } from "../src/settings";

function key(partial: Partial<KeyLike> & { key: string }): KeyLike {
	const code =
		partial.code ??
		(/^[a-z]$/i.test(partial.key) ? `Key${partial.key.toUpperCase()}` : /^[0-9]$/.test(partial.key) ? `Digit${partial.key}` : partial.key);
	return { type: "keydown", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...partial, code };
}

function policy(overrides: Partial<KeyPolicy> = {}): KeyPolicy {
	return {
		isMac: true,
		hasSelection: false,
		passAppShortcuts: true,
		shiftEnterNewline: true,
		ctrlCopyPaste: true,
		isAppHotkey: () => false,
		...overrides,
	};
}

test("keys: plain typing and control keys go to the shell", () => {
	assert.deepEqual(routeKey(key({ key: "a" }), policy()), { kind: "shell" });
	assert.deepEqual(routeKey(key({ key: "c", ctrlKey: true }), policy()), { kind: "shell" }); // ^C on mac = SIGINT
	assert.deepEqual(routeKey(key({ key: "r", ctrlKey: true }), policy({ isMac: false })), { kind: "shell" });
	assert.deepEqual(routeKey(key({ key: "Enter" }), policy()), { kind: "shell" });
	assert.deepEqual(routeKey({ ...key({ key: "a" }), type: "keyup" }, policy()), { kind: "shell" });
});

test("keys: the plugin's own hotkeys always reach Obsidian", () => {
	const toggle = key({ key: "`", code: "Backquote", ctrlKey: true });
	const p = policy({ isAppHotkey: (e) => hotkeyMatches({ modifiers: ["Ctrl"], key: "`" }, e, true) });
	assert.deepEqual(routeKey(toggle, p), { kind: "app" });
	// Rebound to ⌘J: the new binding passes, the old one is a shell key again.
	const rebound = policy({ isAppHotkey: (e) => hotkeyMatches({ modifiers: ["Mod"], key: "J" }, e, true) });
	assert.deepEqual(routeKey(key({ key: "j", metaKey: true }), rebound), { kind: "app" });
	assert.deepEqual(routeKey(toggle, rebound), { kind: "shell" });
});

test("keys: macOS ⌘ shortcuts", () => {
	const p = policy();
	assert.deepEqual(routeKey(key({ key: "p", metaKey: true }), p), { kind: "app" }); // command palette
	assert.deepEqual(routeKey(key({ key: "o", metaKey: true }), p), { kind: "app" });
	assert.deepEqual(routeKey(key({ key: "c", metaKey: true }), p), { kind: "native" });
	assert.deepEqual(routeKey(key({ key: "v", metaKey: true }), p), { kind: "native" });
	assert.deepEqual(routeKey(key({ key: "k", metaKey: true }), p), { kind: "command", command: "clear" });
	assert.deepEqual(routeKey(key({ key: "f", metaKey: true }), p), { kind: "command", command: "find" });
	assert.deepEqual(routeKey(key({ key: "w", metaKey: true }), p), { kind: "swallow" });
	assert.deepEqual(routeKey(key({ key: "t", metaKey: true }), p), { kind: "command", command: "newTab" });
	assert.deepEqual(routeKey(key({ key: "=", code: "Equal", metaKey: true }), p), { kind: "command", command: "zoomIn" });
	assert.deepEqual(routeKey(key({ key: "+", code: "Equal", metaKey: true, shiftKey: true }), p), { kind: "command", command: "zoomIn" });
	assert.deepEqual(routeKey(key({ key: "-", code: "Minus", metaKey: true }), p), { kind: "command", command: "zoomOut" });
	assert.deepEqual(routeKey(key({ key: "0", metaKey: true }), p), { kind: "command", command: "zoomReset" });
	assert.deepEqual(routeKey(key({ key: "Enter", metaKey: true, shiftKey: true }), p), { kind: "command", command: "toggleMaximize" });
	assert.deepEqual(routeKey(key({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true }), p), { kind: "command", command: "previousTab" });
	assert.deepEqual(routeKey(key({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true }), p), { kind: "command", command: "nextTab" });
	assert.deepEqual(routeKey(key({ key: "Backspace", metaKey: true }), p), { kind: "send", data: "\x15" });
	assert.deepEqual(routeKey(key({ key: "ArrowLeft", metaKey: true }), p), { kind: "send", data: "\x01" });
	// With pass-through off, unknown ⌘ shortcuts are dropped instead.
	assert.deepEqual(routeKey(key({ key: "p", metaKey: true }), policy({ passAppShortcuts: false })), { kind: "swallow" });
	// ⌥ letters keep their physical identity: ⌥⌘P is "p", not "π".
	assert.deepEqual(routeKey(key({ key: "π", code: "KeyP", metaKey: true, altKey: true }), p), { kind: "app" });
	// Option alone is a shell key (Meta).
	assert.deepEqual(routeKey(key({ key: "∫", code: "KeyB", altKey: true }), p), { kind: "shell" });
});

test("keys: Shift+Enter sends ESC CR for Claude Code", () => {
	assert.deepEqual(routeKey(key({ key: "Enter", shiftKey: true }), policy()), { kind: "send", data: "\x1b\r" });
	assert.deepEqual(routeKey(key({ key: "Enter", shiftKey: true }), policy({ shiftEnterNewline: false })), { kind: "shell" });
	assert.deepEqual(routeKey(key({ key: "Enter", shiftKey: true }), policy({ isMac: false })), { kind: "send", data: "\x1b\r" });
});

test("keys: Windows/Linux copy, paste and tabs", () => {
	const p = policy({ isMac: false });
	assert.deepEqual(routeKey(key({ key: "c", ctrlKey: true }), p), { kind: "shell" });
	assert.deepEqual(routeKey(key({ key: "c", ctrlKey: true }), { ...p, hasSelection: true }), { kind: "command", command: "copy" });
	assert.deepEqual(routeKey(key({ key: "c", ctrlKey: true }), { ...p, hasSelection: true, ctrlCopyPaste: false }), { kind: "shell" });
	assert.deepEqual(routeKey(key({ key: "v", ctrlKey: true }), p), { kind: "native" });
	assert.deepEqual(routeKey(key({ key: "C", ctrlKey: true, shiftKey: true }), p), { kind: "command", command: "copy" });
	assert.deepEqual(routeKey(key({ key: "V", ctrlKey: true, shiftKey: true }), p), { kind: "command", command: "paste" });
	assert.deepEqual(routeKey(key({ key: "F", ctrlKey: true, shiftKey: true }), p), { kind: "command", command: "find" });
	assert.deepEqual(routeKey(key({ key: "+", code: "Equal", ctrlKey: true, shiftKey: true }), p), { kind: "command", command: "zoomIn" });
	assert.deepEqual(routeKey(key({ key: "_", code: "Minus", ctrlKey: true, shiftKey: true }), p), { kind: "command", command: "zoomOut" });
	assert.deepEqual(routeKey(key({ key: ")", code: "Digit0", ctrlKey: true, shiftKey: true }), p), { kind: "command", command: "zoomReset" });
	assert.deepEqual(routeKey(key({ key: "Tab", ctrlKey: true }), p), { kind: "command", command: "nextTab" });
	assert.deepEqual(routeKey(key({ key: "Tab", ctrlKey: true, shiftKey: true }), p), { kind: "command", command: "previousTab" });
	assert.deepEqual(routeKey(key({ key: "PageDown", ctrlKey: true }), p), { kind: "command", command: "nextTab" });
	assert.deepEqual(routeKey(key({ key: "p", ctrlKey: true }), p), { kind: "shell" }); // shell history, not the palette
});

test("keys: hotkey matching", () => {
	assert.equal(hotkeyMatches({ modifiers: ["Mod"], key: "P" }, key({ key: "p", metaKey: true }), true), true);
	assert.equal(hotkeyMatches({ modifiers: ["Mod"], key: "P" }, key({ key: "p", ctrlKey: true }), false), true);
	assert.equal(hotkeyMatches({ modifiers: ["Mod"], key: "P" }, key({ key: "p", ctrlKey: true }), true), false);
	assert.equal(hotkeyMatches({ modifiers: "Mod,Shift", key: "P" }, key({ key: "P", metaKey: true, shiftKey: true }), true), true);
	assert.equal(hotkeyMatches({ modifiers: ["Ctrl"], key: "`" }, key({ key: "`", code: "Backquote", ctrlKey: true, shiftKey: true }), true), false);
	assert.equal(keyName(key({ key: "a", code: "KeyQ" })), "a"); // AZERTY: the character wins
	assert.equal(codeToKey("Backquote"), "`");
});

test("send: markdown is stripped, quoting is safe", () => {
	assert.equal(toShellCommand("```bash\n$ ls -la\n```"), "ls -la");
	assert.equal(toShellCommand("echo hi > out.txt"), "echo hi > out.txt");
	assert.equal(toShellCommand("> git status\n> git diff"), "git status\ngit diff");
	assert.equal(shellQuote("notes/My Note.md", false), "'notes/My Note.md'");
	assert.equal(shellQuote("it's.md", false), "'it'\\''s.md'");
	assert.equal(shellQuote("plain/path.md", false), "plain/path.md");
	assert.equal(shellQuote("C:\\My Vault\\a.md", true), '"C:\\My Vault\\a.md"');
	assert.equal(claudeMention("06-JOURNAL/30-08-2026 Log.md"), '@"06-JOURNAL/30-08-2026 Log.md"');
	assert.equal(claudeMention("notes/a.md"), "@notes/a.md");
	const quote = (v: string): string => shellQuote(v, false);
	assert.equal(expandTemplate('claude "{{file}}"', { file: "a b.md" }, quote), "claude \"'a b.md'\"");
	assert.equal(expandTemplate("claude {{file}} {{nope}}", { file: "x.md" }, quote), "claude x.md {{nope}}");
	assert.equal(expandTemplate("cd {{folder}}", { folder: null }, quote), "cd ");
});

test("links: longest existing vault path wins, spaces allowed", () => {
	const files = new Set(["06-JOURNAL/2026/30-08-2026 Log.md", "Log.md", "notes/a.md"]);
	const resolve = (candidate: string): string | null => {
		for (const rel of vaultRelativeCandidates(candidate, { vaultBase: "/Users/me/Vault", cwd: "/Users/me/Vault", home: "/Users/me", caseInsensitive: false })) {
			if (files.has(rel)) return rel;
		}
		return null;
	};
	const line = "⏺ Update(06-JOURNAL/2026/30-08-2026 Log.md) and notes/a.md:12, not notes/a.mdx or x.md.bak";
	const found = findLinks(line, resolve);
	assert.deepEqual(
		found.map((m) => [line.slice(m.start, m.end), m.target, m.line]),
		[
			["06-JOURNAL/2026/30-08-2026 Log.md", "06-JOURNAL/2026/30-08-2026 Log.md", null],
			["notes/a.md:12", "notes/a.md", 12],
		],
	);
	// Absolute paths inside the vault, and file:// URIs with a host.
	assert.deepEqual(findLinks("open /Users/me/Vault/notes/a.md now", resolve).map((m) => m.target), ["notes/a.md"]);
	assert.deepEqual(vaultRelativeCandidates("file://host/Users/me/Vault/notes/a%20b.md", { vaultBase: "/Users/me/Vault", cwd: null, home: null, caseInsensitive: false }), ["notes/a b.md"]);
	// Outside the vault: nothing.
	assert.deepEqual(findLinks("/etc/hosts.md", resolve), []);
	// Wikilinks.
	const wl = findLinks("see [[Log|the log]] and [[Missing]]", () => null, (link) => (link === "Log" ? "Log.md" : null));
	assert.deepEqual(wl.map((m) => m.target), ["Log.md"]);
	assert.equal(resolvePath("/a/b", "../c/./d.md"), "/a/c/d.md");
	assert.equal(resolvePath("C:/v", "x/../y.md"), "C:/v/y.md");
});

test("geometry: dock rectangles and clamping", () => {
	const root = { left: 300, top: 0, width: 800, height: 500 }; // after a 300px reservation
	assert.deepEqual(dockRect("bottom", root, 300, false, 40), { left: 300, top: 500, width: 800, height: 300 });
	assert.deepEqual(dockRect("bottom", root, 300, true, 40), { left: 300, top: 40, width: 800, height: 760 });
	assert.deepEqual(dockRect("right", root, 400, false, 40), { left: 1100, top: 0, width: 400, height: 500 });
	assert.deepEqual(dockRect("right", root, 400, true, 40), { left: 300, top: 40, width: 1200, height: 460 });
	assert.deepEqual(dockRect("left", root, 250, false, 40), { left: 50, top: 0, width: 250, height: 500 });
	// No upper cap beyond the window: up to everything but the editor's tab row.
	assert.equal(clampSize("bottom", 5000, 800, 40), 760);
	assert.equal(clampSize("bottom", 10, 800, 40), 90);
	assert.equal(clampSize("right", 5000, 1200, 160), 1040);
});

test("pty: locale and env helpers", () => {
	assert.equal(utf8Locale("en-IN"), "en_IN.UTF-8");
	assert.equal(utf8Locale("de"), "de_DE.UTF-8");
	assert.equal(utf8Locale(undefined), "en_US.UTF-8");
	setPlatform({ isMacOS: true });
	assert.deepEqual(localeEnv("en-IN", (l) => l === "en_US.UTF-8"), { LANG: "en_US.UTF-8" });
	assert.deepEqual(localeEnv("en-GB", () => true), { LANG: "en_GB.UTF-8" });
	assert.deepEqual(localeEnv("xx", () => false), { LC_CTYPE: "UTF-8" });
	setPlatform({ isMacOS: false });
	assert.deepEqual(localeEnv("en-US", () => true), { LC_CTYPE: "C.UTF-8" });
	setPlatform({ isMacOS: true });
	assert.deepEqual(parseEnvLines("# c\nA=1\nB = 'two words'\n bad line\n9X=no\nC=\"q\""), { A: "1", B: "two words", C: "q" });
});

test("settings: 1.x data.json migrates cleanly", () => {
	const old = {
		shellPath: "",
		shellArgs: "",
		loginShell: true,
		startDirectory: "vault",
		customDirectory: "",
		fontSize: 13,
		fontFamily: "",
		scrollback: 5000,
		panelHeight: 260,
		showStatusBar: false,
		focusOnReveal: true,
		captureKeyboard: true,
		pythonPath: "",
		panelHidden: false,
	};
	const { settings, state, legacyPanelHidden } = migrateSettings(old);
	assert.equal(settings.panelHeight, 260);
	assert.equal(settings.scrollback, 5000);
	assert.equal(settings.position, "bottom");
	assert.equal(legacyPanelHidden, false);
	assert.equal(state.open, false);
	assert.equal((settings as unknown as Record<string, unknown>).showStatusBar, undefined);
	assert.deepEqual(settings.profiles, DEFAULT_SETTINGS.profiles);
	// Garbage is ignored, not trusted.
	const bad = migrateSettings({ position: "top", fontSize: "big", state: { sizeBottom: -4, open: true } });
	assert.equal(bad.settings.position, "bottom");
	assert.equal(bad.settings.fontSize, 13);
	assert.equal(bad.state.sizeBottom, null);
	assert.equal(bad.state.open, true);
	// Profiles round-trip, ids are filled in.
	const withProfiles = migrateSettings({ profiles: [{ name: "x", command: "y" }] });
	assert.equal(withProfiles.settings.profiles.length, 1);
	assert.ok(withProfiles.settings.profiles[0].id.length > 0);
});
