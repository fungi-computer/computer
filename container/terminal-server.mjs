// The Computer's own terminal: one PTY per client session, kept across
// WebSocket reconnects. It speaks the wire the Hub terminal host already
// uses: binary frames carry PTY bytes both ways, a client text frame
// `{"type":"resize","cols":N,"rows":N}` resizes, and the server sends
// `{"type":"ready","information":{...}}` with display facts,
// `{"type":"exit","code":N}` and `{"type":"error"}`.
//
// `/ssh` is a second door on the same port: each WebSocket carries one raw SSH
// stream (binary frames only) to a fixed `sshd -i`, run as this process's
// unprivileged user. It listens on nothing and counts as a session.
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import console from "node:console";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import process from "node:process";
import { clearInterval, setInterval, setTimeout } from "node:timers";
import { URL } from "node:url";
import pty from "node-pty";
import manifest from "./package.json" with { type: "json" };
import { createWebSocketStream, WebSocketServer } from "ws";
import {
  boundedInteger,
  maximumSessions,
  parseResize,
  ReplayRing,
  replayBytes,
  sshHasRoom,
} from "./terminal-protocol.mjs";

const terminalShell = "/bin/bash";
/** The guest's `sshd -i`, with fixed argv; nothing a client sends reaches it. */
const sshd = "/usr/sbin/sshd";
const sshdArguments = ["-i", "-e", "-f", "/opt/fungi/sshd_config"];
/** What vmd supplies at boot (computer-start.sh); without them there is no SSH. */
const sshFiles = [
  "/run/fungi-ssh/host_ed25519",
  "/run/fungi-ssh/user_ca.pub",
  "/run/fungi-ssh/principals",
];
/** How long a hung-up SSH session's processes get after SIGTERM before SIGKILL. */
const sshKillGraceMs = 2_000;
const detachedLifetimeMs = 30 * 60 * 1_000;
/** A client that cannot drain this much output reconnects and replays. */
const maximumBufferedBytes = 4 * 1_024 * 1_024;
const sessionPattern = /^[A-Za-z0-9._:-]{1,160}$/;

/**
 * Every process below `root`, from /proc. sshd puts a session's command in a
 * session of its own and ignores SIGTERM when it has no PTY, so neither the
 * process group nor sshd's death reaches it: the tree is read while sshd lives.
 */
function descendants(root) {
  const children = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^[0-9]+$/u.test(name)) continue;
    let stat;
    try {
      stat = readFileSync(`/proc/${name}/stat`, "utf8");
    } catch (cause) {
      // The process exited while the table was read.
      if (cause.code === "ENOENT" || cause.code === "ESRCH") continue;
      throw cause;
    }
    // "pid (comm) state ppid ...": comm may hold spaces and parentheses.
    const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    const siblings = children.get(parent) ?? [];
    siblings.push(Number(name));
    children.set(parent, siblings);
  }
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    for (const child of children.get(pending.pop()) ?? []) {
      found.push(child);
      pending.push(child);
    }
  }
  return found;
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch (cause) {
    // A process that is already gone is what cleanup wants.
    if (cause.code !== "ESRCH")
      console.error(`ssh cleanup could not signal ${String(pid)}`, cause);
  }
}

/**
 * End an sshd and all it started: SIGTERM, then SIGKILL after a short grace.
 * When sshd itself has already exited its children cannot be found, so the
 * tree walk is skipped; after the grace sshd's own pid and group are left
 * alone once it is gone (the number may be reused), while a descendant that
 * was alive when the walk ran is still killed.
 */
function killSshd(child) {
  const pid = child.pid;
  if (pid === undefined) return;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const doomed = exited() ? [] : [pid, ...descendants(pid)];
  signal(-pid, "SIGTERM");
  for (const target of doomed) signal(target, "SIGTERM");
  setTimeout(() => {
    if (!exited()) signal(-pid, "SIGKILL");
    for (const target of doomed)
      if (target !== pid || !exited()) signal(target, "SIGKILL");
  }, sshKillGraceMs).unref();
}

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

/**
 * Owns every PTY session in this container, and every `sshd -i` that serves an
 * attached SSH socket. Nothing else spawns shells or login daemons.
 */
class TerminalSessions {
  #sessions = new Map();
  #ssh = new Set();
  #spawnSshd;
  #spawn;
  #now;

  constructor(spawn, now, spawnSshd = spawnFixedSshd) {
    this.#spawn = spawn;
    this.#now = now;
    this.#spawnSshd = spawnSshd;
  }

  get size() {
    return this.#sessions.size + this.#ssh.size;
  }

  /** Sessions with a socket attached now; detached shells do not count. */
  get attached() {
    let attached = this.#ssh.size;
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

  /**
   * Serve one SSH stream: a fresh `sshd -i` whose stdin and stdout are this
   * socket's binary frames. It ends with either side, and never outlives it.
   */
  attachSsh(socket) {
    if (!sshHasRoom(this.#ssh.size) || !this.#makeRoom()) {
      send(socket, { type: "error", message: "terminal session limit" });
      socket.close(1013, "terminal session limit");
      return;
    }
    const child = this.#spawnSshd();
    const session = { socket, child };
    this.#ssh.add(session);
    const stream = createWebSocketStream(socket);
    const finish = () => {
      if (!this.#ssh.delete(session)) return;
      stream.destroy();
      killSshd(child);
      if (socket.readyState === socket.OPEN) socket.close(1000, "sshd exited");
    };
    child.once("exit", finish);
    child.once("error", finish);
    socket.once("close", finish);
    stream.on("error", finish);
    child.stdin.on("error", finish);
    child.stdout.on("error", finish);
    stream.pipe(child.stdin);
    child.stdout.pipe(stream);
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
    for (const session of this.#ssh) {
      session.socket.close(1001, "Computer stopping");
      killSshd(session.child);
    }
    for (const session of this.#sessions.values()) {
      session.socket?.close(1001, "Computer stopping");
      session.pty.kill("SIGHUP");
    }
  }

  #makeRoom() {
    if (this.size < maximumSessions) return true;
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

function spawnFixedSshd() {
  return spawn(sshd, sshdArguments, {
    cwd: "/",
    // Its own process group, so one signal reaches sshd and its helpers.
    detached: true,
    // sshd's own log (VERBOSE, with each certificate's key id) goes to this
    // process's stderr, which the container runtime collects.
    stdio: ["pipe", "pipe", "inherit"],
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
  });
}

/** Serve `/health` and the `/pty` and `/ssh` upgrades on one private container port. */
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
    if (url.pathname === "/ssh") {
      // A Computer whose boot supplied no SSH files has no SSH to offer.
      if (!sshFiles.every((file) => existsSync(file))) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        return;
      }
      sockets.handleUpgrade(request, socket, head, (client) => {
        sessions.attachSsh(client);
      });
      return;
    }
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
