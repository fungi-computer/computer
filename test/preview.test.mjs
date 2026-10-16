/* global Request, Response */
import { URL } from "node:url";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import * as Schema from "effect/Schema";
import {
  ComputerPortPreview,
  computerPortPreviewRequest,
} from "../dist/preview.js";

function fixture(t) {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const secrets = new Map();
  let admitted = true;
  let exposed = true;
  const preview = new ComputerPortPreview(
    {
      sql: fromNodeSqlite(database).sql,
      get: async (key) => secrets.get(key),
      put: async (key, value) => {
        secrets.set(key, value);
      },
    },
    {
      selector: Schema.Struct({ app: Schema.String }),
      previewUrl: (signature, domain) =>
        `https://target-${signature}.${domain}/`,
      accept: () => {
        if (!admitted) throw new Error("denied");
      },
      listPorts: async (accept) => {
        accept();
        return { ports: exposed ? [5173] : [] };
      },
      forward: async (port, request, accept) => {
        if (!exposed) return new Response(null, { status: 404 });
        accept();
        return new Response(`${port}:${new URL(request.url).pathname}`);
      },
      portDenied: () => {
        throw new Error("unexposed");
      },
      dispatchFailure: (error) => {
        if (error.message === "denied")
          return new Response(null, { status: 403 });
        throw error;
      },
      invalidClaims: () => {
        throw new Error("unexpected schema drift");
      },
    },
  );
  return {
    preview,
    database,
    revoke: () => {
      admitted = false;
    },
    unexpose: () => {
      exposed = false;
    },
  };
}

test("signed ticket dispatch rechecks admission and exposure; expiry and tampering refuse", async (t) => {
  const f = fixture(t);
  const ticket = await f.preview.issueAfterAcceptance(
    { app: "shed" },
    5173,
    "ports.test",
  );
  const signature = new URL(ticket.previewUrl).hostname
    .split("-")[1]
    .split(".")[0];
  const request = new Request(
    `https://computer.test/__port_preview/${signature}/hello?q=1`,
  );
  const dispatch = () =>
    f.preview.route(request, (sig, service) =>
      f.preview.dispatchSigned(sig, service, (selector, port, forwarded) =>
        f.preview.dispatch(selector, port, forwarded),
      ),
    );
  assert.equal(await (await dispatch()).text(), "5173:/hello");
  f.revoke();
  assert.equal((await dispatch()).status, 403);
  f.unexpose();
  assert.equal((await dispatch()).status, 404);
  f.database
    .prepare(
      "UPDATE computer_port_preview_tickets SET claims=? WHERE signature=?",
    )
    .run("{}", signature);
  assert.equal((await dispatch()).status, 403);
  const expired = await f.preview.issue({ app: "expired" }, 5173, "ports.test");
  const expiredSignature = new URL(expired.previewUrl).hostname
    .split("-")[1]
    .split(".")[0];
  f.database
    .prepare(
      "UPDATE computer_port_preview_tickets SET expires_at=0 WHERE signature=?",
    )
    .run(expiredSignature);
  assert.equal(await f.preview.resolve(expiredSignature), null);
  assert.equal(
    await f.preview.route(new Request("https://computer.test/hello"), () => {
      throw new Error("unexpected dispatch");
    }),
    null,
  );
});

test("unexposed ports cannot receive tickets and ticket storage stays bounded", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.preview.issueAfterAcceptance({ app: "shed" }, 5174, "ports.test"),
    /unexposed/,
  );
  for (let i = 0; i < 260; i++)
    await f.preview.issue({ app: `shed${i}` }, 5173, "ports.test");
  assert.equal(
    f.database
      .prepare("SELECT count(*) AS count FROM computer_port_preview_tickets")
      .get().count,
    256,
  );
});

test("isolated host routing preserves signed path and query and handles forwarding failure", async () => {
  let forwarded;
  const host = {
    suffix: (domain) => `.${domain}`,
    target: (hostname) =>
      hostname === "target.ports.test"
        ? { computerId: "computer_target", signature: "a".repeat(20) }
        : null,
    forward: async (computerId, request) => {
      forwarded = { computerId, url: request.url };
      return new Response("preview");
    },
  };
  const request = new Request("https://target.ports.test/hello?q=1");
  assert.equal(
    await (
      await computerPortPreviewRequest(request, "ports.test", host)
    ).text(),
    "preview",
  );
  assert.deepEqual(forwarded, {
    computerId: "computer_target",
    url: `https://target.ports.test/__port_preview/${"a".repeat(20)}/hello?q=1`,
  });
  assert.equal(await computerPortPreviewRequest(request, null, host), null);
  assert.equal(
    await computerPortPreviewRequest(
      new Request("http://target.ports.test/"),
      "ports.test",
      host,
    ),
    null,
  );
  assert.equal(
    (
      await computerPortPreviewRequest(
        new Request("https://bad.ports.test/"),
        "ports.test",
        host,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await computerPortPreviewRequest(request, "ports.test", {
        ...host,
        forward: async () => {
          throw new Error("offline");
        },
      })
    ).status,
    503,
  );
});
