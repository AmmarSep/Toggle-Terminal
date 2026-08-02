import type { WorkspaceLeaf } from "obsidian";

/**
 * Collapse helpers for the bottom terminal panel.
 *
 * Obsidian has no public API for collapsing a leaf inside the root split, and
 * `detachLeavesOfType()` would destroy the view (and therefore the shell
 * process) on every toggle. Instead the panel's workspace container is hidden
 * with a class: the leaf, the view and the pty all stay alive, so scrollback
 * and running commands survive a hide/show cycle.
 */

export const HIDDEN_CLASS = "terminal-panel-is-hidden";

/** The `.workspace-leaf` element that hosts this view. */
function leafElement(leaf: WorkspaceLeaf): HTMLElement | null {
	return leaf.view.containerEl.closest<HTMLElement>(".workspace-leaf");
}

/**
 * The element to collapse. Prefer the whole tab group (so its tab header
 * disappears too), but fall back to the single leaf when the terminal shares a
 * tab group with other views.
 */
export function panelContainer(leaf: WorkspaceLeaf): HTMLElement | null {
	const element = leafElement(leaf);
	if (!element) return null;

	const tabs = element.closest<HTMLElement>(".workspace-tabs");
	if (tabs && tabs.querySelectorAll(".workspace-leaf").length === 1) {
		return tabs;
	}
	return element;
}

export function isPanelHidden(leaf: WorkspaceLeaf): boolean {
	const container = panelContainer(leaf);
	return container?.hasClass(HIDDEN_CLASS) ?? false;
}

export function hidePanel(leaf: WorkspaceLeaf): boolean {
	const container = panelContainer(leaf);
	if (!container) return false;
	container.addClass(HIDDEN_CLASS);
	adjacentResizeHandle(container)?.addClass(HIDDEN_CLASS);
	return true;
}

export function showPanel(leaf: WorkspaceLeaf): boolean {
	const container = panelContainer(leaf);
	if (!container) return false;
	container.removeClass(HIDDEN_CLASS);
	adjacentResizeHandle(container)?.removeClass(HIDDEN_CLASS);
	return true;
}

/** Some Obsidian versions render the drag handle as a sibling of the pane. */
function adjacentResizeHandle(container: HTMLElement): HTMLElement | null {
	for (const sibling of [container.previousElementSibling, container.nextElementSibling]) {
		if (sibling instanceof HTMLElement && sibling.hasClass("workspace-leaf-resize-handle")) {
			return sibling;
		}
	}
	return null;
}

/**
 * Give the freshly created panel a starting height. Obsidian stores pane sizes
 * as inline `flex-grow`, so a fixed basis with no growth pins the panel until
 * the user drags the divider.
 */
export function applyInitialHeight(leaf: WorkspaceLeaf, heightPx: number): void {
	const container = panelContainer(leaf);
	if (!container || heightPx <= 0) return;
	container.style.flexGrow = "0";
	container.style.flexShrink = "0";
	container.style.flexBasis = `${heightPx}px`;
}
