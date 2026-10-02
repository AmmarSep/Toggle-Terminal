# Toggle Terminal

A terminal that gets out of the way. Press <kbd>Ctrl</kbd>+<kbd>`</kbd> to drop a real shell into a panel docked under your notes; press it again and the panel disappears — but every shell keeps running.

That last part is the point. Hiding the terminal costs you nothing: scrollback, environment, a running Claude Code session all survive the toggle.

## What's new in 2.0

The panel was rebuilt as a **dock** that lives outside Obsidian's pane layout.

- **It always stays docked.** In 1.x the terminal was an ordinary pane split below the active note, so closing your notes turned it into a full-size tab and new notes opened as tabs beside it. The dock is anchored to the editor area itself and is unaffected by notes opening, closing or moving.
- **No size limit.** Drag the edge up to the very top of the editor area, or **maximize** it (button, double-click the header or the edge, <kbd>⌘⇧↩</kbd> / <kbd>Ctrl+Shift+Enter</kbd>, or the *Maximize or restore panel* command). The size you drag to is remembered.
- **Bottom, right or left.** Right-click the panel header or use *Move panel to…*.
- **Several terminals.** Tabs with rename, reorder by drag, close, and titles that follow the running program (`zsh`, `claude`, `vim`) or the title the program sets.

## Features

- **Toggle that preserves state.** Hide and show as often as you like; shells never restart.
- **A real TTY.** Prompts, colours and interactive programs (`vim`, `ssh`, `htop`, `claude`) work, with live resizing. Wide characters and emoji line up (Unicode 11), and full-screen programs redraw without tearing (synchronized output).
- **Launch profiles.** One click (or one command) opens a new tab and runs a command — *Claude Code* (`claude`) is included. Commands can use `{{file}}`, `{{folder}}`, `{{vault}}`, `{{fileAbs}}`, `{{name}}` and `{{selection}}`, quoted for your shell: `claude "{{file}}"`.
- **Notes ↔ terminal.**
  - Select a command in a note → right-click → **Send to terminal** (lands at the prompt) or **Run in terminal**. Markdown is stripped: code fences, `$ ` / `% ` / `PS C:\>` prompts, blockquotes.
  - **Insert active note's path**, or **as @mention** for Claude Code.
  - **Drag** notes or folders from the file explorer — or files from Finder/Explorer — onto the terminal to paste their paths.
  - Right-click a folder → **Open in terminal**.
  - Note paths, `[[wikilinks]]`, URLs and OSC 8 hyperlinks in the output are clickable (<kbd>⌘</kbd>/<kbd>Ctrl</kbd>+click). `path/to/note.md:42` opens at line 42.
- **Find** (<kbd>⌘F</kbd> / <kbd>Ctrl+Shift+F</kbd>) with match case, whole word and regex.
- **Notifications.** A bell or an OSC 9 / 777 / 99 notification from a hidden terminal shows a notice (or a system notification when Obsidian is in the background), marks the tab and badges the ribbon icon. Set Claude Code's notification channel to `iterm2_with_bell` to hear when it needs you.
- **Safe closing.** Closing a terminal whose foreground program is not the shell asks first.
- **Themed.** Colours, fonts and selection follow your Obsidian theme and update live.

## Keyboard

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Toggle the panel | <kbd>Ctrl</kbd>+<kbd>`</kbd> | <kbd>Ctrl</kbd>+<kbd>`</kbd> |
| New terminal | <kbd>⌘T</kbd> | <kbd>Ctrl+Shift+T</kbd> |
| Next / previous terminal | <kbd>Ctrl+Tab</kbd>, <kbd>⌘⇧]</kbd> / <kbd>⌘⇧[</kbd> | <kbd>Ctrl+Tab</kbd>, <kbd>Ctrl+PgDn</kbd> / <kbd>Ctrl+PgUp</kbd> |
| Maximize / restore | <kbd>⌘⇧↩</kbd> | <kbd>Ctrl+Shift+Enter</kbd> |
| Find | <kbd>⌘F</kbd> | <kbd>Ctrl+Shift+F</kbd> |
| Clear | <kbd>⌘K</kbd> | command palette |
| Copy / paste | <kbd>⌘C</kbd> / <kbd>⌘V</kbd> | <kbd>Ctrl+C</kbd> (with a selection) / <kbd>Ctrl+V</kbd>, or <kbd>Ctrl+Shift+C/V</kbd> |
| Zoom | <kbd>⌘+</kbd> <kbd>⌘−</kbd> <kbd>⌘0</kbd>, <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+scroll | <kbd>Ctrl+Shift+=</kbd> <kbd>Ctrl+Shift+−</kbd> <kbd>Ctrl+Shift+0</kbd>, <kbd>Ctrl</kbd>+scroll |
| Newline in Claude Code | <kbd>Shift+Enter</kbd> | <kbd>Shift+Enter</kbd> |
| Line start / end / delete line | <kbd>⌘←</kbd> <kbd>⌘→</kbd> <kbd>⌘⌫</kbd> | — |

While the terminal has focus, keystrokes go to the shell — except this plugin's own hotkeys (including any you rebind in Settings → Hotkeys), and on macOS the ⌘ shortcuts the terminal does not use, so <kbd>⌘P</kbd>, <kbd>⌘O</kbd> and <kbd>⌘,</kbd> still work. <kbd>⌘W</kbd> does nothing inside the terminal, so it can never close the note behind it.

Every action is also in the command palette under *Toggle Terminal*, and in the right-click menus of the terminal, its tabs, the panel header and the ribbon icon.

## Requirements

Desktop only, since a terminal needs Node APIs that Obsidian's mobile app does not have.

For a full TTY the plugin needs one of:

- **node-pty** — preferred, and the only route on Windows. See below.
- **python3** — used by a small bundled bridge. Present on macOS with the Xcode Command Line Tools and on virtually all Linux systems. Nothing to install.

Without either, the panel still works in a reduced *line mode*: type a command, press Enter, see the output. No prompt, no colours, and interactive programs will not run.

### Installing node-pty

Run this once in the plugin folder (`.obsidian/plugins/toggle-terminal`) on each machine — native binaries do not travel over Obsidian Sync:

```bash
npm install @lydell/node-pty
```

It downloads a prebuilt binary (ConPTY on Windows); no compiler, and no rebuild step, because the binaries are N-API and therefore ABI-stable across Electron.

## Settings

- **Panel** — position, default size (and a reset), startup behaviour, what the toggle hotkey does when the panel is open but unfocused, focus on reveal, restoring the size when a note opens, what happens when a shell exits, and the confirmation before killing a running program.
- **Launch profiles** — name and command per profile; each becomes a palette command.
- **Shell** — path, arguments, login shell, working directory (vault root, active note's folder, home, or custom), extra environment variables. `OBSIDIAN_VAULT_PATH` and `OBSIDIAN_VAULT_NAME` are always set, and a UTF-8 locale is supplied when Obsidian was started without one.
- **Appearance** — font size and family, line height, cursor, scrollback, renderer.
- **Keyboard and mouse** — keyboard capture, ⌘ shortcuts to Obsidian, Ctrl+C/V copy-paste, Shift+Enter newline, copy on select, link activation.
- **Notifications** — bell and program notifications.
- **Diagnostics** — active backend, build stamp, and a copyable report: platform, panel geometry, every pty candidate and why it failed.

## How it works

### The dock

The panel is a single element placed over a strip of the editor area. The strip is reserved by a margin on Obsidian's root split, so the notes shrink to make room and nothing in Obsidian's layout tree changes. Because the dock is not a pane, Obsidian never rearranges it: closing the last note, loading a workspace or splitting panes cannot pull it into a tab group. When a layout change replaces the root split, the reservation moves to the new one.

### Backends

| Kind | Mechanism | TTY | Live resize |
| --- | --- | --- | --- |
| `pty` | node-pty | yes | yes |
| `bridge` | bundled `pty-bridge.py` | yes | yes |
| `piped` | plain pipes | no | n/a |

The **bridge** calls `pty.fork()`, execs your shell on the slave, and proxies the master over ordinary pipes — what node-pty does natively, minus the native module. Resize messages arrive on fd 3. When Obsidian goes away the bridge hangs up the pty like a closed terminal window, so no shell is left running.

Because Obsidian installs only `main.js`, `manifest.json` and `styles.css`, the bridge is embedded in the bundle at build time and written next to `main.js` on first run.

### Pasting

Text from notes is pasted with xterm's own paste, which uses bracketed-paste markers only when the running program asked for them — so a multi-line command waits for Enter in a shell, and arrives intact in vim or Claude Code.

## Development

```bash
npm install
npm run dev     # watch
npm run build   # type-check + production bundle
npm test        # unit tests (keyboard routing, links, geometry, settings migration…)
```

Outputs `main.js` and `styles.css` next to `manifest.json`.

`test/harness/` mounts the real plugin in Chromium against a mock of Obsidian's workspace DOM, with real shells behind a WebSocket — useful for checking the dock's layout without restarting Obsidian (`node test/harness/build.mjs && node test/harness/server.mjs`, then open http://localhost:8765).

```
pty-bridge.py       pty allocator, embedded into the bundle at build time
src/
  main.ts           entry: commands, menus, hotkeys, paths, links, profiles, diagnostics
  dock.ts           the panel: placement, resizing, maximize, tabs, menus
  geometry.ts       pure placement maths for the dock
  instance.ts       one terminal: xterm.js, session, keyboard, find, links, OSC handlers
  keys.ts           keyboard routing between shell, Obsidian and terminal actions
  links.ts          vault paths and wikilinks in terminal output
  pty.ts            session abstraction, backend selection, environment
  send.ts           markdown-to-shell cleaning, quoting, profile templates
  theme.ts          Obsidian CSS variables to xterm ITheme
  settings.ts       settings, defaults, migration from 1.x, settings tab
  legacy-view.ts    placeholder that retires 1.x's terminal pane
  styles.css        xterm stylesheet plus panel styles
```

## Credits

- [xterm.js](https://github.com/xtermjs/xterm.js) — terminal rendering (MIT)
- [@lydell/node-pty](https://github.com/lydell/node-pty) — prebuilt distribution of [node-pty](https://github.com/microsoft/node-pty) by Microsoft (MIT)
- Icons from [Lucide](https://lucide.dev) (ISC)

## Licence

[MIT](LICENSE)
