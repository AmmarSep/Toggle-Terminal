// node:path and node:os for the browser harness (POSIX semantics).
function normalize(p: string): string {
	const abs = p.startsWith("/");
	const parts: string[] = [];
	for (const part of p.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return (abs ? "/" : "") + parts.join("/");
}
export function join(...parts: string[]): string {
	return normalize(parts.filter(Boolean).join("/"));
}
export function isAbsolute(p: string): boolean {
	return p.startsWith("/");
}
export function resolve(...parts: string[]): string {
	let out = "";
	for (const part of parts) out = part.startsWith("/") ? part : `${out}/${part}`;
	return normalize(out);
}
export function relative(from: string, to: string): string {
	const a = normalize(from).split("/").filter(Boolean);
	const b = normalize(to).split("/").filter(Boolean);
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
}
export const sep = "/";
export function homedir(): string {
	return "/root";
}
export function release(): string {
	return "6.0.0";
}
export default { join, isAbsolute, resolve, relative, sep, homedir, release };
