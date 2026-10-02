import { ItemView, type WorkspaceLeaf } from "obsidian";

/**
 * 1.x hosted the terminal in a workspace leaf of this type. Obsidian restores
 * saved leaves before plugins can react, so the type stays registered: the
 * restored leaf gets this placeholder, and the plugin detaches it once the
 * layout is ready and opens the panel in its place.
 */
export const LEGACY_VIEW_TYPE = "toggle-terminal-view";

export class LegacyTerminalView extends ItemView {
	private readonly iconId: string;

	constructor(leaf: WorkspaceLeaf, iconId: string) {
		super(leaf);
		this.iconId = iconId;
		this.navigation = false;
	}

	override getViewType(): string {
		return LEGACY_VIEW_TYPE;
	}

	override getDisplayText(): string {
		return "Terminal";
	}

	override getIcon(): string {
		return this.iconId;
	}

	override async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.createDiv({
			cls: "tt-legacy-placeholder",
			text: "The terminal now lives in its own docked panel. Press Ctrl+` to open it.",
		});
	}
}
