import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { maximumProcessLogLines } from "@fungi.computer/computer-contract";
import {
  ComputerProcessInventory,
  ProcessLogTail,
  waitForProcessExit,
} from "../dist/process-inventory.js";

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

/** A fake clock whose sleep advances it, so a 15-minute job takes no real time. */
function fakeClock() {
  let now = 1_800_000_000_000;
  return {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

const minute = 60_000;

function background(clock) {
  const inventory = new ComputerProcessInventory(sqliteStorage(), clock.now);
  const process = inventory.admit(
    "container",
    {
      requestScope: "tool:agent:a",
      requestId: "fifteen-minute-job",
      command: "make everything",
    },
    "hash",
    () => undefined,
  ).process;
  return { inventory, id: process.id };
}

const waitFor = (inventory, id, clock, timeoutMs) =>
  waitForProcessExit({
    read: () => inventory.get(id),
    observe: (row) => Promise.resolve(row),
    now: clock.now,
    sleep: clock.sleep,
    timeoutMs,
  });

test("a 15-minute background job shows partial output, finishes, and stays readable", async () => {
  const clock = fakeClock();
  const { inventory, id } = background(clock);
  const tail = new ProcessLogTail();

  // Five minutes in: output so far is readable while the job still runs.
  tail.push("step 1 done\nstep 2 done\n");
  inventory.setLog(id, tail.snapshot());
  clock.advance(5 * minute);
  assert.deepEqual(inventory.logOf(id)?.lines, ["step 1 done", "step 2 done"]);
  assert.equal(inventory.get(id)?.state, "running");

  // A wait shorter than the job reports it still running, without ending it.
  const early = await waitFor(inventory, id, clock, 5 * minute);
  assert.equal(early.timedOut, true);
  assert.equal(early.process.state, "running");

  // The job ends at 15 minutes. A fresh wait now returns at once with the
  // exit code, and the full tail stays readable afterwards.
  tail.push("step 3 done\n");
  inventory.setLog(id, tail.snapshot());
  clock.advance(10 * minute);
  inventory.exited(id, 0, "synced");
  const before = clock.now();
  const done = await waitFor(inventory, id, clock, 10 * minute);
  assert.equal(done.timedOut, false);
  assert.deepEqual([done.process.state, done.process.exitCode], ["exited", 0]);
  assert.equal(clock.now(), before, "an ended job costs no waiting");
  assert.deepEqual(inventory.logOf(id)?.lines, [
    "step 1 done",
    "step 2 done",
    "step 3 done",
  ]);
});

test("a wait ends the moment the watcher records the exit", async () => {
  const clock = fakeClock();
  const { inventory, id } = background(clock);
  let sleeps = 0;
  const done = await waitForProcessExit({
    read: () => inventory.get(id),
    observe: (row) => Promise.resolve(row),
    now: clock.now,
    sleep: async (ms) => {
      sleeps += 1;
      await clock.sleep(ms);
      if (sleeps === 3) inventory.exited(id, 7);
    },
    timeoutMs: 10 * minute,
  });
  assert.equal(done.timedOut, false);
  assert.equal(done.process.exitCode, 7);
  assert.equal(sleeps, 3);
});

test("a lost watcher cannot hold a wait open: the owner is asked every tenth poll", async () => {
  const clock = fakeClock();
  const { inventory, id } = background(clock);
  let observed = 0;
  const done = await waitForProcessExit({
    read: () => inventory.get(id),
    observe: (row) => {
      observed += 1;
      return Promise.resolve(inventory.exited(row.id, null));
    },
    now: clock.now,
    sleep: clock.sleep,
    timeoutMs: 10 * minute,
  });
  assert.equal(observed, 1);
  assert.equal(done.process.state, "exited");
  assert.equal(done.timedOut, false);
});

test("output stays bounded for a long job", () => {
  const tail = new ProcessLogTail();
  for (let line = 0; line < 5_000; line += 1)
    tail.push(`line ${String(line)}\n`);
  const snapshot = tail.snapshot();
  assert.equal(snapshot.lines.length, maximumProcessLogLines);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.lines.at(-1), "line 4999");
});
