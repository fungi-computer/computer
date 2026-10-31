/* global setImmediate */
import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const { waitForNativeHandle } = await tsImport(
  "./native-readiness.ts",
  import.meta.url,
);
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("native readiness waits for the SDK receipt beyond the former polling deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const received = Promise.withResolvers();
  const settled = Promise.withResolvers();
  let ready = false;
  const waiting = waitForNativeHandle(received.promise, settled.promise).then(
    () => {
      ready = true;
    },
  );
  t.mock.timers.tick(180_000);
  await flush();
  assert.equal(
    ready,
    false,
    "elapsed time cannot manufacture native readiness",
  );
  received.resolve();
  await waiting;
  assert.equal(ready, true);
});

test("native readiness fails when execution settles without an SDK receipt", async () => {
  const received = Promise.withResolvers();
  const settled = Promise.withResolvers();
  const refused = assert.rejects(
    waitForNativeHandle(received.promise, settled.promise),
    /Execution settled before a native SDK handle arrived/,
  );
  settled.resolve();
  await refused;
});

test("native readiness propagates dispatch rejection instead of hanging", async () => {
  const received = Promise.withResolvers();
  const settled = Promise.withResolvers();
  const failure = new Error("Native backend refused dispatch");
  const refused = assert.rejects(
    waitForNativeHandle(received.promise, settled.promise),
    (cause) => cause === failure,
  );
  settled.reject(failure);
  await refused;
});

test("an already received native handle remains ready after execution settles", async () => {
  await waitForNativeHandle(Promise.resolve(), Promise.resolve());
});
