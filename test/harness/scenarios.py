"""Scenario checks for the dock, run against the harness server.

    node test/harness/build.mjs && HARNESS_PATH=/usr/bin:/bin node test/harness/server.mjs &
    python3 test/harness/scenarios.py     # needs: pip install playwright && playwright install chromium
"""
from playwright.sync_api import sync_playwright
import time, json, sys, os
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".out")
os.makedirs(OUT, exist_ok=True)

FAILS = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (("  -- " + str(detail)) if detail and not cond else ""))
    if not cond:
        FAILS.append(name)

with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"])
    page = b.new_page(viewport={"width": 1400, "height": 860}, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console.error: " + m.text) if m.type == "error" else None)
    page.goto("http://localhost:8765/")
    page.wait_for_function("window.__tt && window.__tt.ready", timeout=10000)

    def rect(sel):
        return page.evaluate("s => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? {l: r.left, t: r.top, w: r.width, h: r.height, b: r.bottom, r: r.right} : null }", sel)
    def ws():
        return rect(".workspace")
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
    def shot(name):
        page.screenshot(path=f"{OUT}/{name}.png")

    check("panel hidden at startup (data.json had no open panel)", page.evaluate("document.querySelector('.toggle-terminal-dock').classList.contains('is-hidden')"))
    full_root = rect(".mod-root")

    # A. open with the toggle hotkey
    page.keyboard.press("Control+`")
    page.wait_for_function("window.__tt.plugin.dock.active && window.__tt.plugin.dock.active.session && window.__tt.plugin.dock.active.hasOutput", timeout=8000)
    time.sleep(0.3)
    d, r = rect(".toggle-terminal-dock"), rect(".mod-root")
    check("dock spans the editor area width", abs(d["l"] - r["l"]) < 1 and abs(d["w"] - r["w"]) < 1, (d, r))
    check("dock sits directly below the editor", abs(d["t"] - r["b"]) < 1.5, (d, r))
    check("dock height = 260 from the 1.x panelHeight", abs(d["h"] - 260) < 1.5, d)
    check("editor shrank by the dock height", abs((full_root["h"] - r["h"]) - 260) < 1.5, (full_root, r))
    check("terminal focused on reveal", page.evaluate("window.__tt.plugin.dock.hasFocus()"))
    shot("A-open")

    # B. real shell I/O
    type_line("echo hello-$((40+2))")
    check("shell runs commands", wait_text("hello-42"))

    # C. close every note / replace the root: the dock must stay docked, never become a tab
    page.evaluate("""() => {
        const root = document.querySelector('.mod-root');
        root.innerHTML = '<div class="workspace-tabs"><div class="workspace-tab-header-container"><div class="workspace-tab-header is-active">New tab</div></div><div class="workspace-tab-container"><p style="color:#888">No file is open</p></div></div>';
        window.__tt.app.trigger('layout-change');
    }""")
    time.sleep(0.3)
    d, r = rect(".toggle-terminal-dock"), rect(".mod-root")
    check("after closing all notes: still docked at bottom", abs(d["t"] - r["b"]) < 1.5 and abs(d["h"] - 260) < 1.5, (d, r))
    check("terminal is not inside any tab group", page.evaluate("!document.querySelector('.workspace-tabs .toggle-terminal-dock, .workspace-tabs .tt-instance')"))
    shot("C-notes-closed")
    page.evaluate("""() => {
        const old = document.querySelector('.mod-root');
        const fresh = old.cloneNode(true);
        fresh.removeAttribute('style');
        old.replaceWith(fresh);
        window.__tt.app.trigger('layout-change');
    }""")
    time.sleep(0.3)
    d, r = rect(".toggle-terminal-dock"), rect(".mod-root")
    check("root split replaced (workspace layout loaded): reservation re-applied", abs(d["t"] - r["b"]) < 1.5 and abs(r["h"] - (full_root["h"] - 260)) < 1.5, (d, r))
    check("session survived layout changes", "hello-42" in buffer_text())

    # D. drag the divider all the way up: no artificial cap
    handle = rect(".tt-resize-handle")
    page.mouse.move(handle["l"] + 200, handle["t"] + 4)
    page.mouse.down()
    for y in range(int(handle["t"]), 0, -40):
        page.mouse.move(handle["l"] + 200, y)
    page.mouse.move(handle["l"] + 200, 2)
    page.mouse.up()
    time.sleep(0.3)
    d, r, w = rect(".toggle-terminal-dock"), rect(".mod-root"), ws()
    check("drag up: panel grows to the full editor height (only the tab row kept)", abs(r["h"] - 40) < 1.5 and abs(d["b"] - w["b"]) < 1.5, (d, r))
    shot("D-dragged-to-top")
    tall = d["h"]
    page.mouse.move(handle["l"] + 200, d["t"] + 3)
    page.mouse.down()
    page.mouse.move(handle["l"] + 200, 300, steps=8)
    page.mouse.move(handle["l"] + 200, 520, steps=8)
    page.mouse.up()
    time.sleep(0.3)
    d = rect(".toggle-terminal-dock")
    check("drag down: panel follows the pointer (grab offset kept)", abs(d["t"] - 517) < 1.5, d)
    time.sleep(0.6)
    saved = page.evaluate("window.__saved && window.__saved.state")
    check("dragged size persisted to data.json", saved and abs(saved["sizeBottom"] - round(d["h"])) <= 1, saved)
    check("pty was resized to the new rows", page.evaluate("window.__resizeLog.length") >= 3)

    # E. maximize and restore
    page.click(".tt-actions .clickable-icon:nth-child(3)")
    time.sleep(0.3)
    d, r, w = rect(".toggle-terminal-dock"), rect(".mod-root"), ws()
    check("maximize: covers the editor area below the tab row", abs(d["t"] - (r["t"] + 40)) < 1.5 and abs(d["b"] - w["b"]) < 1.5 and abs(d["w"] - r["w"]) < 1.5, (d, r))
    shot("E-maximized")
    page.evaluate("window.__tt.app.trigger('file-open')")
    time.sleep(0.2)
    d = rect(".toggle-terminal-dock")
    check("opening a note restores the size", abs(d["t"] - 517) < 1.5, d)
    page.dblclick(".tt-header-spacer")
    time.sleep(0.2)
    check("double-click header maximizes", page.evaluate("window.__tt.plugin.dock.isMaximized()"))
    page.keyboard.press("Meta+Shift+Enter") if False else None
    page.evaluate("window.__tt.plugin.dock.active.focus()")
    page.keyboard.press("Meta+Shift+Enter")
    time.sleep(0.2)
    check("⌘⇧Enter toggles maximize from inside the terminal", not page.evaluate("window.__tt.plugin.dock.isMaximized()"))

    # F. tabs
    page.click(".tt-new-button")
    page.wait_for_function("window.__tt.plugin.dock.instances.length === 2 && window.__tt.plugin.dock.active.hasOutput", timeout=6000)
    time.sleep(0.3)
    type_line("echo second-tab")
    check("second terminal is independent", wait_text("second-tab") and "hello-42" not in buffer_text())
    check("two tabs rendered", page.evaluate("document.querySelectorAll('.tt-tab').length") == 2)
    shot("F-two-tabs")
    page.click(".tt-tab:nth-child(1)")
    time.sleep(0.2)
    check("switching back shows the first session intact", "hello-42" in buffer_text())
    page.keyboard.press("Control+Tab")
    time.sleep(0.2)
    check("Ctrl+Tab cycles terminals", "second-tab" in buffer_text())
    page.hover(".tt-tab:nth-child(2)")
    page.click(".tt-tab:nth-child(2) .tt-tab-close")
    time.sleep(0.3)
    check("closing a tab leaves the other", page.evaluate("window.__tt.plugin.dock.instances.length") == 1 and "hello-42" in buffer_text())

    # G. keyboard routing
    page.evaluate("window.__tt.plugin.dock.active.focus(); window.__appKeys.length = 0")
    page.keyboard.press("Meta+p")
    page.keyboard.press("x")
    page.keyboard.press("Control+r")
    keys = page.evaluate("window.__appKeys")
    check("⌘P reaches Obsidian (command palette)", "Meta+p" in keys, keys)
    check("plain keys and Ctrl+R stay in the shell", "x" not in keys and "Ctrl+r" not in keys, keys)
    page.keyboard.press("Control+c")
    page.keyboard.press("Meta+k")
    time.sleep(0.2)
    check("⌘K clears the terminal", "hello-42" not in buffer_text())

    # H. Shift+Enter sends ESC CR (Claude Code newline)
    type_line("cat -v")
    time.sleep(0.3)
    page.keyboard.press("Shift+Enter")
    time.sleep(0.3)
    check("Shift+Enter sends ESC+Enter", wait_text("^["), buffer_text()[-200:])
    page.keyboard.press("Control+c")

    # I. hide keeps the session; root gets its space back
    type_line("export MARK=kept-$((6*7))")
    page.keyboard.press("Control+`")
    time.sleep(0.3)
    r = rect(".mod-root")
    check("hide: panel gone, editor back to full height", page.evaluate("document.querySelector('.toggle-terminal-dock').classList.contains('is-hidden')") and abs(r["h"] - full_root["h"]) < 1.5, r)
    page.keyboard.press("Control+`")
    time.sleep(0.4)
    type_line("echo $MARK")
    check("show again: same shell session (state survived)", wait_text("kept-42"))

    # J. find
    page.keyboard.press("Meta+f")
    time.sleep(0.2)
    page.keyboard.type("kept")
    time.sleep(0.4)
    count = page.evaluate("document.querySelector('.tt-instance.is-active .tt-find-count')?.textContent")
    check("find bar finds matches", count is not None and "of" in count, count)
    shot("J-find")
    page.keyboard.press("Escape")
    time.sleep(0.1)
    check("Escape closes find and refocuses terminal", page.evaluate("document.querySelector('.tt-find').classList.contains('is-hidden') && window.__tt.plugin.dock.hasFocus()"))

    # K. vault links in output
    page.keyboard.press("Meta+k")
    type_line("printf 'Update(%s) done\\n' '06-JOURNAL/2026/30-08-2026 Log.md:3'")
    wait_text("Update(06-JOURNAL")
    pos = page.evaluate("""() => { const inst = window.__tt.plugin.dock.active; const t = inst.terminal; const buf = t.buffer.active;
        for (let y = 0; y < buf.length; y++) { const s = buf.getLine(y).translateToString(true); const i = s.indexOf('Update(06-'); if (i >= 0 && !s.includes('printf')) {
            const screen = inst.el.querySelector('.xterm-screen').getBoundingClientRect();
            const cw = screen.width / t.cols, ch = screen.height / t.rows; const vy = y - buf.viewportY;
            return { x: screen.left + (i + 12) * cw, y: screen.top + (vy + 0.5) * ch }; } } return null; }""")
    if pos:
        page.mouse.move(pos["x"], pos["y"])
        time.sleep(0.3)
        page.mouse.click(pos["x"], pos["y"])
        time.sleep(0.2)
        check("plain click on a note path does nothing (⌘-click required)", len(page.evaluate("window.__tt.app.opened")) == 0)
        page.keyboard.down("Meta")
        page.mouse.move(pos["x"] + 2, pos["y"])
        time.sleep(0.3)
        page.mouse.click(pos["x"] + 2, pos["y"])
        page.keyboard.up("Meta")
        time.sleep(0.3)
        opened = page.evaluate("window.__tt.app.opened")
        check("⌘-click on a note path opens it at the line", opened == ["06-JOURNAL/2026/30-08-2026 Log.md#2"], opened)
    else:
        check("link line located", False)

    # L. context menu
    sr = rect(".tt-instance.is-active .xterm-screen")
    page.mouse.click(sr["l"] + 100, sr["t"] + 40, button="right")
    time.sleep(0.2)
    items = page.evaluate("[...document.querySelectorAll('.menu .menu-item-title')].map(e => e.textContent)")
    check("right-click shows the terminal menu", "Paste" in items and "Kill terminal" in items and any(i.startswith("Move panel") for i in items), items)
    shot("L-context-menu")
    page.mouse.click(5, 5)

    # M. move to the right
    page.evaluate("window.__tt.run('move-right')")
    time.sleep(0.3)
    d, r = rect(".toggle-terminal-dock"), rect(".mod-root")
    check("right dock: beside the editor, full height", abs(d["l"] - r["r"]) < 1.5 and abs(d["t"] - r["t"]) < 1.5 and abs(d["h"] - r["h"]) < 1.5 and abs(d["w"] - 520) < 1.5, (d, r))
    shot("M-right")
    page.evaluate("window.__tt.run('move-bottom')")
    time.sleep(0.3)
    d, r = rect(".toggle-terminal-dock"), rect(".mod-root")
    check("back to bottom keeps the dragged height", abs(d["t"] - r["b"]) < 1.5 and abs(d["t"] - 517) < 1.5, (d, r))

    # N. window shrinks: the panel is clamped, never off screen
    page.set_viewport_size({"width": 1100, "height": 500})
    time.sleep(0.4)
    d, w, r = rect(".toggle-terminal-dock"), ws(), rect(".mod-root")
    check("small window: panel clamped inside the workspace", d["b"] <= w["b"] + 1 and r["h"] >= 39, (d, w, r))
    page.set_viewport_size({"width": 1400, "height": 860})
    time.sleep(0.4)

    # O. kill confirmation when a program is running
    page.evaluate("window.__tt.plugin.dock.active.focus()")
    type_line("sleep 30")
    time.sleep(0.8)
    page.click(".tt-actions .clickable-icon:nth-child(2)")
    time.sleep(0.3)
    has_modal = page.evaluate("!!document.querySelector('.modal-container')")
    check("killing a running program asks first", has_modal)
    if has_modal:
        shot("O-confirm")
        page.click(".modal-button-container button:nth-child(2)")
        time.sleep(0.2)
        check("cancel keeps the terminal", page.evaluate("window.__tt.plugin.dock.instances.length") == 1)
    page.evaluate("window.__tt.plugin.dock.active.focus()")
    page.keyboard.press("Control+c")

    # P. exit and restart
    type_line("exit")
    check("exit shows the restart hint", wait_text("process exited"))
    page.keyboard.press("Enter")
    page.wait_for_function("window.__tt.plugin.dock.active.hasOutput && !window.__tt.plugin.dock.active.exited", timeout=6000)
    check("Enter restarts the shell", True)

    # Q. send selection from a note (markdown stripped, not executed)
    page.evaluate("window.__tt.plugin.sendToTerminal('```bash\\n$ echo from-note\\n```', false)")
    time.sleep(0.8)
    txt = buffer_text()
    check("send selection pastes without running", "echo from-note" in txt and "\nfrom-note" not in txt, txt[-300:])
    page.evaluate("window.__tt.plugin.dock.active.focus()")
    page.keyboard.press("Enter")
    check("…and Enter runs it", wait_text("\nfrom-note"))
    shot("Q-final")

    check("no page errors", not errors, errors[:5])
    b.close()

print("\n%d failure(s)" % len(FAILS))
sys.exit(1 if FAILS else 0)
