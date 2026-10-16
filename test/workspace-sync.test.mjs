/* global ReadableStream, TextEncoder, EventTarget, Event */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test, before, after } from "node:test";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";
import { newWebSocketRpcSession } from "@fungi.computer/capnweb";
import { computerTransportBackend } from "../dist/transport-backend.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
let directory, Workspace;
before(async () => {
  await mkdir(resolve(root, ".botanical"), { recursive: true });
  directory = await mkdtemp(resolve(root, ".botanical/workspace-sync-"));
  const output = resolve(directory, "workspace.mjs");
  // Only Worker entrypoint classes are replaced; Workspace runtime, SQLite
  // filesystem, sync cursors and reconnect policy are the installed library.
  await build({
    entryPoints: [
      fileURLToPath(
        new URL(
          "../node_modules/@fungi.computer/cloudflare-computer/dist/index.js",
          import.meta.url,
        ),
      ),
    ],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "worker-entrypoints",
        setup(builder) {
          builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "workers",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents:
              "export class RpcTarget {} export class WorkerEntrypoint {}",
          }));
        },
      },
    ],
  });
  ({ Workspace } = await import(pathToFileURL(output)));
});
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function stream(values) {
  return new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
}

async function socketFailure() {
  // Produce the error through the installed Cap’n Web transport, rather than
  // inventing a transport diagnostic in the Workspace fixture.
  class FailedSocket extends EventTarget {
    readyState = 1;
    send() {
      return undefined;
    }
    close() {
      return undefined;
    }
  }
  const socket = new FailedSocket();
  using rpc = newWebSocketRpcSession(socket);
  const call = rpc.sync.fetchChanges({});
  socket.dispatchEvent(new Event("error"));
  try {
    await call;
  } catch (cause) {
    return cause;
  }
  throw new Error("The failed WebSocket unexpectedly returned a sync response");
}

async function runCommand({
  error = "WebSocket connection failed.",
  persistent = false,
  replaced = false,
  dispatchFailure = false,
} = {}) {
  const failure =
    error === "WebSocket connection failed."
      ? await socketFailure()
      : new Error(error);
  const db = new DatabaseSync(":memory:");
  const storage = {
    sql: {
      exec(query, ...bindings) {
        const rows = db.prepare(query).all(...bindings);
        return { toArray: () => rows };
      },
    },
  };
  const bytes = new TextEncoder().encode("pushed revision\n");
  const hash = new Uint8Array(createHash("sha256").update(bytes).digest());
  let connections = 0,
    commands = 0,
    pulls = 0;
  let pushed = { rev: 0, path: null };
  const backend = {
    id: "vm",
    type: "sync-regression",
    async connect() {
      connections++;
      let disconnected;
      const closed = new Promise((resolve) => {
        disconnected = resolve;
      });
      const fail = () => {
        // Real container/local backends settle closed on the socket error.
        if (error === "WebSocket connection failed.") disconnected();
        throw failure;
      };
      return {
        closed,
        sync: "remote",
        runtimeId:
          replaced && connections > 1
            ? "replacement-runtime"
            : "original-runtime",
        close: async () => undefined,
        rpc: {
          sync: {
            watermarks: async () => ({
              currentRev: 0,
              pushRev: pushed.rev,
              fetchCursor: pushed,
            }),
            async push({ senderRev, changes }) {
              for await (const entry of changes)
                pushed = { rev: entry.rev, path: entry.path };
              pushed = { rev: senderRev, path: null };
              return { rev: 0, appliedPushCursor: pushed };
            },
            async fetchChanges() {
              pulls++;
              if (persistent || pulls === 1) fail();
              return {
                currentCursor: { rev: 1, path: null },
                appliedPushCursor: pushed,
                stream: stream([
                  {
                    kind: "file",
                    rev: 1,
                    path: "/workspace/pushed.txt",
                    mode: 420,
                    mtime: 1,
                    size: bytes.length,
                    chunks: [{ hash, size: bytes.length }],
                  },
                ]),
              };
            },
            hasObjects: async (hashes) => hashes,
            fetchObjects: () => stream([{ hash, bytes }]),
            pushObjects: async () => undefined,
            readEntry: async () => null,
          },
          shell: {
            async exec() {
              commands++;
              if (dispatchFailure) fail();
              return {
                id: "push",
                events: stream([{ id: "push", seq: 1, name: "exit", code: 0 }]),
              };
            },
            getExec: async () => {
              throw new Error("Unexpected getExec");
            },
            killExec: async () => undefined,
            disposeExec: async () => undefined,
          },
        },
      };
    },
  };
  const workspace = new Workspace({
    storage,
    backends: [computerTransportBackend(backend)],
    defaultBackend: "vm",
  });
  try {
    await workspace.fs.mkdir("/workspace", { recursive: true });
    let result, failure;
    try {
      using command = await workspace.runtime.exec("git push", {
        backend: "vm",
        encoding: "utf8",
      });
      result = await command.result();
    } catch (cause) {
      failure = cause;
    }
    let content = null;
    try {
      content = await workspace.fs.readFile("/workspace/pushed.txt", "utf8");
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
    return { result, failure, content, connections, commands, pulls };
  } finally {
    await workspace.close();
    db.close();
  }
}

test("post-push WebSocket failure reconnects and persists files without replaying the push", async () => {
  const proof = await runCommand();
  assert.equal(
    proof.result.sync.status,
    "complete",
    JSON.stringify(proof.result.sync),
  );
  assert.equal(proof.result.exitCode, 0);
  assert.equal(proof.content, "pushed revision\n");
  assert.equal(proof.commands, 1);
  assert.equal(proof.connections, 2);
  assert.equal(proof.pulls, 2);
});
test("a persistently broken sync stays pending after the existing one reconnect bound", async () => {
  const proof = await runCommand({ persistent: true });
  assert.equal(proof.result.sync.status, "pending");
  assert.match(proof.result.sync.error, /after 1 reconnect retry/);
  assert.equal(proof.connections, 2);
  assert.equal(proof.commands, 1);
  assert.equal(proof.content, null);
});
test("a domain failure is retained without reconnecting", async () => {
  const proof = await runCommand({ error: "Sync permission denied" });
  assert.equal(proof.result.sync.status, "pending");
  assert.equal(proof.result.sync.error, "Sync permission denied");
  assert.equal(proof.connections, 1);
  assert.equal(proof.commands, 1);
});
test("post-command sync refuses a replacement runtime", async () => {
  const proof = await runCommand({ replaced: true });
  assert.equal(proof.result.sync.status, "pending");
  assert.match(proof.result.sync.error, /runtime/);
  assert.equal(proof.content, null);
  assert.equal(proof.commands, 1);
});
test("an uncertain dispatch failure never replays the command", async () => {
  const proof = await runCommand({ dispatchFailure: true });
  assert.match(proof.failure.message, /may have started and was not replayed/);
  assert.equal(proof.commands, 1);
  assert.equal(proof.content, null);
});
