# Toggle Terminal

A terminal that gets out of the way. Press <kbd>Ctrl</kbd>+<kbd>`</kbd> to drop a real shell into a panel at the bottom of your workspace; press it again and the panel collapses completely — but the shell keeps running.

That last part is the point. Most terminal panels destroy the session when you close them. Here your scrollback, environment, and any long-running command survive the toggle, so hiding the terminal costs you nothing.

## Features

- **Toggle that preserves state.** Hide and show as often as you like; the shell never restarts.
- **A real TTY.** Prompts, colours, and interactive programs such as `vim`, `ssh` and `htop` work, with live resizing as you drag the panel.
- **Send a selection to the shell.** Select a command in a note, right-click → **Send to Toggle Terminal**. It lands at the prompt, ready for you to review and press Enter — it does not run on its own.
- **Markdown-aware.** Selections are cleaned before they arrive: code fences, `$ ` and `% ` prompt characters, `PS C:\>` prompts and fully-quoted blockquotes are stripped, while redirects like `echo hi > out.txt` and variables like `$HOME` are left alone.
- **Themed.** Colours, fonts and selection highlight follow your Obsidian theme and update live when you switch.

## Usage

| Action | How |
| --- | --- |
| Toggle the panel | <kbd>Ctrl</kbd>+<kbd>`</kbd>, or the ribbon icon |
| Send a selection | Right-click → **Send to Toggle Terminal** |
| Everything else | Command palette, under *Toggle Terminal* |

Commands: **Toggle panel**, **Focus panel**, **Restart session**, **Close panel and end session**, **Send selection to terminal**.

The toggle hotkey works from inside the terminal too — it is deliberately excluded from keyboard capture, so the panel can never trap your focus.

## Requirements

Desktop only, since a terminal needs Node APIs that Obsidian's mobile app does not have.

For a full TTY the plugin needs one of:

- **python3** — used by a small bundled bridge. Present by default on macOS (with Xcode Command Line Tools) and virtually all Linux systems. Nothing to install.
- **node-pty** — optional, and the only route on Windows. See below.

Without either, the panel still works in a reduced *line mode*: type a command, press Enter, see the output. No prompt, no colours, and interactive programs will not run.

### Windows

Windows needs node-pty, because the bridge relies on `pty`, `fcntl` and `termios` — all documented by Python as Unix-only. Run this once in the plugin folder:

```bash
npm install @lydell/node-pty
```

It downloads a prebuilt ConPTY binary; no compiler, and no rebuild step, because the binaries are N-API and therefore ABI-stable across Electron. macOS and Linux users can do the same to skip the Python bridge, though there is little reason to.

## Settings

Shell path and arguments, login shell, working directory (vault root, active file's folder, home, or a custom path), font size and family, scrollback, panel height, focus-on-reveal, keyboard capture, and a status bar toggle.

**Diagnostics** shows which backend is active and a build stamp, and can copy a full report — platform, resolved shell, and every pty candidate with the exact reason it failed. Useful when the terminal is not behaving and you want to know why.

## How it works

Three backends, best available wins:

| Kind | Mechanism | TTY | Live resize |
| --- | --- | --- | --- |
| `pty` | node-pty | yes | yes |
| `bridge` | bundled `pty-bridge.py` | yes | yes |
| `piped` | plain pipes | no | n/a |

The **bridge** calls `pty.fork()`, execs your shell on the slave, and proxies the master over ordinary pipes — what node-pty does natively, minus the native module. Resize messages arrive on fd 3 and `TIOCSWINSZ` raises `SIGWINCH`, so dragging the panel resizes the session.

Because Obsidian installs only `main.js`, `manifest.json` and `styles.css`, the bridge is embedded in the bundle at build time and written next to `main.js` on first run.

Multi-line selections are wrapped in **bracketed paste**, so the shell buffers the whole block and waits for Enter rather than executing line by line as the newlines arrive.

The panel is collapsed with a CSS class rather than `detachLeavesOfType()`, which would destroy the view and kill the shell on every toggle. Obsidian exposes no public API for collapsing a pane inside the root split, so this relies on its DOM class names; if those ever change the toggle degrades to a no-op rather than throwing.

## Development

```bash
npm install
npm run dev     # watch
npm run build   # type-check + production bundle
```

Outputs `main.js` and `styles.css` next to `manifest.json`.

```
pty-bridge.py       pty allocator, embedded into the bundle at build time
src/
  main.ts           entry, commands, toggle orchestration, diagnostics
  terminal-view.ts  ItemView hosting xterm.js, fitting, theming, line editing
  panel.ts          collapse/restore helpers
  pty.ts            session abstraction and backend selection
  send.ts           markdown-to-shell cleaning, bracketed paste
  theme.ts          Obsidian CSS variables to xterm ITheme
  settings.ts       settings tab
  styles.css        xterm stylesheet plus panel styles
```

## Credits

- [xterm.js](https://github.com/xtermjs/xterm.js) — terminal rendering (MIT)
- [@lydell/node-pty](https://github.com/lydell/node-pty) — prebuilt distribution of [node-pty](https://github.com/microsoft/node-pty) by Microsoft (MIT)
- Icon from [Lucide](https://lucide.dev) (ISC)

## Licence

[MIT](LICENSE)
