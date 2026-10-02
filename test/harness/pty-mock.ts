/*
 * Browser replacement for src/pty.ts: sessions are real ptys spawned by the
 * harness server (node-pty) and proxied over a WebSocket.
 */
export type SessionKind = "pty" | "bridge" | "piped";

export interface TerminalSession {
	readonly kind: SessionKind;
	readonly pid: number | undefined;
	readonly alive: boolean;
	readonly processName: string | undefined;
	onData(listener: (chunk: string) => void): void;
	onExit(listener: (exitCode: number) => void): void;
	write(data: string): void;
	resize(columns: number, rows: number): void;
	dispose(): void;
}

export interface SpawnRequest {
	file: string;
	args: readonly string[];
	cwd: string | undefined;
	cols: number;
	rows: number;
	env: Record<string, string | undefined>;
	pluginDir: string | null;
	pythonPath: string | null;
}

type Message = { type: string; id: number; data?: string; code?: number; pid?: number; process?: string; cols?: number; rows?: number };

let socket: WebSocket | null = null;
const queue: string[] = [];
const sessions = new Map<number, HarnessSession>();
let nextId = 1;

function connection(): WebSocket {
	if (socket) return socket;
	socket = new WebSocket(`ws://${location.host}/pty`);
	socket.addEventListener("open", () => {
		for (const message of queue.splice(0)) socket?.send(message);
	});
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data)) as Message;
		sessions.get(message.id)?.receive(message);
	});
	return socket;
}

function send(message: Message | Record<string, unknown>): void {
	const ws = connection();
	const text = JSON.stringify(message);
	if (ws.readyState === WebSocket.OPEN) ws.send(text);
	else queue.push(text);
}

/** Every resize the shell saw, for assertions. */
export const resizeLog: Array<{ id: number; cols: number; rows: number }> = [];
(window as unknown as { __resizeLog: typeof resizeLog }).__resizeLog = resizeLog;

class HarnessSession implements TerminalSession {
	readonly kind: SessionKind = "pty";
	readonly id = nextId++;
	pid: number | undefined;
	processName: string | undefined;
	private disposed = false;
	private readonly dataListeners: Array<(chunk: string) => void> = [];
	private readonly exitListeners: Array<(code: number) => void> = [];

	constructor(request: SpawnRequest) {
		sessions.set(this.id, this);
		send({ type: "spawn", id: this.id, file: request.file, args: request.args, cwd: request.cwd, cols: request.cols, rows: request.rows });
		resizeLog.push({ id: this.id, cols: request.cols, rows: request.rows });
	}
	get alive(): boolean {
		return !this.disposed;
	}
	receive(message: Message): void {
		if (message.type === "spawned") this.pid = message.pid;
		if (message.type === "proc") this.processName = message.process;
		if (message.type === "data" && message.data) {
			if (message.process) this.processName = message.process;
			for (const l of this.dataListeners) l(message.data);
		}
		if (message.type === "exit" && !this.disposed) {
			this.disposed = true;
			for (const l of this.exitListeners) l(message.code ?? 0);
		}
	}
	onData(listener: (chunk: string) => void): void {
		this.dataListeners.push(listener);
	}
	onExit(listener: (code: number) => void): void {
		this.exitListeners.push(listener);
	}
	write(data: string): void {
		if (!this.disposed) send({ type: "write", id: this.id, data });
	}
	resize(cols: number, rows: number): void {
		if (this.disposed) return;
		resizeLog.push({ id: this.id, cols, rows });
		send({ type: "resize", id: this.id, cols, rows });
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		send({ type: "kill", id: this.id });
	}
}

export function createSession(request: SpawnRequest): TerminalSession {
	return new HarnessSession(request);
}

export const SHELL_EOL = "\n";
export function availableBackend(): SessionKind {
	return "pty";
}
export function detectShell(): string {
	return "/bin/bash";
}
export function defaultShellArgs(): string[] {
	return ["--norc", "-i"];
}
export function findPython(): string | null {
	return "/usr/bin/python3";
}
export function installedPtyBinaries(): string[] {
	return ["node-pty-linux-x64"];
}
export function probePty(): Array<{ candidate: string; result: string; detail: string }> {
	return [{ candidate: "harness", result: "loaded", detail: "websocket" }];
}
export function parseArgs(raw: string): string[] {
	return raw.split(/\s+/).filter(Boolean);
}
export function parseEnvLines(): Record<string, string> {
	return {};
}
export function terminalEnv(): Record<string, string | undefined> {
	return {};
}
