/* global console */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { v7 } from "uuid";

import { computerRequestIdSchema } from "../dist/operation-contract.js";
import {
  ComputerOperationConflictError,
  ComputerOperationLimitError,
  ComputerOperationRecord,
  ComputerRequestInvalidError,
  maximumOperationRecords,
  operationAdmissionWindowMs,
  operationOutputRetentionMs,
  operationRetentionMs,
} from "../dist/operation-record.js";

const minute = 60 * 1_000;
const start = Date.UTC(2026, 8, 25, 12);
const output = {
  status: "completed",
  exitCode: 0,
  stdout: "ran",
  stderr: "",
  truncated: false,
};

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
        return { toArray: () => rows };
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

function owner() {
  const clock = { now: start };
  const storage = sqliteStorage();
  const runs = [];
  const open = () => new ComputerOperationRecord(storage, () => clock.now);
  let record = open();
  return {
    clock,
    runs,
    get record() {
      return record;
    },
    reopen() {
      record = open();
    },
    /** The Computer's dispatch sequence for one host request. */
    execute(requestId, inputHash = "same-input") {
      const recorded = record.admit(requestId, inputHash, () => undefined);
      if (recorded !== undefined) return recorded;
      record.markRunning(requestId);
      runs.push(requestId);
      record.settle(requestId, output);
      return record.status(requestId, () => undefined);
    },
  };
}

/** A host-minted UUIDv7 as seen from a host clock offset from the owner. */
function hostId(clockMs) {
  return computerRequestIdSchema.parse(v7({ msecs: clockMs }));
}

test("host retry of the same invocation dedupes to one dispatch", () => {
  const computer = owner();
  const requestId = hostId(computer.clock.now);
  const first = computer.execute(requestId);
  computer.clock.now += 1_000;
  const retry = computer.execute(requestId);
  assert.deepEqual(computer.runs, [requestId]);
  assert.equal(first.status, "succeeded");
  assert.deepEqual(retry, first);
  assert.throws(
    () => computer.execute(requestId, "other-input"),
    ComputerOperationConflictError,
  );
  assert.deepEqual(computer.runs, [requestId]);
});

test("a fresh invocation of the same command dispatches again", () => {
  const computer = owner();
  computer.execute(hostId(computer.clock.now));
  computer.execute(hostId(computer.clock.now));
  assert.equal(computer.runs.length, 2);
});

test("an unseen ID outside the owner's window expires or is invalid", () => {
  const computer = owner();
  const stale = hostId(start - operationAdmissionWindowMs - 1);
  assert.deepEqual(computer.execute(stale), {
    requestId: stale,
    status: "expired",
    output: null,
  });
  assert.throws(
    () => computer.execute(hostId(start + operationAdmissionWindowMs + 1)),
    ComputerRequestInvalidError,
  );
  assert.deepEqual(computer.runs, []);
});

test("a fast-clock caller cannot make correctly clocked commands expire", () => {
  const computer = owner();
  const fastId = hostId(start + 4 * minute);
  computer.execute(fastId);
  for (let index = 1; index < maximumOperationRecords; index += 1) {
    computer.clock.now = start + index;
    computer.execute(hostId(computer.clock.now));
  }
  // Every record is now outside the window by acceptance time, but the fast
  // record's ID is still inside it, so capacity evicts correct records first.
  computer.clock.now = start + 6 * minute;
  for (let index = 0; index < 10; index += 1) {
    computer.clock.now += 1;
    const correct = hostId(computer.clock.now);
    assert.equal(computer.execute(correct).status, "succeeded");
    assert.equal(computer.runs.at(-1), correct);
  }
  assert.equal(computer.execute(fastId).status, "succeeded");
  assert.equal(computer.runs.filter((id) => id === fastId).length, 1);

  // Once the fast ID leaves the window it is the oldest evictable record; its
  // retry expires, and correctly clocked callers keep running.
  computer.clock.now = start + 10 * minute;
  computer.execute(hostId(computer.clock.now));
  assert.equal(computer.execute(fastId).status, "expired");
  assert.equal(computer.runs.filter((id) => id === fastId).length, 1);
  const after = hostId(computer.clock.now);
  assert.equal(computer.execute(after).status, "succeeded");
  assert.equal(computer.runs.at(-1), after);
});

test("capacity held by in-window records refuses new work visibly", () => {
  const computer = owner();
  for (let index = 0; index < maximumOperationRecords; index += 1) {
    computer.clock.now = start + index;
    computer.execute(hostId(computer.clock.now));
  }
  const refused = hostId(computer.clock.now);
  assert.throws(() => computer.execute(refused), ComputerOperationLimitError);
  assert.equal(
    computer.record.status(refused, () => undefined).status,
    "unknown",
  );
});

test("reopening records unfinished work as unknown without rerunning it", () => {
  const computer = owner();
  const requestId = hostId(start);
  assert.equal(
    computer.record.admit(requestId, "same-input", () => undefined),
    undefined,
  );
  computer.record.markRunning(requestId);
  computer.reopen();
  assert.equal(computer.execute(requestId).status, "unknown");
  assert.deepEqual(computer.runs, []);
});

test("an uncertain failure records unknown and logs its cause", (t) => {
  const logged = t.mock.method(console, "error", () => undefined);
  const computer = owner();
  const requestId = hostId(start);
  computer.record.admit(requestId, "same-input", () => undefined);
  computer.record.markRunning(requestId);
  computer.record.settleUnknown(requestId, "Error: container start failed");
  assert.equal(computer.execute(requestId).status, "unknown");
  assert.deepEqual(computer.runs, []);
  assert.equal(logged.mock.callCount(), 1);
  assert.deepEqual(logged.mock.calls[0].arguments[1], {
    requestId,
    cause: "Error: container start failed",
  });
});

test("output clears after 24 hours and status expires after 7 days", () => {
  const computer = owner();
  const requestId = hostId(start);
  computer.execute(requestId);
  computer.clock.now = start + operationOutputRetentionMs;
  assert.deepEqual(computer.execute(requestId), {
    requestId,
    status: "succeeded",
    output: null,
  });
  computer.clock.now = start + operationRetentionMs;
  assert.equal(computer.execute(requestId).status, "expired");
  assert.deepEqual(computer.runs, [requestId]);
});

console.log(
  JSON.stringify({ proof: "computer-operation-record", verdict: "run" }),
);
