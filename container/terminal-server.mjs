// The Computer's own terminal: one PTY per client session, kept across
// WebSocket reconnects. It speaks the wire the Hub terminal host already
// uses: binary frames carry PTY bytes both ways, a client text frame
// `{"type":"resize","cols":N,"rows":N}` resizes, and the server sends
// `{"type":"ready","information":{...}}` with display facts,
// `{"type":"exit","code":N}` and `{"type":"error"}`.
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";
import { URL } from "node:url";
import pty from "node-pty";
import manifest from "./package.json" with { type: "json" };
import { WebSocketServer } from "ws";
import {
  boundedInteger,
  parseResize,
  ReplayRing,
  replayBytes,
} from "./terminal-protocol.mjs";

const terminalShell = "/bin/bash";
const maximumSessions = 16;
const detachedLifetimeMs = 30 * 60 * 1_000;
/** A client that cannot drain this much output reconnects and replays. */
const maximumBufferedBytes = 4 * 1_024 * 1_024;
const sessionPattern = /^[A-Za-z0-9._:-]{1,160}$/;

function send(socket, frame) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

function shellEnvironment(labels) {
  const environment = { ...process.env };
  environment.TERM = "xterm-256color";
  environment.SHELL = terminalShell;
  environment.HOME = environment.HOME ?? "/root";
  const name = labels.get("FUNGI_COMPUTER_NAME");
  if (name !== null) environment.FUNGI_COMPUTER_NAME = name;
  return environment;
}

/** Owns every PTY session in this container; nothing else spawns shells. */
class TerminalSessions {
  #sessions = new Map();
  #spawn;
  #now;

  constructor(spawn, now) {
    this.#spawn = spawn;
    this.#now = now;
  }

  get size() {
    return this.#sessions.size;
  }

  /** Sessions with a socket attached now; detached shells do not count. */
  get attached() {
    let attached = 0;
    for (const session of this.#sessions.values())
      if (session.socket !== null) attached += 1;
    return attached;
  }

  attach(id, cols, rows, socket, labels) {
    let session = this.#sessions.get(id);
    if (session === undefined) {
      if (!this.#makeRoom()) {
        send(socket, { type: "error", message: "terminal session limit" });
        socket.close(1013, "terminal session limit");
        return;
      }
      session = this.#open(id, cols, rows, labels);
    } else {
      session.pty.resize(cols, rows);
    }
    if (session.socket !== null && session.socket !== socket)
      session.socket.close(4000, "terminal attached elsewhere");
    session.socket = socket;
    session.detachedAt = null;
    send(socket, {
      type: "ready",
      information: {
        computerName: labels.get("FUNGI_COMPUTER_NAME") ?? "Computer",
        teamName: labels.get("FUNGI_TEAM_NAME") ?? "unconfigured",
        modelDoor: labels.get("FUNGI_MODEL_DOOR") ?? "unconfigured",
        uptimeSeconds: Math.floor(process.uptime()),
        version: manifest.version,
      },
    });
    const replay = session.ring.snapshot();
    if (replay.byteLength > 0) socket.send(replay, { binary: true });

    socket.on("message", (data, isBinary) => {
      if (session.socket !== socket || session.exited) return;
      if (isBinary) {
        session.pty.write(Buffer.from(data));
        return;
      }
      const size = parseResize(String(data));
      if (size !== null) session.pty.resize(size.cols, size.rows);
    });
    socket.on("close", () => {
      if (session.socket !== socket) return;
      session.socket = null;
      session.detachedAt = this.#now();
    });
    socket.on("error", () => {
      socket.terminate();
    });
  }

  /** Hang up sessions nobody has attached to for the detached lifetime. */
  reap() {
    const now = this.#now();
    for (const session of this.#sessions.values()) {
      if (
        session.detachedAt !== null &&
        now - session.detachedAt >= detachedLifetimeMs
      )
        session.pty.kill("SIGHUP");
    }
  }

  closeAll() {
    for (const session of this.#sessions.values()) {
      session.socket?.close(1001, "Computer stopping");
      session.pty.kill("SIGHUP");
    }
  }

  #makeRoom() {
    if (this.#sessions.size < maximumSessions) return true;
    let oldest = null;
    for (const session of this.#sessions.values()) {
      if (session.detachedAt === null) continue;
      if (oldest === null || session.detachedAt < oldest.detachedAt)
        oldest = session;
    }
    if (oldest === null) return false;
    this.#sessions.delete(oldest.id);
    oldest.pty.kill("SIGHUP");
    return true;
  }

  #open(id, cols, rows, labels) {
    const cwd = existsSync("/workspace") ? "/workspace" : "/";
    const session = {
      id,
      pty: this.#spawn(terminalShell, ["-l"], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: shellEnvironment(labels),
      }),
      ring: new ReplayRing(replayBytes),
      socket: null,
      detachedAt: null,
      exited: false,
    };
    session.pty.onData((text) => {
      const bytes = Buffer.from(text, "utf8");
      session.ring.push(bytes);
      const socket = session.socket;
      if (socket === null || socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > maximumBufferedBytes) {
        socket.close(4001, "terminal output backlog");
        return;
      }
      socket.send(bytes, { binary: true });
    });
    session.pty.onExit(({ exitCode }) => {
      session.exited = true;
      if (this.#sessions.get(id) === session) this.#sessions.delete(id);
      const socket = session.socket;
      if (socket !== null) {
        send(socket, { type: "exit", code: exitCode });
        socket.close(1000, "shell exited");
      }
    });
    this.#sessions.set(id, session);
    return session;
  }
}

/** Serve `/health` and the `/pty` upgrade on one private container port. */
export function startTerminalServer(port) {
  const sessions = new TerminalSessions(pty.spawn, () => Date.now());
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1_024 * 1_024,
  });
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok\n");
      return;
    }
    if (request.url === "/sessions") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ attached: sessions.attached }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const id = url.searchParams.get("session");
    if (url.pathname !== "/pty" || id === null || !sessionPattern.test(id)) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const cols = boundedInteger(url.searchParams.get("cols"), 2, 500, 80);
    const rows = boundedInteger(url.searchParams.get("rows"), 2, 300, 24);
    sockets.handleUpgrade(request, socket, head, (client) => {
      sessions.attach(id, cols, rows, client, url.searchParams);
    });
  });
  const reaper = setInterval(() => {
    sessions.reap();
  }, 60_000);
  reaper.unref();
  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    listening,
    close() {
      clearInterval(reaper);
      sessions.closeAll();
      sockets.close();
      server.close();
    },
  };
}
