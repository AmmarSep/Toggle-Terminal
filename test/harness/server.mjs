// Static files + a WebSocket that spawns real ptys for the browser harness.
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import os from "node:os";

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws");
const pty = require("@lydell/node-pty");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const files = {
	"/": [path.join(here, "index.html"), "text/html"],
	"/bundle.js": [path.join(here, ".out", "bundle.js"), "text/javascript"],
	"/styles.css": [path.join(root, "styles.css"), "text/css"],
};

const server = http.createServer((req, res) => {
	const entry = files[new URL(req.url, "http://x").pathname];
	if (!entry) {
		res.writeHead(404).end();
		return;
	}
	res.writeHead(200, { "content-type": entry[1], "cache-control": "no-store" }).end(readFileSync(entry[0]));
});

const wss = new WebSocketServer({ server, path: "/pty" });
wss.on("connection", (ws) => {
	const sessions = new Map();
	ws.on("message", (raw) => {
		const msg = JSON.parse(String(raw));
		if (msg.type === "spawn") {
			const p = pty.spawn("/bin/bash", ["--norc", "-i"], {
				name: "xterm-256color",
				cols: msg.cols,
				rows: msg.rows,
				cwd: process.env.HARNESS_CWD ?? os.homedir(),
				// HARNESS_PATH keeps real CLIs (claude…) out of reach during scenario runs.
				env: { ...process.env, PATH: process.env.HARNESS_PATH ?? process.env.PATH, PS1: "\\[\\e[32m\\]vault\\[\\e[0m\\] $ ", TERM: "xterm-256color", LANG: "C.UTF-8" },
			});
			sessions.set(msg.id, p);
			ws.send(JSON.stringify({ type: "spawned", id: msg.id, pid: p.pid }));
			p.onData((data) => {
				let processName;
				try {
					processName = p.process;
				} catch {}
				if (ws.readyState === 1) ws.send(JSON.stringify({ type: "data", id: msg.id, data, process: processName }));
			});
			// node-pty's process name is a live getter; mirror it for the browser side.
			let lastProcess = "";
			const poll = setInterval(() => {
				let name = "";
				try {
					name = p.process;
				} catch {}
				if (name !== lastProcess && ws.readyState === 1) {
					lastProcess = name;
					ws.send(JSON.stringify({ type: "proc", id: msg.id, process: name }));
				}
			}, 100);
			p.onExit(({ exitCode }) => {
				clearInterval(poll);
				sessions.delete(msg.id);
				if (ws.readyState === 1) ws.send(JSON.stringify({ type: "exit", id: msg.id, code: exitCode }));
			});
		} else if (msg.type === "write") sessions.get(msg.id)?.write(msg.data);
		else if (msg.type === "resize") sessions.get(msg.id)?.resize(msg.cols, msg.rows);
		else if (msg.type === "kill") {
			sessions.get(msg.id)?.kill();
			sessions.delete(msg.id);
		}
	});
	ws.on("close", () => {
		for (const p of sessions.values()) p.kill();
	});
});

server.listen(8765, () => console.log("harness on http://localhost:8765"));
