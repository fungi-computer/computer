import { ReadableStream } from "node:stream/web";
import { workspaceStream } from "../dist/workspace-stream.js";
/* global btoa */
import assert from "node:assert/strict";
import test from "node:test";
import {
  attachedBackendId,
  attachedBackendsSchema,
  describeAttachedBackend,
  routeComputerBackend,
} from "../dist/computer-backends.js";

const container = { kind: "platform-container" };
const vm = { kind: "on-box-vm", hostId: "hel1" };
const laptop = {
  kind: "local",
  deviceId: "abcdefghijklmnop",
  publicKey: btoa("k".repeat(32)),
  hostLabel: "laptop",
  folderLabel: "project",
};
const desktop = { ...laptop, deviceId: "qrstuvwxyz234567" };
const online =
  (...ids) =>
  (id) =>
    ids.includes(id);

test("each attached backend has one stable Workspace id", () => {
  assert.deepEqual([container, vm, laptop].map(attachedBackendId), [
    "container",
    "vm-hel1",
    "local-abcdefghijklmnop",
  ]);
  assert.throws(() => attachedBackendsSchema.parse([container, container]));
  assert.deepEqual(attachedBackendsSchema.parse([]), []);
});

test("the default order prefers an online machine, then a VM, then the container", () => {
  const all = [container, vm, laptop, desktop];
  assert.equal(
    routeComputerBackend(all, online("local-qrstuvwxyz234567"), {
      need: "exec",
    }).id,
    "local-qrstuvwxyz234567",
  );
  // Offline machines are skipped: the command falls back to a hosted backend.
  assert.equal(
    routeComputerBackend(all, online(), { need: "exec" }).id,
    "vm-hel1",
  );
  assert.equal(
    routeComputerBackend([container, laptop], online(), { need: "exec" }).id,
    "container",
  );
  assert.deepEqual(routeComputerBackend([laptop], online(), { need: "exec" }), {
    kind: "no_backend",
  });
  assert.deepEqual(routeComputerBackend([], online(), { need: "exec" }), {
    kind: "no_backend",
  });
});

test("an explicit backend never falls back", () => {
  const all = [container, laptop];
  assert.equal(
    routeComputerBackend(all, online(), { backend: "container", need: "exec" })
      .id,
    "container",
  );
  assert.deepEqual(
    routeComputerBackend(all, online(), {
      backend: "local-abcdefghijklmnop",
      need: "exec",
    }),
    { kind: "backend_unavailable", id: "local-abcdefghijklmnop" },
  );
  assert.deepEqual(
    routeComputerBackend(all, online(), { backend: "vm-hel1", need: "exec" }),
    { kind: "backend_unavailable", id: "vm-hel1" },
  );
});

test("terminals, processes and ports route to hosted backends only", () => {
  assert.equal(
    routeComputerBackend(
      [laptop, container],
      online("local-abcdefghijklmnop"),
      { need: "hosted" },
    ).id,
    "container",
  );
  assert.deepEqual(
    routeComputerBackend([laptop], online("local-abcdefghijklmnop"), {
      need: "hosted",
    }),
    { kind: "no_backend" },
  );
});

test("a backend reports its live status and labels, never its key", () => {
  assert.deepEqual(describeAttachedBackend(laptop, true), {
    id: "local-abcdefghijklmnop",
    kind: "local",
    status: "online",
    hostLabel: "laptop",
    folderLabel: "project",
  });
  assert.equal(describeAttachedBackend(laptop, false).status, "offline");
  assert.equal(describeAttachedBackend(vm, false).status, "ready");
});

test("Workspace reads object chunks from an asynchronously acquired remote stream", async () => {
  const remote = Promise.withResolvers();
  const stream = workspaceStream(remote.promise);
  const reader = stream.getReader();
  const pending = reader.read();
  const chunk = { hash: new Uint8Array([1]), bytes: new Uint8Array([2, 3]) };
  remote.resolve(
    new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    }),
  );
  assert.deepEqual(await pending, { done: false, value: chunk });
  assert.equal((await reader.read()).done, true);
  reader.releaseLock();
});

test("Workspace cancellation reaches the remote stream and releases its reader", async () => {
  const reason = new Error("Workspace closed");
  let cancelled;
  const remote = new ReadableStream({
    cancel(cause) {
      cancelled = cause;
    },
  });
  const stream = workspaceStream(Promise.resolve(remote));
  await stream.cancel(reason);
  assert.equal(cancelled, reason);
  assert.equal(remote.locked, false);
});

test("Workspace stream acquisition and read failures retain their original cause", async () => {
  const failure = new Error("remote unavailable");
  for (const remote of [
    Promise.reject(failure),
    Promise.resolve(
      new ReadableStream({
        pull() {
          throw failure;
        },
      }),
    ),
  ]) {
    const reader = workspaceStream(remote).getReader();
    try {
      await assert.rejects(reader.read(), (cause) => cause === failure);
    } finally {
      reader.releaseLock();
    }
  }
});
