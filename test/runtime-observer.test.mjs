/* global ReadableStream, TextEncoder */
import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const { WorkspaceRuntime } = await tsImport(
  "../../../forks/cloudflare-computer/src/runtime/runtime.ts",
  import.meta.url,
);

test("result observes the single drain with backpressure and retains output and sync statistics", async () => {
  const bytes = new TextEncoder().encode("building\n");
  const events = [
    { id: "build", seq: 1, name: "stdout", value: bytes },
    { id: "build", seq: 2, name: "stderr", value: bytes },
    { id: "build", seq: 3, name: "exit", code: 0 },
  ];
  let reads = 0;
  const backend = {
    exec: async () => ({
      id: "build",
      events: new ReadableStream(
        {
          pull(controller) {
            const event = events[reads++];
            if (event === undefined) controller.close();
            else controller.enqueue(event);
          },
        },
        { highWaterMark: 0 },
      ),
      sync: {
        pushed: 2,
        outcome: Promise.resolve({
          applied: 3,
          skipped: [],
          sync: { status: "complete", applied: 3, skipped: [] },
        }),
      },
    }),
  };
  const runtime = new WorkspaceRuntime({
    callableBackendIds: new Set(),
    backendHandle: async () => backend,
    resolveBackendId: () => "native",
  });
  using run = await runtime.exec("build", { encoding: "utf8" });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const observed = [];
  const result = run.result({
    onEvent: async (event) => {
      observed.push(event);
      if (event.seq === 1) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  try {
    // Settlement also releases the test on the old result-only implementation.
    await Promise.race([entered.promise, result]);
    assert.deepEqual(observed, [events[0]]);
    assert.equal(
      reads,
      1,
      "the observer must backpressure the existing reader",
    );
  } finally {
    release.resolve();
    await result;
  }
  assert.deepEqual(observed, events);
  assert.deepEqual(await result, {
    status: "completed",
    exitCode: 0,
    stdout: "building\n",
    stderr: "building\n",
    pushed: 2,
    pulled: 3,
    skipped: [],
    sync: { status: "complete", applied: 3, skipped: [] },
  });
});

test("a disconnected observer detaches without changing bytes, exit, or pending synchronization", async () => {
  const events = [
    {
      id: "build",
      seq: 1,
      name: "stdout",
      value: new Uint8Array([0xf0, 0x9f]),
    },
    { id: "build", seq: 2, name: "stderr", value: new Uint8Array([0, 255]) },
    {
      id: "build",
      seq: 3,
      name: "stdout",
      value: new Uint8Array([0x8c, 0xbf]),
    },
    { id: "build", seq: 4, name: "exit", code: 7, result: { answer: 42 } },
  ];
  const backend = {
    exec: async () => ({
      id: "build",
      events: new ReadableStream({
        start(controller) {
          for (const event of events) controller.enqueue(event);
          controller.close();
        },
      }),
      sync: {
        pushed: 2,
        outcome: Promise.resolve({
          applied: 0,
          skipped: [],
          sync: {
            status: "pending",
            applied: 0,
            skipped: [],
            error: "backend disconnected",
          },
        }),
      },
    }),
  };
  const runtime = new WorkspaceRuntime({
    callableBackendIds: new Set(),
    backendHandle: async () => backend,
    resolveBackendId: () => "native",
  });
  using plain = await runtime.exec("build");
  const expected = await plain.result();
  using observed = await runtime.exec("build");
  let notifications = 0;
  const result = await observed.result({
    onEvent: async () => {
      notifications++;
      throw new Error("Observer disconnected");
    },
  });
  assert.equal(notifications, 1);
  assert.deepEqual(result, expected);
  assert.deepEqual([...result.stdout], [0xf0, 0x9f, 0x8c, 0xbf]);
  assert.deepEqual([...result.stderr], [0, 255]);
  assert.equal(result.exitCode, 7);
  assert.deepEqual(result.value, { answer: 42 });
  assert.deepEqual(result.sync, {
    status: "pending",
    applied: 0,
    skipped: [],
    error: "backend disconnected",
  });
});
