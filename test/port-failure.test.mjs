/* global Request, Response */
import assert from "node:assert/strict";
import { test } from "node:test";
import { portPreviewReply } from "../dist/port-failure.js";

const document = new Request("http://localhost/", {
  headers: { "sec-fetch-dest": "document" },
});
const refusal = (status, reason) =>
  new Response(JSON.stringify({ error: reason }), {
    status,
    headers: { "x-fungi-port-failure": reason },
  });

test("vmd's not-running answer becomes a plain-words page, never its raw body", async () => {
  const reply = await portPreviewReply(
    refusal(503, "not_running"),
    document,
    5173,
  );
  assert.equal(reply.status, 503);
  assert.equal(reply.headers.get("cache-control"), "no-store");
  const text = await reply.text();
  assert.ok(text.startsWith("<!doctype html>"));
  assert.ok(text.includes("This Computer is asleep"));
  assert.ok(text.includes("Start it from Fungi"));
  assert.ok(!text.includes("not_running"));
});

test("a port nothing answers on names the port; a script gets the reason as data", async () => {
  const page = await portPreviewReply(
    refusal(502, "not_listening"),
    document,
    5173,
  );
  assert.ok((await page.text()).includes("Nothing is answering on port 5173"));
  const data = await portPreviewReply(
    refusal(502, "not_listening"),
    new Request("http://localhost/api"),
    5173,
  );
  assert.equal(data.status, 502);
  assert.deepEqual(await data.json(), { error: "not_listening" });
});

test("a guest's own reply passes unchanged except for cookies; an unknown reason is the guest's", async () => {
  const own = await portPreviewReply(
    new Response("guest says bad gateway", {
      status: 502,
      headers: { "set-cookie": "a=b", "x-guest": "1" },
    }),
    document,
    5173,
  );
  assert.equal(own.status, 502);
  assert.equal(own.headers.get("set-cookie"), null);
  assert.equal(own.headers.get("x-guest"), "1");
  assert.equal(await own.text(), "guest says bad gateway");
  const unknown = await portPreviewReply(
    new Response("x", {
      status: 500,
      headers: { "x-fungi-port-failure": "exploded" },
    }),
    document,
    5173,
  );
  assert.equal(await unknown.text(), "x");
});

test("an upgrade request never reads the refusal header, which the guest could have written", async () => {
  // vmd pipes an upgrade's bytes raw, so the guest controls every header.
  const forged = await portPreviewReply(
    new Response("guest text", {
      status: 503,
      headers: { "x-fungi-port-failure": "not_running" },
    }),
    new Request("http://localhost/socket", {
      headers: { "sec-fetch-dest": "document", upgrade: "websocket" },
    }),
    5173,
  );
  assert.equal(forged.status, 503);
  assert.equal(await forged.text(), "guest text");
});

test("a guest that reset before replying reads as a Computer Fungi couldn't reach", async () => {
  const reply = await portPreviewReply(
    refusal(502, "unreachable"),
    document,
    5173,
  );
  assert.equal(reply.status, 502);
  assert.match(
    await reply.text(),
    /Fungi couldn(?:'|&#39;)t reach this Computer/u,
  );
});
