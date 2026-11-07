/* global setImmediate */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import process from "node:process";
import {
  proofWorkers,
  stopProofWorker,
  waitForProofWorker,
} from "./proof-worker.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("reconstruction cannot proceed while the previous Worker is still alive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = new EventEmitter();
  server.exitCode = null;
  server.signalCode = null;
  server.stdout = { closed: false };
  server.stderr = { closed: false };
  server.pid = 123;
  server.kill = () => true;
  t.mock.method(process, "kill", () => true);
  let stopped = false;
  const stop = stopProofWorker(server, "wrangler").then(() => {
    stopped = true;
  });
  t.mock.timers.tick(3_001);
  await flush();
  assert.equal(stopped, false, "a deadline is not a process-exit signal");
  server.exitCode = 0;
  server.emit("exit", 0, null);
  await flush();
  assert.equal(
    stopped,
    false,
    "process exit alone does not close inherited pipes",
  );
  server.stdout.closed = true;
  server.stderr.closed = true;
  server.emit("close", 0, null);
  await stop;
  assert.equal(stopped, true);
});

test("a Worker that never closes fails within the bounded shutdown budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = new EventEmitter();
  server.exitCode = null;
  server.signalCode = null;
  server.stdout = { closed: false };
  server.stderr = { closed: false };
  server.pid = 123;
  const signals = [];
  t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(pid, -server.pid, "only the owned process group is stopped");
    signals.push(signal);
    return true;
  });
  const refused = assert.rejects(
    stopProofWorker(server, "wrangler"),
    /did not close after SIGKILL/,
  );
  t.mock.timers.tick(12_001);
  await flush();
  t.mock.timers.tick(12_001);
  await refused;
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("cold Wrangler bootstrap cannot consume the Worker response budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const server = new EventEmitter();
  server.exitCode = null;
  server.signalCode = null;
  let listening = false;
  t.mock.method(globalThis, "fetch", async () => {
    if (!listening) throw new Error("connection refused");
    return new globalThis.Response(null, { status: 404 });
  });
  let settled = false;
  const ready = waitForProofWorker(
    server,
    "http://127.0.0.1:1234",
    "wrangler",
  ).then((value) => {
    settled = true;
    return value;
  });
  await flush();
  t.mock.timers.tick(31_000);
  await flush();
  assert.equal(
    settled,
    false,
    "cold CLI preparation is not a failed Worker response",
  );
  listening = true;
  server.emit(
    "message",
    JSON.stringify({ event: "DEV_SERVER_READY", ip: "127.0.0.1", port: 1234 }),
  );
  assert.equal(await ready, true);
});

test("Wrangler's ready notification alone does not prove the Worker serves requests", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const server = new EventEmitter();
  server.exitCode = null;
  server.signalCode = null;
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("connection refused");
  });
  let settled = false;
  const ready = waitForProofWorker(
    server,
    "http://127.0.0.1:1234",
    "wrangler",
  ).then((value) => {
    settled = true;
    return value;
  });
  server.emit(
    "message",
    JSON.stringify({ event: "DEV_SERVER_READY", ip: "127.0.0.1", port: 1234 }),
  );
  await flush();
  assert.equal(settled, false);
  t.mock.timers.tick(31_000);
  await flush();
  assert.equal(
    await ready,
    false,
    "the existing response budget still bounds a broken Worker",
  );
});

test("Wrangler exiting before readiness refuses startup immediately", async () => {
  const server = new EventEmitter();
  server.exitCode = null;
  server.signalCode = null;
  const ready = waitForProofWorker(server, "http://127.0.0.1:1234", "wrangler");
  server.exitCode = 1;
  server.emit("exit", 1, null);
  assert.equal(await ready, false);
  assert.equal(server.listenerCount("message"), 0);
});

test("startup output survives a worker whose detached child keeps its pipes open", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = new EventEmitter();
  server.pid = 123;
  server.exitCode = null;
  server.signalCode = null;
  server.stdout = new EventEmitter();
  server.stderr = new EventEmitter();
  server.stdout.closed = false;
  server.stderr.closed = false;
  t.mock.method(childProcess, "spawn", () => server);
  t.mock.method(process, "kill", () => true);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const workers = await proofWorkers("startup-output");
  try {
    const starting = workers.start();
    // Port allocation is real, so wait for the captured child to be observed.
    while (server.stderr.listenerCount("data") === 0) await flush();
    server.stderr.emit("data", "Docker image compilation failed");
    server.exitCode = 1;
    server.emit("exit", 1, null);
    const refused = assert.rejects(starting, (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.equal(error.cause, error.errors[1]);
      assert.match(error.errors[0].message, /Docker image compilation failed/);
      assert.match(error.errors[1].message, /did not close after SIGKILL/);
      return true;
    });
    await flush();
    t.mock.timers.tick(12_001);
    await flush();
    t.mock.timers.tick(12_001);
    await refused;
  } finally {
    await workers.dispose();
  }
});
