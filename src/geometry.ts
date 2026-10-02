import type { DockPosition } from "./settings";

/* Pure geometry for the dock, kept apart so it can be tested without a DOM. */

export interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** Smallest panel that is still usable: header plus a few rows / a narrow column. */
export const MIN_SIZE: Record<DockPosition, number> = { bottom: 90, right: 220, left: 220 };

/** Inline properties the dock sets on the root split; all cleared together. */
export const RESERVED_PROPERTIES = ["max-height", "margin-right", "margin-left", "min-width"] as const;

/** Space the editor area keeps beside a side panel. */
export const MIN_EDITOR_WIDTH = 160;

/**
 * Where the dock goes, in viewport coordinates.
 *
 * @param root The root split's rect *after* the reservation margin applied.
 * @param size Reserved size in px (height for bottom, width for sides).
 * @param headerHeight Height of the editor area's top tab row, kept visible
 *   when maximized so window controls and note tabs stay reachable.
 */
export function dockRect(position: DockPosition, root: Rect, size: number, maximized: boolean, headerHeight: number): Rect {
	if (maximized) {
		const top = root.top + headerHeight;
		if (position === "bottom") {
			return { left: root.left, top, width: root.width, height: root.height + size - headerHeight };
		}
		return {
			left: position === "left" ? root.left - size : root.left,
			top,
			width: root.width + size,
			height: root.height - headerHeight,
		};
	}
	switch (position) {
		case "bottom":
			return { left: root.left, top: root.top + root.height, width: root.width, height: size };
		case "right":
			return { left: root.left + root.width, top: root.top, width: size, height: root.height };
		case "left":
			return { left: root.left - size, top: root.top, width: size, height: root.height };
	}
}

/**
 * Clamp a requested size to what fits. `available` is the root size plus the
 * current reservation, i.e. the whole strip the editor and panel share.
 */
export function clampSize(position: DockPosition, requested: number, available: number, minEditor: number): number {
	const max = Math.max(MIN_SIZE[position], Math.floor(available - minEditor));
	return Math.round(Math.min(Math.max(requested, MIN_SIZE[position]), max));
}
