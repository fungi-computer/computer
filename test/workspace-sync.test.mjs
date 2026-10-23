/* global ReadableStream, TextEncoder, EventTarget, Event */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test, before, after } from "node:test";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";
import { tsImport } from "tsx/esm/api";
import { newWebSocketRpcSession } from "@fungi.computer/capnweb";
import { computerTransportBackend } from "../dist/transport-backend.js";
import { createWorkspaceFilesPort } from "../dist/files.js";

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

test("Local and hosted search roots and entries have the same visibility", async (t) => {
  // Load the real Local adapter through the maintained TS runner, so Computer's
  // ordinary unit tier does not require an unrelated prebuilt Local dist tree.
  const { createPrivateInvocationFilesPort } = await tsImport(
    "../../../runtimes/local/src/private-invocation-files.ts",
    import.meta.url,
  );
  const db = new DatabaseSync(":memory:");
  const workspace = new Workspace({
    storage: {
      sql: {
        exec(query, ...bindings) {
          const rows = db.prepare(query).all(...bindings);
          return { toArray: () => rows };
        },
      },
    },
  });
  const localRoot = await mkdtemp(resolve(directory, "local-visibility-"));
  try {
    for (const path of [
      ".git",
      ".git/nested",
      "src",
      "src/.git",
      "build",
      "build/sub",
    ]) {
      await workspace.fs.mkdir(`/${path}`);
      await mkdir(resolve(localRoot, path));
    }
    for (const [path, content] of [
      [".gitignore", "build/\n*.log\n"],
      [".git/config", "needle"],
      [".git/nested/config", "needle"],
      ["src/.git/config", "needle"],
      ["build/hidden.txt", "needle"],
      ["build/sub/hidden.txt", "needle"],
      ["build/.gitignore", "!hidden.txt\n!sub/\n"],
      ["hidden.log", "needle"],
      ["visible.txt", "needle"],
      [".gitlike", "needle"],
    ]) {
      await workspace.fs.writeFile(`/${path}`, content);
      await writeFile(resolve(localRoot, path), content);
    }
    const adapters = [
      ["Local", await createPrivateInvocationFilesPort(localRoot)],
      [
        "hosted",
        createWorkspaceFilesPort(workspace, {
          replaceFileIfUnchanged: () => {
            throw new Error("Search must not write");
          },
        }),
      ],
    ];
    // One case set and fixture for BOTH real adapters, not matching fake ports.
    const cases = [
      ...[".git", ".git/nested", "src/.git", "build", "build/sub"].flatMap(
        (path) => [
          ["list", { path, limit: 100 }],
          ["glob", { path, pattern: "**/*", limit: 100 }],
          [
            "grep",
            {
              path,
              pattern: "needle",
              regex: false,
              ignoreCase: false,
              limit: 100,
            },
          ],
        ],
      ),
      ...[
        ".git/config",
        "src/.git/config",
        "build/hidden.txt",
        "hidden.log",
      ].flatMap((path) => [
        ["list", { path, limit: 100 }],
        ["glob", { path, pattern: "**/*", limit: 100 }],
        [
          "grep",
          {
            path,
            pattern: "needle",
            regex: false,
            ignoreCase: false,
            limit: 100,
          },
        ],
      ]),
    ];
    const context = {
      executionId: "search-visibility-parity",
      deadlineAt: null,
      signal: new globalThis.AbortController().signal,
    };
    for (const [adapter, port] of adapters) {
      for (const [operation, input] of cases) {
        await t.test(`${adapter} ${operation} ${input.path}`, async () => {
          assert.deepEqual(await port[operation](input, context), {
            path: input.path,
            results: [],
            truncated: null,
          });
          if (adapter === "hosted") {
            // All principals share these REST methods, with their existing wire.
            const restInput =
              operation === "list" ? { ...input, offset: 0 } : input;
            assert.deepEqual(
              await port.rest[operation](restInput),
              operation === "list"
                ? { path: input.path, entries: [], nextOffset: null }
                : { path: input.path, matches: [], truncated: false },
            );
          }
        });
      }
      await t.test(
        `${adapter} visible entries and exact hidden reads remain available`,
        async () => {
          const output = await port.glob(
            { path: ".", pattern: "**/*.txt", limit: 100 },
            context,
          );
          assert.deepEqual(
            output.results.map((entry) => entry.path.replace(/^\//, "")).sort(),
            ["visible.txt"],
          );
          assert.deepEqual(
            (await port.list({ path: ".", limit: 100 }, context)).results
              .map((entry) => entry.path.replace(/^\//, ""))
              .sort(),
            [".gitignore", ".gitlike", "src", "visible.txt"],
          );
          for (const path of [
            ".git/config",
            "build/hidden.txt",
            "hidden.log",
          ]) {
            // Exact reads retain each adapter's native locator (Workspace is absolute).
            const readPath = adapter === "hosted" ? `/${path}` : path;
            assert.equal(
              (
                await port.read(
                  { path: readPath, offset: 0, limit: 100 },
                  context,
                )
              ).content,
              "needle",
            );
          }
        },
      );
    }
  } finally {
    await workspace.close();
    db.close();
  }
});

test("Agent and shared REST search skip Git metadata and gitignored files with unchanged wire shapes", async () => {
  const db = new DatabaseSync(":memory:");
  const workspace = new Workspace({
    storage: {
      sql: {
        exec(query, ...bindings) {
          const rows = db.prepare(query).all(...bindings);
          return { toArray: () => rows };
        },
      },
    },
  });
  try {
    for (const path of ["/.git", "/build", "/src", "/src/.git"]) {
      await workspace.fs.mkdir(path);
    }
    for (const [path, content] of [
      ["/.gitignore", "build/\n*.log\n"],
      ["/.git/config", "needle"],
      ["/build/hidden.txt", "needle"],
      ["/build/.gitignore", "!hidden.txt\n"],
      ["/hidden.log", "needle"],
      ["/visible.txt", "needle"],
      ["/src/.gitignore", "!keep.log\n"],
      ["/src/keep.log", "needle"],
      ["/src/hidden.log", "needle"],
      ["/src/.git/config", "needle"],
    ]) {
      await workspace.fs.writeFile(path, content);
    }
    const port = createWorkspaceFilesPort(workspace, {
      replaceFileIfUnchanged: () => {
        throw new Error("Search must not write");
      },
    });
    const expected = ["/src/keep.log", "/visible.txt"];
    assert.deepEqual(
      (await port.glob({ path: "/", pattern: "**/*", limit: 100 })).results
        .filter(
          (entry) =>
            entry.type === "file" && !entry.path.endsWith(".gitignore"),
        )
        .map((entry) => entry.path),
      expected,
    );
    const grep = {
      path: "/",
      pattern: "needle",
      regex: false,
      ignoreCase: false,
      limit: 100,
    };
    assert.deepEqual(
      (await port.grep(grep)).results.map((entry) => entry.path),
      expected,
    );
    assert.deepEqual(
      (await port.list({ path: "/", limit: 100 })).results.map(
        (entry) => entry.path,
      ),
      ["/.gitignore", "/src", "/visible.txt"],
    );
    assert.equal((await port.grep({ ...grep, limit: 1 })).truncated, "limit");
    assert.deepEqual(
      (await port.grep({ ...grep, limit: 1 })).results.map(
        (entry) => entry.path,
      ),
      ["/src/keep.log"],
    );
    assert.deepEqual(
      (await port.grep({ ...grep, include: "**/*.log" })).results.map(
        (entry) => entry.path,
      ),
      ["/src/keep.log"],
    );
    assert.deepEqual(
      (await port.rest.grep(grep)).matches.map((entry) => entry.path),
      expected,
    );
    assert.deepEqual(
      (await port.rest.glob({ path: "/", pattern: "**/*.log", limit: 100 }))
        .matches,
      ["/src/keep.log"],
    );
    const first = await port.rest.list({ path: "/", limit: 1, offset: 0 });
    assert.deepEqual(
      first.entries.map((entry) => entry.name),
      [".gitignore"],
    );
    assert.equal(first.nextOffset, 1);
    const second = await port.rest.list({
      path: "/",
      limit: 1,
      offset: first.nextOffset,
    });
    assert.deepEqual(
      second.entries.map((entry) => entry.name),
      ["src"],
    );
    assert.equal(second.nextOffset, 2);
    const last = await port.rest.list({
      path: "/",
      limit: 1,
      offset: second.nextOffset,
    });
    assert.deepEqual(
      last.entries.map((entry) => entry.name),
      ["visible.txt"],
    );
    assert.equal(last.nextOffset, null);
    assert.equal(
      (await port.read({ path: "/.git/config", offset: 0, limit: 100 }))
        .content,
      "needle",
    );
    // Rules are captured per invocation, not cached across workspace edits.
    await workspace.fs.writeFile("/.gitignore", "build/\n*.log\nvisible.txt\n");
    assert.deepEqual(
      (await port.grep(grep)).results.map((entry) => entry.path),
      ["/src/keep.log"],
    );
    await workspace.fs.writeFile("/.gitignore", "x".repeat(128 * 1024 + 1));
    await assert.rejects(
      port.glob({ path: "/", pattern: "**/*", limit: 100 }),
      /ignore rules exceed the search byte bound/,
    );
  } finally {
    await workspace.close();
    db.close();
  }
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
