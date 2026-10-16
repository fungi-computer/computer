/* global console, ReadableStream, setTimeout */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  ComputerProcessLimitError,
  computerCapabilities,
  installationProcessScope,
  maximumProcessRecords,
  maximumRunningProcesses,
  mintComputerRequestId,
  processStartInputSchema,
} from "../dist/operation-contract.js";
import {
  ComputerProcessInventory,
  drainProcessExit,
  liveProbeMs,
  observeProcess,
  postExitDrainDeadlineMs,
} from "../dist/process-inventory.js";
import { PullPendingTracker } from "../dist/pull-pending.js";

/** The Durable Object SQL surface, backed by a real SQLite database. */
function sqliteStorage() {
  const database = new DatabaseSync(":memory:");
  return {
    sql: {
      exec(query, ...bindings) {
        const statement = database.prepare(query);
        const rows =
          statement.columns().length > 0
            ? statement.all(...bindings)
            : (statement.run(...bindings), []);
        return { toArray: () => rows.map((row) => ({ ...row })) };
      },
    },
    transactionSync(operation) {
      database.exec("SAVEPOINT operation");
      try {
        const result = operation();
        database.exec("RELEASE operation");
        return result;
      } catch (error) {
        database.exec("ROLLBACK TO operation");
        database.exec("RELEASE operation");
        throw error;
      }
    },
  };
}

/** Hosts accept authority inside admission; these proofs have none to check. */
const accept = () => undefined;

function clock() {
  let now = Date.now();
  return () => (now += 1_000);
}

/** A computerd execution stream: events, then close or stay open. */
function stream(events, stayOpen) {
  const handle = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      if (!stayOpen) controller.close();
    },
  });
  handle[Symbol.dispose] = () => undefined;
  return handle;
}

/**
 * A stream that only reaches EOF (and runs whatever a real `@cloudflare/
 * computer` handle would run on its post-command pull) on a read past its
 * last queued event, and that tells us separately whether it was cancelled
 * instead. `@cloudflare/computer`'s `withPostPull` only pulls on that EOF
 * read; its cancel path skips the pull. `hangAfterEvents` stands in for a
 * backgrounded child still holding the transport open: that read never
 * resolves. `closeAfterMs` stands in for a slow-but-real pull: it closes,
 * calling `onEof`, only after that delay.
 */
function streamWithPull(
  events,
  { onEof, onCancel, hangAfterEvents = false, closeAfterMs } = {},
) {
  let delivered = 0;
  const handle = new ReadableStream(
    {
      async pull(controller) {
        if (delivered < events.length) {
          controller.enqueue(events[delivered]);
          delivered += 1;
          return;
        }
        if (closeAfterMs !== undefined)
          await new Promise((resolve) => {
            setTimeout(resolve, closeAfterMs);
          });
        else if (hangAfterEvents) return;
        onEof?.();
        controller.close();
      },
      cancel(reason) {
        onCancel?.(reason);
      },
    },
    // highWaterMark 0 matches @cloudflare/computer's own exec-handle streams
    // (withPostPull, wrapModuleHandle): `pull` runs only on an explicit read,
    // never ahead of it. A default (1) queuing strategy would pull a second
    // time on its own right after the first chunk is dequeued, reaching EOF
    // (and "running" the pull) whether or not observeProcess asks for it —
    // masking exactly the bug this test exists to catch.
    { highWaterMark: 0 },
  );
  handle[Symbol.dispose] = () => undefined;
  return handle;
}

test("native model start advertises only command, cwd and port", () => {
  const tool = computerCapabilities().find(
    (capability) => capability.id === "start_process",
  );
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
    "command",
    "cwd",
    "port",
  ]);
  assert.deepEqual(tool.parameters.required, ["command"]);
  assert.equal(tool.parameters.additionalProperties, false);
});

test("same invocation key cannot cross member, actor kind or method scopes", () => {
  const inventory = new ComputerProcessInventory(sqliteStorage(), clock());
  const scope = (method, kind, id) =>
    installationProcessScope("app", method, { kind, id });
  assert.equal(
    scope("start", "member", "a"),
    'installation:["app","start","member:a"]',
  );
  const first = {
    requestScope: scope("start", "member", "a"),
    requestId: "same",
    command: "a",
  };
  const a = inventory.admit(first, "a", accept).process;
  assert.equal(
    inventory.admit(first, "a", accept).process.id,
    a.id,
    "same command is the one invocation's retry",
  );
  assert.throws(
    () => inventory.admit({ ...first, command: "b" }, "b", accept),
    /already bound/,
    "a second command in one invocation conflicts",
  );
  const secondInvocation = inventory.admit(
    { ...first, requestId: "next-invocation", command: "b" },
    "b",
    accept,
  ).process;
  assert.notEqual(
    secondInvocation.id,
    a.id,
    "same member/method with a different invocation key starts independently",
  );
  for (const requestScope of [
    scope("other", "member", "a"),
    scope("start", "member", "b"),
    scope("start", "agent", "a"),
    scope("start", "team-key", "a"),
  ]) {
    const row = inventory.admit(
      { ...first, requestScope, command: "b" },
      "b",
      accept,
    ).process;
    assert.notEqual(row.id, a.id);
    assert.equal(row.command, "b");
  }
});

test("native start requires a replay key and accepts a declared port", () => {
  const requestId = "opaque/frame:key-not-a-uuid";
  const input = {
    requestScope: "owner:fixture",
    requestId,
    command: "node server.js",
    port: 3000,
  };
  assert.deepEqual(processStartInputSchema.parse(input), input);
  assert.equal(
    processStartInputSchema.safeParse({ command: "true" }).success,
    false,
  );
});

test("a replay key returns one process and changed input conflicts", () => {
  const storage = sqliteStorage();
  const inventory = new ComputerProcessInventory(storage, () => Date.now());
  const input = {
    requestScope: "owner:fixture",
    requestId: mintComputerRequestId(),
    command: "sleep 600",
    port: 3000,
  };
  const first = inventory.admit(input, "same-input", accept);
  const replay = inventory.admit(input, "same-input", accept);
  assert.equal(replay.created, false);
  assert.equal(replay.process.id, first.process.id);
  assert.equal(inventory.list().length, 1);
  const otherScope = inventory.admit(
    { ...input, requestScope: "installation:other", port: undefined },
    "no-port",
    accept,
  );
  assert.equal(otherScope.created, true);
  assert.notEqual(otherScope.process.id, first.process.id);
  assert.throws(
    () =>
      inventory.admit({ ...input, command: "other" }, "other-input", accept),
    /already bound/,
  );
});

test("an in-flight replay does not claim a dispatch succeeded", () => {
  const inventory = new ComputerProcessInventory(sqliteStorage(), clock());
  const input = {
    requestScope: "owner:pending",
    requestId: "pending",
    command: "sleep",
  };
  const original = inventory.admit(input, "sleep", accept).process;
  assert.equal(inventory.replay(input, "sleep", accept).state, "uncertain");
  assert.equal(
    inventory.admit(input, "sleep", accept).process.state,
    "uncertain",
  );
  inventory.release(original.id);
  const retry = inventory.admit(input, "sleep", accept);
  assert.equal(retry.created, false);
  assert.equal(retry.process.id, original.id);
  assert.equal(retry.process.state, "exited");
});

test("identity survives reconstruction and exits are recorded once", () => {
  const storage = sqliteStorage();
  const now = clock();
  const first = new ComputerProcessInventory(storage, now);
  let accepted = 0;
  const input = {
    requestScope: "owner:fixture",
    requestId: mintComputerRequestId(),
    command: "pnpm dev",
    cwd: "/workspace",
  };
  const { process: admitted } = first.admit(input, "pnpm-dev", () => {
    accepted += 1;
  });
  const id = admitted.id;
  assert.equal(accepted, 1);
  assert.equal(admitted.state, "running");

  const reopened = new ComputerProcessInventory(storage, now);
  assert.deepEqual(reopened.get(id), admitted, "a new isolate sees the row");
  assert.equal(reopened.exited(id, 0).exitCode, 0);
  assert.equal(reopened.exited(id, 9).exitCode, 0, "first exit wins");
  reopened.release(id);
  assert.equal(reopened.get(id)?.state, "exited", "exited rows stay");
});

test("a process is unknown-synced unless its drained exit reported real pull evidence", () => {
  const inventory = new ComputerProcessInventory(sqliteStorage(), clock());
  const running = inventory.admit(
    {
      requestScope: "owner:fixture",
      requestId: "default-sync",
      command: "true",
    },
    "default-sync",
    accept,
  ).process;
  assert.equal(
    running.sync,
    "unknown",
    "a running process claims no sync evidence either way",
  );
  assert.equal(
    inventory.exited(running.id, 0).sync,
    "unknown",
    "exited() must never default to synced without evidence",
  );

  const pending = inventory.admit(
    {
      requestScope: "owner:fixture",
      requestId: "pending-sync",
      command: "true",
    },
    "pending-sync",
    accept,
  ).process;
  const settled = inventory.exited(pending.id, 0, "pending");
  assert.equal(
    settled.sync,
    "pending",
    "exited() records a caller-reported pull failure",
  );
  assert.equal(
    inventory.get(pending.id)?.sync,
    "pending",
    "the pending sync state is durable",
  );
  assert.equal(
    inventory.exited(pending.id, 9, "synced").sync,
    "pending",
    "first exit wins, including its sync state",
  );
});

test("resync upgrades an already-exited row's sync, and only an exited one", () => {
  const inventory = new ComputerProcessInventory(sqliteStorage(), clock());
  const running = inventory.admit(
    { requestScope: "owner:fixture", requestId: "running", command: "true" },
    "running",
    accept,
  ).process;
  inventory.resync(running.id, "synced");
  assert.equal(
    inventory.get(running.id)?.sync,
    "unknown",
    "a running row is not updatable by resync: pending rows must be, running ones never claimed anything",
  );

  const exited = inventory.admit(
    { requestScope: "owner:fixture", requestId: "exited", command: "true" },
    "exited",
    accept,
  ).process;
  inventory.exited(exited.id, 0, "pending");
  inventory.resync(exited.id, "synced");
  assert.equal(
    inventory.get(exited.id)?.sync,
    "synced",
    "a pending row must be updatable by resync once the background drain confirms it",
  );

  inventory.resync("computer_process_nonexistent", "synced");
});

test("running slots and retained replay records are bounded", () => {
  let now = Date.now();
  const inventory = new ComputerProcessInventory(sqliteStorage(), () => now);
  const input = () => ({
    requestScope: "owner:fixture",
    requestId: mintComputerRequestId(),
    command: "sleep 1",
  });
  const ids = Array.from(
    { length: maximumRunningProcesses },
    () => inventory.admit(input(), "sleep", accept).process.id,
  );
  assert.throws(
    () => inventory.admit(input(), "sleep", accept),
    ComputerProcessLimitError,
  );
  for (const id of ids) inventory.exited(id, 0);
  const old = input();
  inventory.admit(old, "old", accept);
  inventory.exited(inventory.replay(old, "old", accept).id, 0);
  for (let index = 0; index < maximumProcessRecords + 10; index += 1) {
    now += 1_000;
    const admitted = inventory.admit(input(), "sleep", accept).process;
    inventory.exited(admitted.id, 0);
  }
  assert.equal(inventory.list().length, maximumProcessRecords);
  assert.equal(inventory.replay(old, "old", accept), undefined);
  assert.equal(
    inventory.admit(old, "old", accept).created,
    true,
    "own-scope eviction ends replay protection as documented",
  );
});

test("one scope cannot consume another scope's slots or evict its replay", () => {
  const inventory = new ComputerProcessInventory(sqliteStorage(), clock());
  const input = (requestScope, requestId) => ({
    requestScope,
    requestId,
    command: "sleep",
  });
  const retained = input("installation:B", "retained");
  const b = inventory.admit(retained, "sleep", accept).process;
  inventory.exited(b.id, 0);
  const a = Array.from(
    { length: maximumRunningProcesses },
    (_, index) =>
      inventory.admit(
        input("installation:A", `running-${String(index)}`),
        "sleep",
        accept,
      ).process,
  );
  const secondB = inventory.admit(
    input("installation:B", "running"),
    "sleep",
    accept,
  ).process;
  assert.notEqual(secondB.id, b.id);
  assert.equal(
    inventory.replay(input("installation:A", "running-0"), "sleep", accept).id,
    a[0].id,
    "a full scope still replays its existing start",
  );
  for (const row of a) inventory.exited(row.id, 0);
  for (let index = 0; index < maximumProcessRecords + 10; index += 1) {
    const row = inventory.admit(
      input("installation:A", `short-${String(index)}`),
      "sleep",
      accept,
    ).process;
    inventory.exited(row.id, 0);
  }
  assert.equal(
    inventory.replay(retained, "sleep", accept).id,
    b.id,
    "another installation cannot evict B's replay protection",
  );
});

test("the 64-record bound includes old running processes", () => {
  let now = Date.now();
  const inventory = new ComputerProcessInventory(sqliteStorage(), () => ++now);
  const start = (requestId) =>
    inventory.admit(
      { requestId, requestScope: "owner:fixture", command: "sleep" },
      "sleep",
      accept,
    ).process;
  const retained = start("long-running");
  for (let index = 0; index < maximumProcessRecords + 4; index += 1) {
    const short = start(`short-${String(index)}`);
    inventory.exited(short.id, 0);
  }
  assert.equal(inventory.get(retained.id).state, "running");
  assert.equal(inventory.list().length, maximumProcessRecords);
});

test("process and declared exposure commit or roll back together, and manual exposure stays", () => {
  const storage = sqliteStorage();
  const inventory = new ComputerProcessInventory(storage, () => Date.now());
  const input = (port) => ({
    requestScope: "owner:fixture",
    requestId: mintComputerRequestId(),
    command: "sleep 1",
    port,
  });
  const ports = () =>
    storage.sql
      .exec("SELECT port, process_id FROM computer_exposed_ports ORDER BY port")
      .toArray();
  assert.throws(
    () =>
      inventory.admit(input(3000), "denied", () => {
        throw new Error("denied");
      }),
    /denied/,
  );
  assert.deepEqual(inventory.list(), []);
  assert.deepEqual(ports(), []);
  for (const port of [8080, 7681])
    assert.throws(
      () => inventory.admit(input(port), "reserved", accept),
      /reserved/,
    );
  assert.deepEqual(inventory.list(), []);
  assert.deepEqual(ports(), []);
  storage.sql.exec("INSERT INTO computer_exposed_ports (port) VALUES (3000)");
  const manual = inventory.admit(input(3000), "manual", accept).process;
  const owned = inventory.admit(input(3001), "owned", accept).process;
  assert.equal(manual.port, 3000);
  assert.deepEqual(ports(), [
    { port: 3000, process_id: null },
    { port: 3001, process_id: owned.id },
  ]);
  assert.throws(
    () => inventory.admit(input(3001), "collision", accept),
    /port is unavailable/,
  );
  assert.equal(inventory.list().length, 2);
  inventory.exited(manual.id, 0);
  inventory.exited(owned.id, 0);
  assert.deepEqual(ports(), [{ port: 3000, process_id: null }]);
});

test("two scopes racing a port get one owner and a typed opaque refusal", () => {
  const storage = sqliteStorage();
  const inventory = new ComputerProcessInventory(storage, clock());
  const input = {
    requestScope: "installation:A",
    requestId: "start",
    command: "sleep",
    port: 4000,
  };
  const owner = inventory.admit(input, "sleep", accept).process;
  assert.throws(
    () =>
      inventory.admit(
        { ...input, requestScope: "installation:B" },
        "sleep",
        accept,
      ),
    (error) => {
      assert.equal(error.name, "ComputerPortConflictError");
      assert.equal(error.message, "Computer port is unavailable");
      return true;
    },
  );
  assert.deepEqual(inventory.list(), [owner]);
  assert.deepEqual(
    storage.sql
      .exec("SELECT port, process_id FROM computer_exposed_ports")
      .toArray(),
    [{ port: 4000, process_id: owner.id }],
  );
});

test("port capacity failure reserves no process and a manual re-expose outlives its process", () => {
  const storage = sqliteStorage();
  const inventory = new ComputerProcessInventory(storage, () => Date.now());
  for (let port = 3000; port < 3064; port += 1)
    storage.sql.exec(
      "INSERT INTO computer_exposed_ports (port) VALUES (?)",
      port,
    );
  assert.throws(
    () =>
      inventory.admit(
        {
          requestScope: "owner:fixture",
          requestId: mintComputerRequestId(),
          command: "sleep",
          port: 4000,
        },
        "full",
        accept,
      ),
    /at most 64/,
  );
  assert.deepEqual(inventory.list(), []);
  storage.sql.exec("DELETE FROM computer_exposed_ports");
  const owned = inventory.admit(
    {
      requestScope: "owner:fixture",
      requestId: mintComputerRequestId(),
      command: "sleep",
      port: 4000,
    },
    "owned",
    accept,
  ).process;
  storage.sql.exec(
    "UPDATE computer_exposed_ports SET process_id = NULL WHERE port = 4000",
  );
  inventory.exited(owned.id, 0);
  assert.deepEqual(
    storage.sql.exec("SELECT port FROM computer_exposed_ports").toArray(),
    [{ port: 4000 }],
  );
});

test("liveness observations never invent a state", async () => {
  const live = { getExec: async () => stream([], true) };
  assert.deepEqual(await observeProcess(live, "a"), { state: "running" });

  const output = {
    getExec: async () =>
      stream(
        [{ id: "a", seq: 1, name: "stdout", value: new Uint8Array([120]) }],
        true,
      ),
  };
  assert.deepEqual(await observeProcess(output, "a"), { state: "running" });

  // Both fakes reach real EOF within the deadline, so the drain itself
  // is the evidence: "synced", with no separate probe.
  const exitedLive = {
    getExec: async () => stream([{ id: "a", seq: 2, name: "exit", code: 3 }]),
  };
  assert.deepEqual(await observeProcess(exitedLive, "a"), {
    state: "exited",
    exitCode: 3,
    sync: "synced",
  });

  const finished = {
    getExec: async (_id, options) =>
      options.resume === "tail"
        ? stream([])
        : stream([
            { id: "a", seq: 1, name: "stdout", value: new Uint8Array([108]) },
            { id: "a", seq: 2, name: "exit", code: 7 },
          ]),
  };
  assert.deepEqual(await observeProcess(finished, "a"), {
    state: "exited",
    exitCode: 7,
    sync: "unknown",
  });

  const replaced = {
    getExec: async () => {
      throw Object.assign(new Error("lost"), { code: "EEXEC_LOST" });
    },
  };
  assert.deepEqual(await observeProcess(replaced, "a"), {
    state: "exited",
    exitCode: null,
    sync: "unknown",
  });

  const unclassifiedLost = {
    getExec: async () => {
      throw new Error("No exec record is retained");
    },
  };
  assert.deepEqual(await observeProcess(unclassifiedLost, "a"), {
    state: "uncertain",
  });

  const watched = {
    getExec: async () => {
      throw Object.assign(new Error("busy"), { code: "EEXEC_BUSY" });
    },
  };
  assert.deepEqual(
    await observeProcess(watched, "a"),
    { state: "running" },
    "the Computer's own watcher holding the subscriber proves it is live",
  );

  const unreachable = {
    getExec: async () => {
      throw new Error("Network connection lost.");
    },
  };
  assert.deepEqual(await observeProcess(unreachable, "a"), {
    state: "uncertain",
  });
  assert.ok(liveProbeMs <= 1_000, "a list stays interactive");
});

test("an exit seen on the tail attach still drains all the way to EOF before reporting synced", async () => {
  let reachedEof = false;
  let cancelledFirst = false;
  const runtime = {
    getExec: async () =>
      streamWithPull([{ id: "a", seq: 1, name: "exit", code: 5 }], {
        onEof: () => {
          reachedEof = true;
        },
        onCancel: () => {
          cancelledFirst = true;
        },
      }),
  };
  assert.deepEqual(await observeProcess(runtime, "a"), {
    state: "exited",
    exitCode: 5,
    sync: "synced",
  });
  assert.equal(
    cancelledFirst,
    false,
    "the stream must not be cancelled before its EOF read: that would skip computerd's post-command pull",
  );
  assert.equal(
    reachedEof,
    true,
    "observeProcess must actually have read the fake to its real EOF, not merely returned a plausible result",
  );
});

test("observeProcess reports pending, and does not hang, when a backgrounded child holds the transport open past its own exit", async () => {
  const runtime = {
    getExec: async () =>
      streamWithPull([{ id: "a", seq: 1, name: "exit", code: 0 }], {
        hangAfterEvents: true,
      }),
  };
  const started = Date.now();
  const observation = await observeProcess(runtime, "a");
  const elapsed = Date.now() - started;
  assert.equal(observation.state, "exited");
  assert.equal(observation.exitCode, 0);
  assert.equal(observation.sync, "pending");
  assert.ok(
    elapsed < postExitDrainDeadlineMs + 1_000,
    `observeProcess must give up at its own deadline instead of hanging on a stuck transport (took ${String(elapsed)}ms)`,
  );
});

test("observeProcess upgrades a pending exit to synced once a slow-but-real pull actually lands", async () => {
  let reachedEof = false;
  const runtime = {
    getExec: async () =>
      streamWithPull([{ id: "a", seq: 1, name: "exit", code: 0 }], {
        onEof: () => {
          reachedEof = true;
        },
        // Lands just after the synchronous deadline: this is the race
        // Storyboard Save would otherwise lose if "pending" were final.
        closeAfterMs: postExitDrainDeadlineMs + 300,
      }),
  };
  const started = Date.now();
  const observation = await observeProcess(runtime, "a");
  const elapsed = Date.now() - started;
  assert.equal(observation.state, "exited");
  assert.equal(observation.sync, "pending");
  assert.ok(
    elapsed < postExitDrainDeadlineMs + 200,
    `the synchronous return must not wait for the slow pull (took ${String(elapsed)}ms)`,
  );
  assert.ok(
    observation.settleLater !== undefined,
    "a pending verdict must hand back a way to learn the real outcome",
  );
  assert.equal(
    await observation.settleLater,
    "synced",
    "the background continuation must read the real EOF and confirm synced",
  );
  assert.equal(
    reachedEof,
    true,
    "the background continuation must actually have reached EOF, not merely returned a plausible result",
  );
});

test("drainProcessExit (the shared implementation ComputerDO#watchProcess calls) drains to EOF before reporting synced", async () => {
  let reachedEof = false;
  const run = streamWithPull([{ id: "a", seq: 1, name: "exit", code: 0 }], {
    onEof: () => {
      reachedEof = true;
    },
  });
  assert.deepEqual(await drainProcessExit(run), {
    exitCode: 0,
    sync: "synced",
  });
  assert.equal(
    reachedEof,
    true,
    "drainProcessExit must actually have read the fake to its real EOF, not merely returned a plausible result",
  );
});

test("drainProcessExit reports pending without hanging when its own stream's transport never closes", async () => {
  const run = streamWithPull([{ id: "a", seq: 1, name: "exit", code: 0 }], {
    hangAfterEvents: true,
  });
  const started = Date.now();
  const settled = await drainProcessExit(run);
  const elapsed = Date.now() - started;
  assert.equal(settled.exitCode, 0);
  assert.equal(settled.sync, "pending");
  assert.ok(
    elapsed < postExitDrainDeadlineMs + 1_000,
    `drainProcessExit must give up at its own deadline instead of hanging (took ${String(elapsed)}ms)`,
  );
});

test("drainProcessExit upgrades a pending exit to synced once a slow-but-real pull actually lands", async () => {
  let reachedEof = false;
  const run = streamWithPull([{ id: "a", seq: 1, name: "exit", code: 0 }], {
    onEof: () => {
      reachedEof = true;
    },
    closeAfterMs: postExitDrainDeadlineMs + 300,
  });
  const started = Date.now();
  const settled = await drainProcessExit(run);
  const elapsed = Date.now() - started;
  assert.equal(settled.exitCode, 0);
  assert.equal(settled.sync, "pending");
  assert.ok(elapsed < postExitDrainDeadlineMs + 200);
  assert.ok(settled.settleLater !== undefined);
  assert.equal(await settled.settleLater, "synced");
  assert.equal(reachedEof, true);
});

test("drainProcessExit reports nothing when the stream breaks before any exit is observed", async () => {
  const run = stream([{ id: "a", seq: 1, name: "stdout", value: "x" }]);
  assert.equal(await drainProcessExit(run), undefined);
});

test("a schema version mismatch resets computer_processes instead of a strict write throwing on an old row shape", () => {
  const storage = sqliteStorage();
  // A pre-launch Durable Object's table from before the `sync` column
  // existed. Pre-release data is disposable (no migrations before
  // launch): the constructor must reset this, not throw on first write.
  storage.transactionSync(() => {
    storage.sql.exec(
      "CREATE TABLE computer_processes (id TEXT PRIMARY KEY, request_scope TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT, port INTEGER, state TEXT NOT NULL CHECK (state IN ('running','exited')), exit_code INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER, CHECK ((state = 'running') = (ended_at IS NULL)), UNIQUE(request_scope, request_id)) STRICT",
    );
    storage.sql.exec(
      "INSERT INTO computer_processes (id, request_scope, request_id, input_hash, command, state, started_at) VALUES ('old-process', 'owner:old', 'old', 'old', 'legacy', 'running', 1)",
    );
  });
  const inventory = new ComputerProcessInventory(storage, clock());
  assert.equal(
    inventory.get("old-process"),
    undefined,
    "the mismatched table was reset, not preserved",
  );
  const fresh = inventory.admit(
    { requestScope: "owner:fresh", requestId: "fresh", command: "true" },
    "fresh",
    accept,
  ).process;
  assert.equal(fresh.sync, "unknown");
  assert.equal(inventory.exited(fresh.id, 0).sync, "unknown");
});

test("reopening a current-version table is not itself a reset", () => {
  const storage = sqliteStorage();
  const now = clock();
  const first = new ComputerProcessInventory(storage, now);
  const admitted = first.admit(
    { requestScope: "owner:fixture", requestId: "keep", command: "true" },
    "keep",
    accept,
  ).process;
  const reopened = new ComputerProcessInventory(storage, now);
  assert.deepEqual(
    reopened.get(admitted.id),
    admitted,
    "a matching schema version must not be rewritten on every reopen",
  );
});

test("PullPendingTracker is a faithful delegate for @cloudflare/computer's retryScheduler", async () => {
  const tracker = new PullPendingTracker();
  assert.equal(
    await tracker.scheduler.get("backend-a"),
    undefined,
    "no intent exists yet",
  );
  const intent = {
    backend: "backend-a",
    runtimeId: "runtime-1",
    attempt: 1,
    notBefore: Date.now(),
  };
  await tracker.scheduler.schedule(intent);
  assert.deepEqual(
    await tracker.scheduler.get("backend-a"),
    intent,
    "get() returns the real stored intent, not a stand-in: the library's own dedup and backoff (Workspace.retryPendingSync) depend on it",
  );
  assert.equal(
    await tracker.scheduler.get("backend-b"),
    undefined,
    "intents are per backend",
  );
  await tracker.scheduler.clear("backend-a");
  assert.equal(
    await tracker.scheduler.get("backend-a"),
    undefined,
    "clearing (a successful retryPendingSync) resolves it",
  );
});

console.log(JSON.stringify({ proof: "computer-process-inventory" }));
