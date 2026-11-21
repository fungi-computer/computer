/* global Request, Response */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  declaredPortWaitMs,
  forwardPreviewWaitingForPort,
} from "../dist/preview-wait.js";

const web = { name: "web", port: 3000 };
const notListening = () =>
  new Response(JSON.stringify({ error: "not_listening" }), {
    status: 502,
    headers: { "x-fungi-port-failure": "not_listening" },
  });
const document = () =>
  new Request("http://localhost/", {
    headers: { "sec-fetch-dest": "document" },
  });

/** A clock the test moves: each delay advances it, so no real time passes. */
function clock() {
  const state = { at: 0, delays: [] };
  return {
    state,
    now: () => state.at,
    delay: (ms) => {
      state.delays.push(ms);
      state.at += ms;
      return Promise.resolve();
    },
  };
}

test("waits for a declared port to open after a wake, then answers with the service's own reply", async () => {
  const time = clock();
  let attempts = 0;
  const reply = await forwardPreviewWaitingForPort({
    service: web,
    port: 3000,
    request: document(),
    attempt: () => {
      attempts += 1;
      return Promise.resolve(
        attempts < 4 ? notListening() : new Response("hello", { status: 200 }),
      );
    },
    ...time,
  });
  assert.equal(reply.status, 200);
  assert.equal(await reply.text(), "hello");
  assert.equal(attempts, 4);
  assert.ok(time.state.at < declaredPortWaitMs);
});

test("a declared port that never opens says so once, naming the service and port", async () => {
  const time = clock();
  let attempts = 0;
  const reply = await forwardPreviewWaitingForPort({
    service: web,
    port: 3000,
    request: document(),
    attempt: () => {
      attempts += 1;
      return Promise.resolve(notListening());
    },
    ...time,
  });
  assert.equal(declaredPortWaitMs, 20_000);
  assert.equal(time.state.at, 20_000);
  assert.ok(attempts > 2 && attempts < 100);
  assert.equal(reply.status, 504);
  const page = await reply.text();
  assert.ok(page.includes("web didn&#39;t open port 3000 within 20 s"));
  const script = await forwardPreviewWaitingForPort({
    service: web,
    port: 3000,
    request: new Request("http://localhost/api"),
    attempt: () => Promise.resolve(notListening()),
    ...clock(),
  });
  assert.deepEqual(await script.json(), {
    error: "service_timeout",
    message: "web didn't open port 3000 within 20 s",
  });
});

test("a port no service declares is answered at once, never waited for", async () => {
  const time = clock();
  let attempts = 0;
  const reply = await forwardPreviewWaitingForPort({
    service: undefined,
    port: 3000,
    request: document(),
    attempt: () => {
      attempts += 1;
      return Promise.resolve(notListening());
    },
    ...time,
  });
  assert.equal(attempts, 1);
  assert.equal(time.state.at, 0);
  assert.equal(reply.status, 502);
  assert.ok((await reply.text()).includes("Nothing is answering on port"));
});

test("a request with a body, or an upgrade, is tried once: it cannot be replayed", async () => {
  for (const request of [
    new Request("http://localhost/", { method: "POST", body: "x" }),
    new Request("http://localhost/", { headers: { upgrade: "websocket" } }),
  ]) {
    const time = clock();
    let attempts = 0;
    await forwardPreviewWaitingForPort({
      service: web,
      request,
      port: 3000,
      attempt: () => {
        attempts += 1;
        return Promise.resolve(notListening());
      },
      ...time,
    });
    assert.equal(attempts, 1);
    assert.equal(time.state.at, 0);
  }
});

test("the service's own error reply is returned as it is, never mistaken for a closed port", async () => {
  const time = clock();
  let attempts = 0;
  const reply = await forwardPreviewWaitingForPort({
    service: web,
    port: 3000,
    request: document(),
    attempt: () => {
      attempts += 1;
      return Promise.resolve(new Response("boom", { status: 502 }));
    },
    ...time,
  });
  assert.equal(attempts, 1);
  assert.equal(reply.status, 502);
  assert.equal(await reply.text(), "boom");
});

test("an unreachable Computer keeps trying until the limit and then fails with its own error, not a missing port", async () => {
  const time = clock();
  const cause = new Error("connect failed");
  await assert.rejects(
    forwardPreviewWaitingForPort({
      service: web,
      port: 3000,
      request: new Request("http://localhost/api"),
      attempt: () => Promise.reject(cause),
      ...time,
    }),
    cause,
  );
  assert.equal(time.state.at, 20_000);
});
