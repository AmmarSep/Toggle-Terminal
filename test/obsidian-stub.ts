// Minimal stand-in for the "obsidian" module so pure modules can run under node.
export const Platform = { isMacOS: true, isWin: false, isLinux: false, isDesktopApp: true, isMobile: false };
export function setPlatform(p: Partial<typeof Platform>): void {
	Object.assign(Platform, p);
}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class Modal {}
export class Menu {}
export class Notice {}
export class ItemView {}
export class FileSystemAdapter {}
export class TFile {}
export class TFolder {}
export class MarkdownView {}
export class Keymap {
	static isModifier(): boolean {
		return false;
	}
}
export function debounce<T extends unknown[]>(fn: (...args: T) => void): (...args: T) => void {
	return fn;
}
export function setIcon(): void {}
export function setTooltip(): void {}
export function normalizePath(p: string): string {
	return p;
}
export function addIcon(): void {}
export function getIconIds(): string[] {
	return [];
}
export const apiVersion = "test";
export type App = unknown;
