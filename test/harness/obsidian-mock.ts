/*
 * Browser stand-in for the parts of the "obsidian" module Toggle Terminal uses,
 * plus Obsidian's DOM helper methods. Good enough to mount the real plugin
 * code in Chromium against a DOM shaped like Obsidian's workspace.
 */

/* ------------------------------ DOM helpers ------------------------------ */

type DomInfo = { cls?: string | string[]; text?: string; attr?: Record<string, string | number | boolean>; type?: string };

function applyInfo(el: HTMLElement, info?: DomInfo | string): void {
	if (!info) return;
	if (typeof info === "string") {
		el.className = info;
		return;
	}
	if (info.cls) el.className = Array.isArray(info.cls) ? info.cls.join(" ") : info.cls;
	if (info.text !== undefined) el.textContent = info.text;
	if (info.attr) for (const [k, v] of Object.entries(info.attr)) el.setAttribute(k, String(v));
	if (info.type) el.setAttribute("type", info.type);
}

const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
proto.createEl = function (this: HTMLElement, tag: string, info?: DomInfo | string): HTMLElement {
	const el = document.createElement(tag);
	applyInfo(el, info);
	this.appendChild(el);
	return el;
};
proto.createDiv = function (this: HTMLElement, info?: DomInfo | string): HTMLElement {
	return (this as unknown as { createEl(t: string, i?: DomInfo | string): HTMLElement }).createEl("div", info);
};
proto.createSpan = function (this: HTMLElement, info?: DomInfo | string): HTMLElement {
	return (this as unknown as { createEl(t: string, i?: DomInfo | string): HTMLElement }).createEl("span", info);
};
proto.addClass = function (this: HTMLElement, ...classes: string[]): void {
	this.classList.add(...classes.flatMap((c) => c.split(" ").filter(Boolean)));
};
proto.removeClass = function (this: HTMLElement, ...classes: string[]): void {
	this.classList.remove(...classes.flatMap((c) => c.split(" ").filter(Boolean)));
};
proto.toggleClass = function (this: HTMLElement, classes: string | string[], value: boolean): void {
	for (const c of Array.isArray(classes) ? classes : [classes]) this.classList.toggle(c, value);
};
proto.hasClass = function (this: HTMLElement, cls: string): boolean {
	return this.classList.contains(cls);
};
proto.setText = function (this: HTMLElement, text: string): void {
	this.textContent = text;
};
proto.appendText = function (this: HTMLElement, text: string): void {
	this.appendChild(document.createTextNode(text));
};
proto.setAttr = function (this: HTMLElement, name: string, value: string | number | boolean | null): void {
	if (value === null) this.removeAttribute(name);
	else this.setAttribute(name, String(value));
};
proto.empty = function (this: HTMLElement): void {
	while (this.firstChild) this.removeChild(this.firstChild);
};
proto.isShown = function (this: HTMLElement): boolean {
	return this.offsetParent !== null;
};
const g = globalThis as unknown as Record<string, unknown>;
g.createEl = (tag: string, info?: DomInfo | string): HTMLElement => {
	const el = document.createElement(tag);
	applyInfo(el, info);
	return el;
};
g.createDiv = (info?: DomInfo | string): HTMLElement => (g.createEl as (t: string, i?: DomInfo | string) => HTMLElement)("div", info);
g.createSpan = (info?: DomInfo | string): HTMLElement => (g.createEl as (t: string, i?: DomInfo | string) => HTMLElement)("span", info);

/* -------------------------------- Platform -------------------------------- */

export const Platform = {
	isDesktopApp: true,
	isDesktop: true,
	isMobile: false,
	isMacOS: true,
	isWin: false,
	isLinux: false,
};

export const apiVersion = "1.10.0-harness";

/* --------------------------------- Icons ---------------------------------- */

export function setIcon(el: HTMLElement, icon: string): void {
	el.querySelector("svg")?.remove();
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("class", `svg-icon lucide-${icon}`);
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("data-icon", icon);
	const glyphs: Record<string, string> = {
		plus: "M12 5v14M5 12h14",
		"chevron-down": "M6 9l6 6 6-6",
		"chevron-right": "M9 6l6 6-6 6",
		"chevron-left": "M15 6l-6 6 6 6",
		x: "M18 6 6 18M6 6l12 12",
		search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5",
		"trash-2": "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14",
		"maximize-2": "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
		"minimize-2": "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
		terminal: "M4 17l6-6-6-6M12 19h8",
		"bell-ring": "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9",
		"arrow-up": "M12 19V5M5 12l7-7 7 7",
		"arrow-down": "M12 5v14M19 12l-7 7-7-7",
	};
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", glyphs[icon] ?? "M4 4h16v16H4z");
	path.setAttribute("fill", "none");
	path.setAttribute("stroke", "currentColor");
	path.setAttribute("stroke-width", "2");
	path.setAttribute("stroke-linecap", "round");
	path.setAttribute("stroke-linejoin", "round");
	svg.appendChild(path);
	el.prepend(svg);
}

export function setTooltip(el: HTMLElement, tooltip: string): void {
	el.setAttribute("aria-label", tooltip);
}

export function addIcon(): void {}
export function getIconIds(): string[] {
	return ["lucide-panel-bottom"];
}

export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

export function debounce<T extends unknown[]>(fn: (...args: T) => void, timeout = 0): (...args: T) => void {
	let timer = 0;
	return (...args: T) => {
		window.clearTimeout(timer);
		timer = window.setTimeout(() => fn(...args), timeout);
	};
}

/* --------------------------------- Keymap --------------------------------- */

export class Keymap {
	static isModifier(evt: MouseEvent | KeyboardEvent, modifier: string): boolean {
		if (modifier === "Mod") return Platform.isMacOS ? evt.metaKey : evt.ctrlKey;
		if (modifier === "Shift") return evt.shiftKey;
		if (modifier === "Alt") return evt.altKey;
		if (modifier === "Ctrl") return evt.ctrlKey;
		if (modifier === "Meta") return evt.metaKey;
		return false;
	}
	static isModEvent(evt?: MouseEvent | KeyboardEvent | null): boolean | string {
		return evt ? Keymap.isModifier(evt, "Mod") ? "tab" : false : false;
	}
}

/* ------------------------------ Files & vault ----------------------------- */

export class TAbstractFile {
	constructor(
		public path: string,
		public parent: TFolder | null,
	) {}
	get name(): string {
		return this.path.split("/").pop() ?? this.path;
	}
}
export class TFile extends TAbstractFile {
	get basename(): string {
		return this.name.replace(/\.[^.]+$/, "");
	}
	get extension(): string {
		return this.name.split(".").pop() ?? "";
	}
}
export class TFolder extends TAbstractFile {}

export class FileSystemAdapter {
	constructor(private readonly base: string) {}
	getBasePath(): string {
		return this.base;
	}
}

/* --------------------------------- Notice --------------------------------- */

export class Notice {
	noticeEl: HTMLElement;
	constructor(message: string, duration = 4000) {
		let container = document.querySelector<HTMLElement>(".notice-container");
		if (!container) {
			container = document.body.createDiv({ cls: "notice-container" });
		}
		this.noticeEl = container.createDiv({ cls: "notice", text: message });
		(window as unknown as { __notices: string[] }).__notices.push(message);
		window.setTimeout(() => this.noticeEl.remove(), duration);
	}
	setMessage(message: string): this {
		this.noticeEl.textContent = message;
		return this;
	}
	hide(): void {
		this.noticeEl.remove();
	}
}
(window as unknown as { __notices: string[] }).__notices = [];

/* ---------------------------------- Menu ---------------------------------- */

export class MenuItem {
	el: HTMLElement;
	private handler: ((evt: MouseEvent) => unknown) | null = null;
	constructor(parent: HTMLElement) {
		this.el = parent.createDiv({ cls: "menu-item" });
		this.el.addEventListener("click", (evt) => {
			if (this.el.classList.contains("is-disabled")) return;
			document.querySelector(".menu")?.remove();
			this.handler?.(evt);
		});
	}
	setTitle(title: string): this {
		this.el.createDiv({ cls: "menu-item-title", text: title });
		return this;
	}
	setIcon(icon: string): this {
		const iconEl = this.el.createDiv({ cls: "menu-item-icon" });
		setIcon(iconEl, icon);
		this.el.prepend(iconEl);
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.el.classList.toggle("is-disabled", disabled);
		return this;
	}
	setChecked(): this {
		return this;
	}
	setSection(): this {
		return this;
	}
	onClick(handler: (evt: MouseEvent) => unknown): this {
		this.handler = handler;
		return this;
	}
}

export class Menu {
	private readonly el: HTMLElement;
	constructor() {
		document.querySelector(".menu")?.remove();
		this.el = createDiv({ cls: "menu" });
	}
	addItem(cb: (item: MenuItem) => unknown): this {
		cb(new MenuItem(this.el));
		return this;
	}
	addSeparator(): this {
		this.el.createDiv({ cls: "menu-separator" });
		return this;
	}
	showAtMouseEvent(evt: MouseEvent): this {
		return this.showAtPosition({ x: evt.clientX, y: evt.clientY });
	}
	showAtPosition(pos: { x: number; y: number }): this {
		document.body.appendChild(this.el);
		this.el.style.left = `${Math.min(pos.x, window.innerWidth - 240)}px`;
		this.el.style.top = `${Math.min(pos.y, window.innerHeight - this.el.offsetHeight - 8)}px`;
		window.setTimeout(() => {
			const close = (e: MouseEvent): void => {
				if (!this.el.contains(e.target as Node)) {
					this.el.remove();
					document.removeEventListener("mousedown", close, true);
				}
			};
			document.addEventListener("mousedown", close, true);
		}, 0);
		return this;
	}
	hide(): void {
		this.el.remove();
	}
	onHide(): void {}
}

/* ---------------------------------- Modal --------------------------------- */

export class Modal {
	containerEl: HTMLElement;
	modalEl: HTMLElement;
	titleEl: HTMLElement;
	contentEl: HTMLElement;
	constructor(public app: unknown) {
		this.containerEl = createDiv({ cls: "modal-container" });
		this.modalEl = this.containerEl.createDiv({ cls: "modal" });
		this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
		this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
	}
	open(): void {
		document.body.appendChild(this.containerEl);
		this.onOpen();
	}
	close(): void {
		this.containerEl.remove();
		this.onClose();
	}
	onOpen(): void {}
	onClose(): void {}
}

/* ---------------------------- Settings widgets ---------------------------- */

export class PluginSettingTab {
	containerEl: HTMLElement = createDiv();
	constructor(
		public app: unknown,
		public plugin: unknown,
	) {}
	display(): void {}
}

class Chain {
	[key: string]: unknown;
	constructor() {
		const proxy: Chain = new Proxy(this, {
			get: (target, prop) => {
				if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
				return () => proxy;
			},
		});
		return proxy;
	}
}

export class Setting {
	settingEl: HTMLElement;
	constructor(containerEl: HTMLElement) {
		this.settingEl = containerEl.createDiv({ cls: "setting-item" });
	}
	setName(): this {
		return this;
	}
	setDesc(): this {
		return this;
	}
	setHeading(): this {
		return this;
	}
	private widget(cb: (c: Chain) => unknown): this {
		const chain = new Chain();
		(chain as Record<string, unknown>).inputEl = createEl("input");
		cb(chain);
		return this;
	}
	addText(cb: (c: never) => unknown): this {
		return this.widget(cb as (c: Chain) => unknown);
	}
	addTextArea(cb: (c: never) => unknown): this {
		return this.widget(cb as (c: Chain) => unknown);
	}
	addToggle(cb: (c: never) => unknown): this {
		return this.widget(cb as (c: Chain) => unknown);
	}
	addDropdown(cb: (c: never) => unknown): this {
		return this.widget(cb as (c: Chain) => unknown);
	}
	addSlider(cb: (c: never) => unknown): this {
		return this.widget(cb as (c: Chain) => unknown);
	}
	addButton(cb: (c: never) => unknown): this {
		return this.widget(cb as (c: Chain) => unknown);
	}
	addExtraButton(cb: (c: never) => unknown): this {
		return this.widget(cb as (c: Chain) => unknown);
	}
}

/* ------------------------------ Views & leaves ---------------------------- */

export class ItemView {
	containerEl: HTMLElement = createDiv();
	contentEl: HTMLElement = this.containerEl.createDiv();
	navigation = true;
	constructor(public leaf: unknown) {}
}

export class MarkdownView {}

/* --------------------------------- Plugin --------------------------------- */

export interface HarnessCommand {
	id: string;
	name: string;
	callback?: () => unknown;
	checkCallback?: (checking: boolean) => boolean | void;
	editorCallback?: (editor: unknown) => unknown;
	hotkeys?: unknown[];
}

export class Plugin {
	commands = new Map<string, HarnessCommand>();
	private data: unknown;
	constructor(
		public app: HarnessApp,
		public manifest: { id: string; version: string; dir: string },
		data: unknown,
	) {
		this.data = data;
	}
	async loadData(): Promise<unknown> {
		return JSON.parse(JSON.stringify(this.data ?? null));
	}
	async saveData(data: unknown): Promise<void> {
		this.data = JSON.parse(JSON.stringify(data));
		(window as unknown as { __saved: unknown }).__saved = this.data;
	}
	/** Like Obsidian: the command object's id and name are prefixed in place. */
	addCommand(command: HarnessCommand): HarnessCommand {
		command.id = `${this.manifest.id}:${command.id}`;
		command.name = `Toggle Terminal: ${command.name}`;
		this.commands.set(command.id, command);
		return command;
	}
	removeCommand(id: string): void {
		this.commands.delete(`${this.manifest.id}:${id}`);
	}
	addRibbonIcon(icon: string, title: string, cb: (evt: MouseEvent) => unknown): HTMLElement {
		const ribbon = document.querySelector<HTMLElement>(".workspace-ribbon.mod-left") ?? document.body;
		const el = ribbon.createDiv({ cls: "side-dock-ribbon-action clickable-icon", attr: { "aria-label": title } });
		setIcon(el, icon);
		el.addEventListener("click", cb);
		return el;
	}
	addSettingTab(): void {}
	registerView(): void {}
	registerEvent(): void {}
	registerDomEvent(el: HTMLElement, type: string, cb: (evt: Event) => unknown): void {
		el.addEventListener(type, cb);
	}
	register(): void {}
}

/* ----------------------------------- App ---------------------------------- */

type Listener = (...args: unknown[]) => unknown;

export interface HarnessApp {
	workspace: Record<string, unknown>;
	vault: Record<string, unknown>;
	metadataCache: Record<string, unknown>;
	hotkeyManager: Record<string, unknown>;
	dragManager: { draggable: unknown };
}

export function createApp(vaultBase: string, files: string[]): HarnessApp & { trigger(name: string, ...args: unknown[]): void; opened: string[] } {
	const listeners = new Map<string, Listener[]>();
	const folders = new Map<string, TFolder>();
	const folderFor = (path: string): TFolder => {
		const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/";
		let folder = folders.get(dir);
		if (!folder) {
			folder = new TFolder(dir, null);
			folders.set(dir, folder);
		}
		return folder;
	};
	const fileMap = new Map<string, TFile>(files.map((p) => [p, new TFile(p, folderFor(p))]));
	const opened: string[] = [];
	const workspaceEl = document.querySelector<HTMLElement>(".workspace")!;
	const leaf = {
		getRoot: () => workspace.rootSplit,
		openFile: async (file: TFile, state?: unknown) => {
			opened.push(`${file.path}${state && (state as { eState?: { line?: number } }).eState ? `#${(state as { eState: { line: number } }).eState.line}` : ""}`);
			workspace.activeFile = file;
			trigger("file-open", file);
		},
		view: {},
	};
	const workspace: Record<string, unknown> = {
		containerEl: workspaceEl,
		rootSplit: { get containerEl() { return workspaceEl.querySelector(".workspace-split.mod-root"); } },
		activeFile: fileMap.get(files[0]) ?? null,
		activeEditor: { editor: { getSelection: () => "" } },
		on(name: string, cb: Listener) {
			const list = listeners.get(name) ?? [];
			list.push(cb);
			listeners.set(name, list);
			return { name, cb };
		},
		onLayoutReady(cb: () => void) {
			window.setTimeout(cb, 0);
		},
		getActiveFile: () => workspace.activeFile,
		getLeavesOfType: () => [],
		getMostRecentLeaf: () => leaf,
		setActiveLeaf: () => undefined,
		getLeaf: () => leaf,
	};
	function trigger(name: string, ...args: unknown[]): void {
		for (const cb of listeners.get(name) ?? []) cb(...args);
	}
	return {
		workspace,
		vault: {
			adapter: new FileSystemAdapter(vaultBase),
			getName: () => "Harness Vault",
			getAbstractFileByPath: (p: string) => fileMap.get(p) ?? null,
		},
		metadataCache: {
			getFirstLinkpathDest: (link: string) => [...fileMap.values()].find((f) => f.basename === link || f.path === link) ?? null,
		},
		hotkeyManager: {
			custom: {} as Record<string, unknown[]>,
			getHotkeys(id: string) {
				return (this as { custom: Record<string, unknown[]> }).custom[id];
			},
			getDefaultHotkeys: () => undefined,
		},
		dragManager: { draggable: null },
		trigger,
		opened,
	};
}
