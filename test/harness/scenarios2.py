"""Scenario checks for the dock, run against the harness server.

    node test/harness/build.mjs && HARNESS_PATH=/usr/bin:/bin node test/harness/server.mjs &
    python3 test/harness/scenarios2.py     # needs: pip install playwright && playwright install chromium
"""
from playwright.sync_api import sync_playwright
import time, json, sys, os, urllib.parse
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".out")
os.makedirs(OUT, exist_ok=True)

FAILS = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (("  -- " + str(detail)) if detail and not cond else ""))
    if not cond:
        FAILS.append(name)

with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"])
    ctx = b.new_context(viewport={"width": 1400, "height": 860})
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin="http://localhost:8765")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto("http://localhost:8765/")
    page.wait_for_function("window.__tt && window.__tt.ready", timeout=10000)

    def rect(sel):
        return page.evaluate("s => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? {l: r.left, t: r.top, w: r.width, h: r.height, b: r.bottom, r: r.right} : null }", sel)
    def buffer_text(index=None):
        return page.evaluate("""i => { const d = window.__tt.plugin.dock; const inst = i === null ? d.active : d.instances[i];
            const buf = inst.terminal.buffer.active; let s = ''; for (let y = 0; y < buf.length; y++) s += buf.getLine(y).translateToString(true) + '\\n'; return s; }""", index)
    def wait_text(needle, index=None, timeout=4.0):
        end = time.time() + timeout
        while time.time() < end:
            if needle in buffer_text(index): return True
            time.sleep(0.05)
        return False
    def type_line(text):
        page.keyboard.type(text)
        page.keyboard.press("Enter")
    def tabs():
        return page.evaluate("[...document.querySelectorAll('.tt-tab')].map(t => ({title: t.querySelector('.tt-tab-title')?.textContent, cls: t.className}))")

    saved = page.evaluate("window.__saved")
    check("legacy 1.x keys dropped from data.json on first save", saved is None or ("panelHidden" not in saved and "showStatusBar" not in saved), saved and list(saved.keys()))

    page.keyboard.press("Control+`")
    page.wait_for_function("window.__tt.plugin.dock.active && window.__tt.plugin.dock.active.hasOutput", timeout=8000)
    time.sleep(0.8)
    saved = page.evaluate("window.__saved")
    check("data.json: settings flat + state block, no legacy keys", saved and "state" in saved and "panelHidden" not in saved and saved["state"]["open"] is True, saved and saved.get("state"))

    # OSC title → tab name
    type_line("printf '\\033]0;My Title\\007'")
    time.sleep(0.4)
    check("OSC 0 title shows on the tab", tabs()[0]["title"] == "My Title", tabs())

    # rename by double-click
    page.dblclick(".tt-tab .tt-tab-title")
    time.sleep(0.2)
    page.keyboard.press("ControlOrMeta+a")
    page.keyboard.type("claude work")
    page.keyboard.press("Enter")
    time.sleep(0.3)
    check("double-click renames a tab", tabs()[0]["title"] == "claude work", tabs())
    check("focus returns to the terminal after rename", page.evaluate("window.__tt.plugin.dock.hasFocus()"))

    # drag a note from the file explorer onto the terminal
    page.evaluate("""() => {
        const app = window.__tt.app;
        app.dragManager.draggable = { type: 'file', file: app.vault.getAbstractFileByPath('06-JOURNAL/2026/30-08-2026 Log.md') };
        const target = document.querySelector('.tt-instance.is-active .xterm-screen');
        const dt = new DataTransfer();
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        app.dragManager.draggable = null;
    }""")
    time.sleep(0.6)
    check("dropping a note pastes its quoted vault-relative path", wait_text("'06-JOURNAL/2026/30-08-2026 Log.md'"), buffer_text()[-200:])
    page.keyboard.press("Control+c")

    # insert @mention for Claude Code
    page.evaluate("window.__tt.run('insert-mention')")
    time.sleep(0.6)
    check("insert @mention uses Claude Code's syntax", wait_text('@"06-JOURNAL/2026/30-08-2026 Log.md"'), buffer_text()[-200:])
    page.keyboard.press("Control+c")

    # OSC 52 clipboard
    type_line("printf '\\033]52;c;%s\\007' $(printf 'from-osc52' | base64)")
    time.sleep(0.5)
    clip = page.evaluate("navigator.clipboard.readText()")
    check("OSC 52 copies to the system clipboard", clip == "from-osc52", clip)

    # paste command (Ctrl+Shift+V path) from clipboard
    page.evaluate("navigator.clipboard.writeText('echo pasted-$((1+1))')")
    page.evaluate("window.__tt.plugin.dock.active.runCommand('paste')")
    time.sleep(0.5)
    page.keyboard.press("Enter")
    check("paste command inserts clipboard text (bracketed)", wait_text("pasted-2"))

    # progress OSC 9;4
    type_line("printf '\\033]9;4;1;40\\007'")
    time.sleep(0.4)
    bar = page.evaluate("document.querySelector('.tt-tab-progress-bar')?.style.width")
    check("OSC 9;4 progress renders on the tab", bar == "40%", bar)
    type_line("printf '\\033]9;4;0;0\\007'")
    time.sleep(0.4)
    check("progress clears", page.evaluate("!document.querySelector('.tt-tab-progress')"))

    # background tab: bell + activity markers
    page.click(".tt-new-button")
    page.wait_for_function("window.__tt.plugin.dock.instances.length === 2 && window.__tt.plugin.dock.active.hasOutput", timeout=6000)
    time.sleep(0.4)
    # run in tab 1 (background) via its session
    page.evaluate("window.__tt.plugin.dock.instances[0].session.write(\"sleep 0.3; printf 'bg-output\\\\a'\\r\")")
    time.sleep(1.2)
    t = tabs()
    check("background tab shows bell marker", "has-bell" in t[0]["cls"], t)
    notices = page.evaluate("window.__notices")
    check("bell in a background tab raises a notice", any("terminal bell" in n for n in notices), notices)
    page.click(".tt-tab:nth-child(1)")
    time.sleep(0.3)
    t = tabs()
    check("viewing the tab clears the markers", "has-bell" not in t[0]["cls"] and "has-activity" not in t[0]["cls"], t)

    # OSC 9 notification while the panel is hidden → notice + ribbon badge
    page.evaluate("window.__tt.plugin.dock.instances[1].session.write(\"sleep 0.5; printf '\\\\033]9;Claude is waiting for your input\\\\007'\\r\")")
    page.keyboard.press("Control+`")
    time.sleep(1.4)
    notices = page.evaluate("window.__notices")
    check("OSC 9 message becomes a notice when hidden", any("Claude is waiting for your input" in n for n in notices), notices)
    check("ribbon icon gets a badge while hidden", page.evaluate("document.querySelector('.side-dock-ribbon-action').classList.contains('tt-has-bell')"))
    page.keyboard.press("Control+`")
    time.sleep(0.3)
    check("badge clears when shown", not page.evaluate("document.querySelector('.side-dock-ribbon-action').classList.contains('tt-has-bell')"))

    # duplicate titles get numbered
    page.click(".tt-new-button")
    page.wait_for_function("window.__tt.plugin.dock.instances.length === 3", timeout=6000)
    time.sleep(0.5)
    titles = [x["title"] for x in tabs()]
    check("repeated shell names are numbered", titles.count("bash") == 1 and "bash 2" in titles, titles)
    page.keyboard.type("exit\n")
    time.sleep(0.6)

    # launch profile (Claude Code → types `claude`)
    page.evaluate("window.__tt.run('launch-claude-code')")
    page.wait_for_function("window.__tt.plugin.dock.instances.length >= 3", timeout=6000)
    check("profile types its command at the prompt", wait_text("claude", timeout=6))
    t = tabs()
    check("profile tab is named after the profile", any(x["title"] == "Claude Code" for x in t), t)

    # zoom: Cmd+= / Cmd+0 and Ctrl+wheel
    before = page.evaluate("window.__tt.plugin.dock.active.terminal.options.fontSize")
    page.evaluate("window.__tt.plugin.dock.active.focus()")
    page.keyboard.press("Meta+Equal")
    page.keyboard.press("Meta+Equal")
    after = page.evaluate("window.__tt.plugin.dock.active.terminal.options.fontSize")
    check("⌘= zooms in", after == before + 2, (before, after))
    page.keyboard.press("Meta+0")
    check("⌘0 resets", page.evaluate("window.__tt.plugin.dock.active.terminal.options.fontSize") == before)
    sr = rect(".tt-instance.is-active .xterm-screen")
    page.mouse.move(sr["l"] + 50, sr["t"] + 50)
    page.keyboard.down("Control")
    page.mouse.wheel(0, -100)
    page.keyboard.up("Control")
    time.sleep(0.2)
    check("Ctrl+wheel zooms", page.evaluate("window.__tt.plugin.dock.active.terminal.options.fontSize") == before + 1)
    page.keyboard.press("Meta+0")
    check("zoom is not saved to settings", page.evaluate("window.__tt.plugin.settings.fontSize") == 13)

    # wikilink in output
    page.keyboard.press("Meta+k")
    type_line("echo 'see [[30-08-2026 Log]] here'")
    wait_text("see [[30-08-2026 Log]] here")
    pos = page.evaluate("""() => { const inst = window.__tt.plugin.dock.active; const t = inst.terminal; const buf = t.buffer.active;
        for (let y = 0; y < buf.length; y++) { const s = buf.getLine(y).translateToString(true); const i = s.indexOf('see [['); if (i >= 0 && !s.includes('echo')) {
            const screen = inst.el.querySelector('.xterm-screen').getBoundingClientRect();
            const cw = screen.width / t.cols, ch = screen.height / t.rows; const vy = y - buf.viewportY;
            return { x: screen.left + (i + 8) * cw, y: screen.top + (vy + 0.5) * ch }; } } return null; }""")
    if pos is None:
        print("DEBUG active buffer:", buffer_text()[-600:], tabs())
    page.keyboard.down("Meta")
    page.mouse.move(pos["x"], pos["y"])
    time.sleep(0.3)
    page.mouse.click(pos["x"], pos["y"])
    page.keyboard.up("Meta")
    time.sleep(0.3)
    check("⌘-click on a [[wikilink]] opens the note", "06-JOURNAL/2026/30-08-2026 Log.md" in page.evaluate("window.__tt.app.opened"), page.evaluate("window.__tt.app.opened"))

    # focusFirst toggle behaviour
    page.evaluate("window.__tt.plugin.settings.toggleBehaviour = 'focusFirst'; document.activeElement.blur(); document.body.focus()")
    page.keyboard.press("Control+`")
    time.sleep(0.3)
    check("focusFirst: toggle focuses a visible-but-unfocused panel", page.evaluate("window.__tt.plugin.dock.isShown() && window.__tt.plugin.dock.hasFocus()"))
    page.keyboard.press("Control+`")
    time.sleep(0.2)
    check("…and hides it when focused", not page.evaluate("window.__tt.plugin.dock.isShown()"))
    page.evaluate("window.__tt.plugin.settings.toggleBehaviour = 'hide'")

    # left position
    page.keyboard.press("Control+`")
    page.evaluate("window.__tt.run('move-left')")
    time.sleep(0.3)
    d, r = rect(".toggle-terminal-dock"), rect(".mod-root")
    check("left dock: between the file explorer and the editor", abs(d["r"] - r["l"]) < 1.5 and abs(d["l"] - 295) < 2, (d, r))
    page.screenshot(path=OUT + "/S2-left.png")
    page.evaluate("window.__tt.run('move-bottom')")

    # closing every terminal hides the panel and returns the space
    page.evaluate("window.__tt.plugin.dock.closeAll(false)")
    time.sleep(0.5)
    full = rect(".mod-root")
    check("closing all terminals hides the panel and frees the editor area", not page.evaluate("window.__tt.plugin.dock.isShown()") and page.evaluate("getComputedStyle(document.querySelector('.mod-root')).marginBottom") == "0px", full)
    time.sleep(0.6)
    st = page.evaluate("window.__saved.state")
    check("state.open saved as false", st["open"] is False, st)

    # restart restore: reload with the saved data → panel reopens unfocused
    data = page.evaluate("JSON.stringify({...window.__saved, state: {...window.__saved.state, open: true}})")
    page.goto("http://localhost:8765/?data=" + urllib.parse.quote(data))
    page.wait_for_function("window.__tt && window.__tt.ready", timeout=10000)
    page.wait_for_function("window.__tt.plugin.dock && window.__tt.plugin.dock.isShown()", timeout=5000)
    time.sleep(0.5)
    check("startup restores an open panel without stealing focus", not page.evaluate("window.__tt.plugin.dock.hasFocus()"))

    # a rebound toggle hotkey (Settings → Hotkeys) passes through the terminal
    page.evaluate("window.__tt.app.hotkeyManager.custom['toggle-terminal:toggle'] = [{ modifiers: ['Mod', 'Shift'], key: 'J' }]")
    page.evaluate("window.__tt.plugin.dock.active.focus(); window.__appKeys.length = 0")
    page.keyboard.press("Meta+Shift+j")
    page.keyboard.press("Control+`")
    keys = page.evaluate("window.__appKeys")
    check("rebound plugin hotkey reaches Obsidian from inside the terminal", "Meta+Shift+J" in keys or "Meta+Shift+j" in keys, keys)
    check("the old default is a shell key once rebound", "Ctrl+`" not in keys, keys)
    n = page.evaluate("window.__tt.renderSettings()")
    check("settings tab renders without errors", n > 30, n)
    check("no page errors", not errors, errors[:5])
    b.close()

print("\n%d failure(s)" % len(FAILS))
sys.exit(1 if FAILS else 0)
