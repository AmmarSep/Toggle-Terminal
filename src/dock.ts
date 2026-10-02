import { Menu, Modal, Notice, Platform, setIcon, setTooltip, type App } from "obsidian";

import type ToggleTerminalPlugin from "./main";
import { TerminalInstance, type InstanceHost, type InstanceOptions } from "./instance";
import type { TerminalCommand } from "./keys";
import { clampSize, dockRect, MIN_EDITOR_WIDTH, RESERVED_PROPERTIES } from "./geometry";
import type { DockPosition, TerminalProfile } from "./settings";

/*
 * The terminal panel.
 *
 * 1.x put the terminal in a workspace leaf split below the active note. That
 * leaf belongs to Obsidian's layout tree, so Obsidian rearranges it like any
 * other pane: close the last note above it and its tab group becomes the whole
 * editor area, after which every note you open lands as a tab next to the
 * terminal. Its height was also pinned with a fixed flex-basis that fought
 * Obsidian's own divider and capped how far it could grow.
 *
 * The dock lives outside the layout tree. It is one element positioned over a
 * strip of the editor area that the root split gives up (a max-height for the
 * bottom, a margin for the sides), which keeps it docked whatever happens to
 * the notes, lets it take any height up to the full editor area, and survives
 * layout changes untouched.
 */

class ConfirmModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly message: string,
		private readonly confirmLabel: string,
		private readonly onResult: (confirmed: boolean) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText("Close terminal?");
		this.contentEl.createEl("p", { text: this.message });
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		const confirm = buttons.createEl("button", { text: this.confirmLabel, cls: "mod-warning" });
		confirm.addEventListener("click", () => this.finish(true));
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.finish(false));
		window.setTimeout(() => confirm.focus(), 0);
	}

	override onClose(): void {
		if (!this.resolved) this.onResult(false);
	}

	private finish(confirmed: boolean): void {
		this.resolved = true;
		this.onResult(confirmed);
		this.close();
	}
}

export class TerminalDock implements InstanceHost {
	readonly el: HTMLElement;
	private readonly handleEl: HTMLElement;
	private readonly headerEl: HTMLElement;
	private readonly tabsEl: HTMLElement;
	private readonly bodyEl: HTMLElement;
	private readonly profilesButton: HTMLElement;
	private readonly maximizeButton: HTMLElement;
	private readonly hideButton: HTMLElement;

	private instances: TerminalInstance[] = [];
	private active: TerminalInstance | null = null;
	private shown = false;
	private maximized: boolean;
	private mounted = false;

	private rootEl: HTMLElement | null = null;
	/** Element currently carrying the reservation margin. */
	private reservedEl: HTMLElement | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private layoutFrame = 0;
	private tabsFrame = 0;
	private appliedSize = 0;
	private lastGeometry = "";
	private readonly cleanup: Array<() => void> = [];
	private draggedTab: TerminalInstance | null = null;
	private focusFrame = 0;

	constructor(readonly plugin: ToggleTerminalPlugin) {
		this.maximized = plugin.state.maximized;

		this.el = createDiv({ cls: "toggle-terminal-dock is-hidden" });
		this.handleEl = this.el.createDiv({ cls: "tt-resize-handle", attr: { "aria-hidden": "true" } });

		this.headerEl = this.el.createDiv({ cls: "tt-header" });
		this.tabsEl = this.headerEl.createDiv({ cls: "tt-tabs", attr: { role: "tablist" } });
		this.headerButton(this.headerEl, "plus", "New terminal", "tt-new-button", () => {
			this.createInstance({}, { focus: true });
		});
		this.profilesButton = this.headerButton(this.headerEl, "chevron-down", "Launch profile…", "tt-profiles-button", (event) =>
			this.showLaunchMenu(event),
		);
		const spacer = this.headerEl.createDiv({ cls: "tt-header-spacer" });
		spacer.addEventListener("dblclick", () => this.toggleMaximized());

		const actions = this.headerEl.createDiv({ cls: "tt-actions" });
		this.headerButton(actions, "search", "Find (⌘F / Ctrl+Shift+F)", "", () => this.active?.openFind());
		this.headerButton(actions, "trash-2", "Kill terminal", "", () => {
			if (this.active) void this.closeInstance(this.active, true);
		});
		this.maximizeButton = this.headerButton(actions, "maximize-2", "Maximize panel", "", () => this.toggleMaximized());
		this.hideButton = this.headerButton(actions, "chevron-down", "Hide panel", "", () => this.hide());

		this.bodyEl = this.el.createDiv({ cls: "tt-body" });

		this.handleEl.addEventListener("pointerdown", (event) => this.startResize(event));
		this.handleEl.addEventListener("dblclick", () => this.toggleMaximized());
		this.headerEl.addEventListener("contextmenu", (event) => {
			if (event.target === this.headerEl || event.target === spacer) {
				event.preventDefault();
				this.showPanelMenu(event);
			}
		});
	}

	private headerButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		cls: string,
		onClick: (event: MouseEvent) => void,
	): HTMLElement {
		const button = parent.createDiv({ cls: `clickable-icon tt-header-button ${cls}`.trim(), attr: { role: "button" } });
		setIcon(button, icon);
		setTooltip(button, label);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			onClick(event);
		});
		return button;
	}

	/* ---------------------------------------------------------------- */
	/* Mounting and layout                                              */
	/* ---------------------------------------------------------------- */

	mount(): void {
		if (this.mounted) return;
		this.mounted = true;
		this.plugin.app.workspace.containerEl.appendChild(this.el);

		this.resizeObserver = new ResizeObserver(() => this.scheduleLayout());
		this.resizeObserver.observe(this.plugin.app.workspace.containerEl);
		this.observeRoot();

		const onWindowResize = (): void => this.scheduleLayout();
		window.addEventListener("resize", onWindowResize);
		this.cleanup.push(() => window.removeEventListener("resize", onWindowResize));
		this.relayout();
	}

	unmount(): void {
		if (!this.mounted) return;
		this.mounted = false;
		for (const instance of this.instances.splice(0)) instance.dispose();
		this.active = null;
		if (this.layoutFrame !== 0) window.cancelAnimationFrame(this.layoutFrame);
		if (this.tabsFrame !== 0) window.cancelAnimationFrame(this.tabsFrame);
		this.cancelFocusSoon();
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		for (const fn of this.cleanup.splice(0)) fn();
		this.clearReservation();
		this.el.remove();
	}

	/** Root split's element. Re-read on every layout change: loading a workspace replaces it. */
	private resolveRoot(): HTMLElement | null {
		const workspace = this.plugin.app.workspace;
		const fromApi = (workspace.rootSplit as unknown as { containerEl?: unknown } | null)?.containerEl;
		if (fromApi instanceof HTMLElement && fromApi.isConnected) return fromApi;
		return workspace.containerEl.querySelector<HTMLElement>(".workspace-split.mod-root");
	}

	private observeRoot(): void {
		const root = this.resolveRoot();
		if (root === this.rootEl) return;
		if (this.rootEl) this.resizeObserver?.unobserve(this.rootEl);
		this.rootEl = root;
		if (root) this.resizeObserver?.observe(root);
	}

	/** Called by the plugin on workspace layout-change and css-change. */
	onWorkspaceChanged(): void {
		this.observeRoot();
		this.scheduleLayout();
	}

	scheduleLayout(): void {
		if (this.layoutFrame !== 0) return;
		this.layoutFrame = window.requestAnimationFrame(() => {
			this.layoutFrame = 0;
			this.relayout();
		});
	}

	get position(): DockPosition {
		return this.plugin.settings.position;
	}

	private requestedSize(): number {
		const { state, settings } = this.plugin;
		return this.position === "bottom" ? state.sizeBottom ?? settings.panelHeight : state.sizeSide ?? settings.panelWidth;
	}

	/**
	 * Make room for the panel on the root split, inline and important so it
	 * applies wherever the root sits in the DOM and whatever the theme does.
	 *
	 * Obsidian sizes the root with `height: 100%; width: 100%` and lets it
	 * shrink horizontally (it is a flex item beside the sidebars). So the
	 * bottom strip comes from a max-height, while a side strip comes from a
	 * margin the flex layout takes out of the root's width — with min-width
	 * lifted, or a wide note header would refuse to shrink and push the
	 * sidebar off screen.
	 */
	private reserve(root: HTMLElement, position: DockPosition, size: number): void {
		if (this.reservedEl && this.reservedEl !== root) this.clearReservation();
		const style = root.style;
		for (const property of RESERVED_PROPERTIES) style.removeProperty(property);
		if (position === "bottom") {
			style.setProperty("max-height", `calc(100% - ${size}px)`, "important");
		} else {
			style.setProperty(position === "right" ? "margin-right" : "margin-left", `${size}px`, "important");
			style.setProperty("min-width", "0", "important");
		}
		this.reservedEl = root;

		const body = document.body;
		body.addClass("tt-dock-open");
		for (const candidate of ["bottom", "right", "left"] as const) {
			body.toggleClass(`tt-dock-${candidate}`, candidate === position);
		}
		body.style.setProperty("--tt-dock-size", `${size}px`);
	}

	/**
	 * Pixels the editor area and the panel share: below the root's top edge for
	 * the bottom panel, the row minus ribbons and sidebars for a side panel.
	 * Measured from the parent, so it does not depend on the current reservation.
	 */
	private availableSpace(root: HTMLElement, position: DockPosition): number {
		const parent = root.parentElement;
		if (!parent) {
			const rect = root.getBoundingClientRect();
			return position === "bottom" ? rect.height : rect.width;
		}
		const parentRect = parent.getBoundingClientRect();
		if (position === "bottom") {
			const contentBottom = parentRect.top + parent.clientTop + parent.clientHeight;
			return contentBottom - root.getBoundingClientRect().top;
		}
		let taken = 0;
		for (const child of Array.from(parent.children)) {
			if (child === root || child === this.el || !(child instanceof HTMLElement)) continue;
			const style = getComputedStyle(child);
			if (style.display === "none" || style.position === "absolute" || style.position === "fixed") continue;
			taken += child.getBoundingClientRect().width + parseFloat(style.marginLeft) + parseFloat(style.marginRight);
		}
		return parent.clientWidth - taken;
	}

	private clearReservation(): void {
		const root = this.reservedEl;
		if (root) {
			for (const property of RESERVED_PROPERTIES) root.style.removeProperty(property);
			this.reservedEl = null;
		}
		const body = document.body;
		body.removeClass("tt-dock-open", "tt-dock-bottom", "tt-dock-right", "tt-dock-left");
		body.style.removeProperty("--tt-dock-size");
	}

	/** Height of the editor area's top tab row, measured, 0 if hidden. */
	private headerHeight(root: HTMLElement, rootRect: DOMRect): number {
		let height = 0;
		for (const header of Array.from(root.querySelectorAll<HTMLElement>(".workspace-tab-header-container"))) {
			const rect = header.getBoundingClientRect();
			if (rect.height > 0 && Math.abs(rect.top - rootRect.top) < 4) height = Math.max(height, rect.bottom - rootRect.top);
		}
		return height;
	}

	private relayout(): void {
		if (this.layoutFrame !== 0) {
			window.cancelAnimationFrame(this.layoutFrame);
			this.layoutFrame = 0;
		}
		// Loading a saved workspace layout can rebuild the workspace's children.
		const workspaceEl = this.plugin.app.workspace.containerEl;
		if (this.mounted && this.el.parentElement !== workspaceEl) workspaceEl.appendChild(this.el);

		const root = this.mounted && this.shown ? this.resolveRoot() : null;
		if (!root) {
			this.clearReservation();
			this.el.addClass("is-hidden");
			this.lastGeometry = "";
			return;
		}
		this.observeRoot();

		const position = this.position;
		this.el.removeClass("is-hidden");
		this.el.toggleClass("mod-bottom", position === "bottom");
		this.el.toggleClass("mod-right", position === "right");
		this.el.toggleClass("mod-left", position === "left");
		this.el.toggleClass("is-maximized", this.maximized);

		// Clamp the request to what fits in this window, then reserve it.
		const available = this.availableSpace(root, position);
		const minEditor =
			position === "bottom" ? Math.max(this.headerHeight(root, root.getBoundingClientRect()), 36) : MIN_EDITOR_WIDTH;
		const size = clampSize(position, Math.round(this.requestedSize()), available, minEditor);
		this.reserve(root, position, size);
		const rootRect = root.getBoundingClientRect();
		this.appliedSize = size;

		const header = this.maximized ? this.headerHeight(root, rootRect) : 0;
		const rect = dockRect(position, rootRect, size, this.maximized, header);

		// Viewport → containing block of this absolutely positioned element.
		const container = (this.el.offsetParent as HTMLElement | null) ?? document.body;
		const containerRect = container.getBoundingClientRect();
		const left = rect.left - containerRect.left - container.clientLeft + container.scrollLeft;
		const top = rect.top - containerRect.top - container.clientTop + container.scrollTop;
		const geometry = `${left}|${top}|${rect.width}|${rect.height}`;
		if (geometry !== this.lastGeometry) {
			this.lastGeometry = geometry;
			this.el.style.left = `${left}px`;
			this.el.style.top = `${top}px`;
			this.el.style.width = `${Math.max(0, rect.width)}px`;
			this.el.style.height = `${Math.max(0, rect.height)}px`;
		}

		// Window controls overlap the top corners of a frameless window; the
		// header makes room when the panel reaches them.
		const touchesTop = rect.top <= 1;
		this.el.toggleClass("is-top-left", touchesTop && rect.left <= 1);
		this.el.toggleClass("is-top-right", touchesTop && rect.left + rect.width >= window.innerWidth - 1);

		this.updateHeaderButtons();
		this.active?.scheduleFit();
	}

	private updateHeaderButtons(): void {
		setIcon(this.maximizeButton, this.maximized ? "minimize-2" : "maximize-2");
		setTooltip(this.maximizeButton, this.maximized ? "Restore panel size" : "Maximize panel");
		const hideIcon = this.position === "bottom" ? "chevron-down" : this.position === "right" ? "chevron-right" : "chevron-left";
		setIcon(this.hideButton, hideIcon);
		this.profilesButton.toggleClass("is-hidden", this.plugin.validProfiles().length === 0);
	}

	/* ---------------------------------------------------------------- */
	/* Resizing                                                         */
	/* ---------------------------------------------------------------- */

	private startResize(event: PointerEvent): void {
		if (event.button !== 0 || !this.shown) return;
		// A maximized side panel has no edge to drag; its handle is hidden.
		if (this.maximized && this.position !== "bottom") return;
		event.preventDefault();
		if (this.maximized) {
			// Dragging a maximized panel starts from its full size.
			this.maximized = false;
			this.plugin.state.maximized = false;
			this.setSize(this.el.getBoundingClientRect()[this.position === "bottom" ? "height" : "width"], false);
		}

		const position = this.position;
		const startX = event.clientX;
		const startY = event.clientY;
		const startSize = this.appliedSize;
		const pointerId = event.pointerId;
		const handle = this.handleEl;
		try {
			handle.setPointerCapture(pointerId);
		} catch {
			/* synthetic event */
		}
		document.body.addClass("tt-dock-resizing", position === "bottom" ? "tt-resizing-rows" : "tt-resizing-cols");
		handle.addClass("is-dragging");

		const onMove = (move: PointerEvent): void => {
			const delta =
				position === "bottom" ? startY - move.clientY : position === "right" ? startX - move.clientX : move.clientX - startX;
			this.setSize(startSize + delta, false);
		};
		const onUp = (): void => {
			handle.removeEventListener("pointermove", onMove);
			handle.removeEventListener("pointerup", onUp);
			handle.removeEventListener("pointercancel", onUp);
			try {
				handle.releasePointerCapture(pointerId);
			} catch {
				/* already released */
			}
			document.body.removeClass("tt-dock-resizing", "tt-resizing-rows", "tt-resizing-cols");
			handle.removeClass("is-dragging");
			this.setSize(this.appliedSize, true);
		};
		handle.addEventListener("pointermove", onMove);
		handle.addEventListener("pointerup", onUp);
		handle.addEventListener("pointercancel", onUp);
	}

	/** Set the panel size in px; clamped to the window. */
	setSize(size: number, persist: boolean): void {
		const state = this.plugin.state;
		if (this.position === "bottom") state.sizeBottom = Math.round(size);
		else state.sizeSide = Math.round(size);
		this.relayout();
		// Store what actually fits, so a drag past the edge does not leave a
		// size behind that only applies after the window grows.
		if (this.position === "bottom") state.sizeBottom = this.appliedSize;
		else state.sizeSide = this.appliedSize;
		if (persist) this.plugin.saveStateSoon();
	}

	/* ---------------------------------------------------------------- */
	/* Visibility                                                       */
	/* ---------------------------------------------------------------- */

	isShown(): boolean {
		return this.shown;
	}

	isMaximized(): boolean {
		return this.maximized;
	}

	hasFocus(): boolean {
		const active = document.activeElement;
		return this.shown && active !== null && this.el.contains(active);
	}

	/** Show the panel, starting a terminal if there is none. */
	show(focus: boolean): TerminalInstance {
		const wasShown = this.shown;
		this.shown = true;
		this.relayout();
		const instance = this.active ?? this.createInstance({}, { focus: false });
		if (!wasShown) {
			this.plugin.state.open = true;
			this.plugin.saveStateSoon();
			instance.markSeen();
			this.plugin.updateRibbonBadge();
		}
		instance.scheduleFit();
		if (focus) this.focusSoon(instance);
		return instance;
	}

	/** Focus after the next layout; a later rename or focus request cancels it. */
	private focusSoon(instance: TerminalInstance): void {
		if (this.focusFrame !== 0) window.cancelAnimationFrame(this.focusFrame);
		this.focusFrame = window.requestAnimationFrame(() => {
			this.focusFrame = 0;
			if (this.instances.includes(instance)) instance.focus();
		});
	}

	private cancelFocusSoon(): void {
		if (this.focusFrame !== 0) window.cancelAnimationFrame(this.focusFrame);
		this.focusFrame = 0;
	}

	hide(): void {
		if (!this.shown) return;
		const hadFocus = this.hasFocus();
		this.active?.closeFind();
		this.shown = false;
		this.relayout();
		this.plugin.state.open = false;
		this.plugin.saveStateSoon();
		// Hand focus back to the editor so typing does not vanish into a hidden panel.
		if (hadFocus) this.plugin.focusEditor();
	}

	toggle(): void {
		if (!this.shown) {
			this.show(this.plugin.settings.focusOnReveal);
			return;
		}
		if (this.plugin.settings.toggleBehaviour === "focusFirst" && !this.hasFocus()) {
			this.active?.focus();
			return;
		}
		this.hide();
	}

	toggleMaximized(): void {
		this.setMaximized(!this.maximized, true);
	}

	setMaximized(maximized: boolean, focusTerminal: boolean): void {
		if (!this.shown) this.show(focusTerminal);
		if (this.maximized === maximized) return;
		this.maximized = maximized;
		this.plugin.state.maximized = maximized;
		this.plugin.saveStateSoon();
		this.relayout();
		if (focusTerminal) this.active?.focus();
	}

	/**
	 * Opening a note while maximized brings the editor back into view — without
	 * taking focus from the note that was just opened.
	 */
	onNoteOpened(): void {
		if (this.shown && this.maximized && this.plugin.settings.restoreOnFileOpen) this.setMaximized(false, false);
	}

	setPosition(position: DockPosition): void {
		if (this.plugin.settings.position === position) return;
		const hadFocus = this.hasFocus();
		this.plugin.settings.position = position;
		void this.plugin.saveSettings();
		this.lastGeometry = "";
		this.relayout();
		if (hadFocus) this.active?.focus();
	}

	/* ---------------------------------------------------------------- */
	/* Terminals                                                        */
	/* ---------------------------------------------------------------- */

	getActive(): TerminalInstance | null {
		return this.active;
	}

	getInstances(): readonly TerminalInstance[] {
		return this.instances;
	}

	createInstance(options: InstanceOptions, behaviour: { focus: boolean }): TerminalInstance {
		if (!this.shown) {
			this.shown = true;
			this.plugin.state.open = true;
			this.plugin.saveStateSoon();
			this.relayout();
		}
		const instance = new TerminalInstance(this, options);
		const index = this.active ? this.instances.indexOf(this.active) + 1 : this.instances.length;
		this.instances.splice(index, 0, instance);
		this.active?.setVisible(false);
		this.active = instance;
		instance.start(this.bodyEl);
		this.renderTabs();
		if (behaviour.focus) this.focusSoon(instance);
		return instance;
	}

	activate(instance: TerminalInstance, focus = true): void {
		if (!this.instances.includes(instance)) return;
		if (!this.shown) this.show(false);
		if (this.active !== instance) {
			this.active?.closeFind();
			this.active?.setVisible(false);
			this.active = instance;
			instance.setVisible(true);
			this.renderTabs();
		}
		if (focus) this.focusSoon(instance);
	}

	activateRelative(delta: number): void {
		if (this.instances.length < 2 || !this.active) return;
		const index = this.instances.indexOf(this.active);
		const next = this.instances[(index + delta + this.instances.length) % this.instances.length];
		this.activate(next, true);
	}

	/**
	 * Kill one terminal. Asks first when a program other than the shell is in
	 * the foreground — that is how a running Claude Code session gets lost.
	 */
	async closeInstance(instance: TerminalInstance, confirm: boolean): Promise<boolean> {
		if (confirm && this.plugin.settings.confirmKillRunning && instance.isBusy) {
			const ok = await this.confirm(`"${instance.title}" is still running. Closing the terminal ends it.`, "Close terminal");
			if (!ok) return false;
		}
		const index = this.instances.indexOf(instance);
		if (index < 0) return false;
		this.instances.splice(index, 1);
		instance.dispose();

		if (this.active === instance) {
			this.active = this.instances[Math.min(index, this.instances.length - 1)] ?? null;
			this.active?.setVisible(true);
		}
		if (this.instances.length === 0) {
			// Closing the last terminal closes the panel, as in VS Code.
			const hadFocus = this.hasFocus() || document.activeElement === document.body;
			this.shown = false;
			this.maximized = false;
			this.plugin.state.maximized = false;
			this.plugin.state.open = false;
			this.plugin.saveStateSoon();
			this.relayout();
			if (hadFocus) this.plugin.focusEditor();
		} else if (this.hasFocus() || document.activeElement === document.body) {
			this.active?.focus();
		}
		this.renderTabs();
		this.plugin.updateRibbonBadge();
		return true;
	}

	/** End every session and hide the panel. */
	async closeAll(confirm: boolean): Promise<void> {
		const busy = this.instances.filter((instance) => instance.isBusy);
		if (confirm && this.plugin.settings.confirmKillRunning && busy.length > 0) {
			const names = busy.map((instance) => `"${instance.title}"`).join(", ");
			const ok = await this.confirm(`${names} ${busy.length === 1 ? "is" : "are"} still running. Closing ends every session.`, "Close all");
			if (!ok) return;
		}
		for (const instance of [...this.instances]) await this.closeInstance(instance, false);
	}

	private confirm(message: string, label: string): Promise<boolean> {
		return new Promise((resolve) => new ConfirmModal(this.plugin.app, message, label, resolve).open());
	}

	applySettings(): void {
		for (const instance of this.instances) instance.applySettings();
		this.updateHeaderButtons();
		this.lastGeometry = "";
		this.scheduleLayout();
	}

	/** Any unseen bell or notification, for the ribbon badge. */
	hasUnseenBell(): boolean {
		return this.instances.some((instance) => instance.bell);
	}

	/* ---------------------------------------------------------------- */
	/* InstanceHost                                                     */
	/* ---------------------------------------------------------------- */

	instanceChanged(): void {
		this.scheduleTabs();
		this.plugin.updateRibbonBadge();
	}

	instanceExited(instance: TerminalInstance): void {
		if (this.plugin.settings.onExit === "close") void this.closeInstance(instance, false);
	}

	isOnScreen(instance: TerminalInstance): boolean {
		return this.shown && this.active === instance;
	}

	runPanelCommand(instance: TerminalInstance, command: TerminalCommand): void {
		switch (command) {
			case "newTab":
				this.createInstance({ cwd: instance.currentDirectory() }, { focus: true });
				break;
			case "nextTab":
				this.activateRelative(1);
				break;
			case "previousTab":
				this.activateRelative(-1);
				break;
			case "toggleMaximize":
				this.toggleMaximized();
				break;
			default:
				break;
		}
	}

	notify(instance: TerminalInstance, message: string, kind: "bell" | "message"): void {
		const reveal = (): void => {
			window.focus();
			this.activate(instance, true);
		};
		if (!document.hasFocus() && typeof Notification !== "undefined" && Notification.permission === "granted") {
			try {
				const notification = new Notification(instance.title, {
					body: kind === "bell" ? "Terminal bell" : message,
				});
				notification.onclick = reveal;
				return;
			} catch {
				/* fall back to an in-app notice */
			}
		}
		const notice = new Notice(`${instance.title}: ${kind === "bell" ? "terminal bell" : message}`, 6000);
		notice.noticeEl.addClass("tt-notice");
		notice.noticeEl.addEventListener("click", reveal);
	}

	showContextMenu(instance: TerminalInstance, event: MouseEvent): void {
		const menu = new Menu();
		const mod = Platform.isMacOS ? "⌘" : "Ctrl+Shift+";
		menu.addItem((item) =>
			item
				.setTitle("Copy")
				.setIcon("copy")
				.setDisabled(!instance.hasSelection())
				.onClick(() => void instance.copySelection()),
		);
		menu.addItem((item) =>
			item
				.setTitle("Paste")
				.setIcon("clipboard-paste")
				.onClick(() => void instance.pasteFromClipboard()),
		);
		menu.addItem((item) => item.setTitle("Select all").setIcon("text-select").onClick(() => instance.selectAll()));
		menu.addItem((item) => item.setTitle(`Find…  ${mod}F`).setIcon("search").onClick(() => instance.openFind()));
		menu.addItem((item) => item.setTitle("Clear").setIcon("eraser").onClick(() => instance.clear()));
		menu.addSeparator();
		this.addLaunchItems(menu, instance.currentDirectory());
		menu.addSeparator();
		menu.addItem((item) => item.setTitle("Rename…").setIcon("pencil").onClick(() => this.beginRename(instance)));
		menu.addItem((item) => item.setTitle("Restart session").setIcon("rotate-ccw").onClick(() => instance.restart()));
		menu.addItem((item) =>
			item
				.setTitle("Kill terminal")
				.setIcon("trash-2")
				.onClick(() => void this.closeInstance(instance, true)),
		);
		menu.addSeparator();
		this.addPanelItems(menu);
		menu.showAtMouseEvent(event);
	}

	/* ---------------------------------------------------------------- */
	/* Menus                                                            */
	/* ---------------------------------------------------------------- */

	private addLaunchItems(menu: Menu, cwd: string | undefined): void {
		menu.addItem((item) =>
			item
				.setTitle("New terminal")
				.setIcon("plus")
				.onClick(() => this.createInstance(cwd ? { cwd } : {}, { focus: true })),
		);
		for (const profile of this.plugin.validProfiles()) {
			menu.addItem((item) =>
				item
					.setTitle(`New: ${profile.name}`)
					.setIcon("play")
					.onClick(() => this.plugin.launchProfile(profile)),
			);
		}
	}

	private addPanelItems(menu: Menu): void {
		menu.addItem((item) =>
			item
				.setTitle(this.maximized ? "Restore panel size" : "Maximize panel")
				.setIcon(this.maximized ? "minimize-2" : "maximize-2")
				.onClick(() => this.toggleMaximized()),
		);
		const labels: Record<DockPosition, string> = { bottom: "Move panel to bottom", right: "Move panel to right", left: "Move panel to left" };
		const icons: Record<DockPosition, string> = { bottom: "panel-bottom", right: "panel-right", left: "panel-left" };
		for (const position of ["bottom", "right", "left"] as const) {
			if (position === this.position) continue;
			menu.addItem((item) =>
				item
					.setTitle(labels[position])
					.setIcon(icons[position])
					.onClick(() => this.setPosition(position)),
			);
		}
		menu.addItem((item) => item.setTitle("Hide panel").setIcon("eye-off").onClick(() => this.hide()));
		menu.addItem((item) =>
			item
				.setTitle("Terminal settings")
				.setIcon("settings")
				.onClick(() => this.plugin.openSettings()),
		);
	}

	private showLaunchMenu(event: MouseEvent): void {
		const menu = new Menu();
		this.addLaunchItems(menu, undefined);
		const folder = this.plugin.activeFileFolder();
		if (folder) {
			menu.addItem((item) =>
				item
					.setTitle("New terminal in note's folder")
					.setIcon("folder-open")
					.onClick(() => this.createInstance({ cwd: folder }, { focus: true })),
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Edit launch profiles…")
				.setIcon("settings")
				.onClick(() => this.plugin.openSettings()),
		);
		menu.showAtMouseEvent(event);
	}

	private showPanelMenu(event: MouseEvent): void {
		const menu = new Menu();
		this.addLaunchItems(menu, this.active?.currentDirectory());
		menu.addSeparator();
		this.addPanelItems(menu);
		menu.showAtMouseEvent(event);
	}

	private showTabMenu(instance: TerminalInstance, event: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) => item.setTitle("Rename…").setIcon("pencil").onClick(() => this.beginRename(instance)));
		menu.addItem((item) => item.setTitle("Restart session").setIcon("rotate-ccw").onClick(() => instance.restart()));
		menu.addItem((item) =>
			item
				.setTitle("Duplicate")
				.setIcon("copy-plus")
				.onClick(() => this.createInstance({ cwd: instance.currentDirectory() }, { focus: true })),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Close")
				.setIcon("x")
				.onClick(() => void this.closeInstance(instance, true)),
		);
		if (this.instances.length > 1) {
			menu.addItem((item) =>
				item
					.setTitle("Close others")
					.setIcon("x-square")
					.onClick(async () => {
						for (const other of this.instances.filter((candidate) => candidate !== instance)) {
							if (!(await this.closeInstance(other, true))) break;
						}
					}),
			);
		}
		menu.showAtMouseEvent(event);
	}

	/* ---------------------------------------------------------------- */
	/* Tab strip                                                        */
	/* ---------------------------------------------------------------- */

	private scheduleTabs(): void {
		if (this.tabsFrame !== 0) return;
		this.tabsFrame = window.requestAnimationFrame(() => {
			this.tabsFrame = 0;
			this.renderTabs();
		});
	}

	private renderTabs(): void {
		if (this.tabsEl.querySelector(".tt-tab-rename")) return; // do not clobber an open rename
		this.tabsEl.empty();
		// Two plain shells are both "zsh"; number the repeats so they can be told apart.
		const seen = new Map<string, number>();
		for (const instance of this.instances) {
			const count = (seen.get(instance.title) ?? 0) + 1;
			seen.set(instance.title, count);
			this.renderTab(instance, count > 1 ? `${instance.title} ${count}` : instance.title);
		}
		this.el.toggleClass("has-multiple", this.instances.length > 1);
	}

	private renderTab(instance: TerminalInstance, label: string): void {
		const isActive = instance === this.active;
		const tab = this.tabsEl.createDiv({
			cls: "tt-tab",
			attr: { role: "tab", "aria-selected": String(isActive), draggable: "true", "data-instance": String(instance.id) },
		});
		tab.toggleClass("is-active", isActive);
		tab.toggleClass("is-exited", instance.isExited);
		tab.toggleClass("has-activity", instance.activity && !isActive);
		tab.toggleClass("has-bell", instance.bell);

		const icon = tab.createDiv({ cls: "tt-tab-icon" });
		setIcon(icon, instance.bell ? "bell-ring" : "terminal");
		tab.createDiv({ cls: "tt-tab-title", text: label });

		if (instance.progress) {
			const progress = tab.createDiv({ cls: "tt-tab-progress" });
			const bar = progress.createDiv({ cls: "tt-tab-progress-bar" });
			progress.toggleClass("is-indeterminate", instance.progress.state === 3);
			progress.toggleClass("is-error", instance.progress.state === 2);
			progress.toggleClass("is-paused", instance.progress.state === 4);
			if (instance.progress.state !== 3) bar.style.width = `${instance.progress.value}%`;
		}

		const close = tab.createDiv({ cls: "tt-tab-close clickable-icon", attr: { "aria-label": "Close terminal" } });
		setIcon(close, "x");
		setTooltip(tab, `${label}\n${instance.describe()}`, { placement: "top" });

		close.addEventListener("click", (event) => {
			event.stopPropagation();
			void this.closeInstance(instance, true);
		});
		tab.addEventListener("click", () => this.activate(instance, true));
		tab.addEventListener("auxclick", (event) => {
			if (event.button === 1) {
				event.preventDefault();
				void this.closeInstance(instance, true);
			}
		});
		tab.addEventListener("dblclick", (event) => {
			if (event.target !== close) this.beginRename(instance);
		});
		tab.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.showTabMenu(instance, event);
		});

		tab.addEventListener("dragstart", (event) => {
			this.draggedTab = instance;
			event.dataTransfer?.setData("text/x-toggle-terminal-tab", String(instance.id));
			if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
			tab.addClass("is-dragging");
		});
		tab.addEventListener("dragend", () => {
			this.draggedTab = null;
			this.renderTabs();
		});
		tab.addEventListener("dragover", (event) => {
			if (!this.draggedTab || this.draggedTab === instance) return;
			event.preventDefault();
			const rect = tab.getBoundingClientRect();
			const after = event.clientX > rect.left + rect.width / 2;
			tab.toggleClass("is-drop-before", !after);
			tab.toggleClass("is-drop-after", after);
		});
		tab.addEventListener("dragleave", () => tab.removeClass("is-drop-before", "is-drop-after"));
		tab.addEventListener("drop", (event) => {
			const dragged = this.draggedTab;
			if (!dragged || dragged === instance) return;
			event.preventDefault();
			const after = tab.hasClass("is-drop-after");
			this.instances.splice(this.instances.indexOf(dragged), 1);
			this.instances.splice(this.instances.indexOf(instance) + (after ? 1 : 0), 0, dragged);
			this.draggedTab = null;
			this.renderTabs();
		});

		if (isActive) window.requestAnimationFrame(() => tab.scrollIntoView({ block: "nearest", inline: "nearest" }));
	}

	/** Inline rename in the tab. Empty input restores the automatic title. */
	beginRename(instance: TerminalInstance): void {
		this.activate(instance, false);
		// The click that started this double-click queued a terminal focus.
		this.cancelFocusSoon();
		this.renderTabs();
		const tab = this.tabsEl.querySelector<HTMLElement>(`[data-instance="${instance.id}"]`);
		const titleEl = tab?.querySelector<HTMLElement>(".tt-tab-title");
		if (!tab || !titleEl) return;

		const input = createEl("input", { cls: "tt-tab-rename", attr: { type: "text", spellcheck: "false" } });
		input.value = instance.customTitle ?? instance.title;
		titleEl.replaceWith(input);
		tab.setAttr("draggable", "false");

		let done = false;
		const finish = (commit: boolean): void => {
			if (done) return;
			done = true;
			if (commit) {
				const value = input.value.trim();
				instance.customTitle = value.length > 0 ? value : null;
			}
			input.remove();
			this.renderTabs();
			instance.focus();
		};
		input.addEventListener("keydown", (event) => {
			event.stopPropagation();
			if (event.key === "Enter") finish(true);
			else if (event.key === "Escape") finish(false);
		});
		input.addEventListener("blur", () => finish(true));
		input.addEventListener("click", (event) => event.stopPropagation());
		input.focus();
		input.select();
	}

	/** Launch a profile into a new tab. */
	launch(profile: TerminalProfile, command: string, cwd?: string): TerminalInstance {
		return this.createInstance({ name: profile.name, command, ...(cwd ? { cwd } : {}) }, { focus: true });
	}
}
