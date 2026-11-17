import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { after, before, test } from "node:test";
import { unstable_dev } from "wrangler";

let worker;
let temporary;
let sequence = 0;
before(async () => {
  const area = fileURLToPath(new URL("../../../.botanical/", import.meta.url));
  await mkdir(area, { recursive: true });
  temporary = await mkdtemp(`${area}port-access-`);
  const main = fileURLToPath(
    new URL("./port-access.worker.ts", import.meta.url),
  );
  const config = `${temporary}/wrangler.json`;
  await writeFile(
    config,
    JSON.stringify({
      name: "computer-port-access-proof",
      main,
      compatibility_date: "2026-09-02",
      compatibility_flags: ["nodejs_compat"],
      durable_objects: {
        bindings: [{ name: "HOST", class_name: "PortAccessProof" }],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["PortAccessProof"] }],
    }),
  );
  worker = await unstable_dev(main, {
    config,
    local: true,
    ip: "127.0.0.1",
    port: 0,
    logLevel: "none",
    persist: false,
    experimental: {
      disableExperimentalWarning: true,
      disableDevRegistry: true,
    },
  });
});
after(async () => {
  if (worker) await worker.stop();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

async function fixture() {
  const id = `computer-${++sequence}`;
  const call = (path, headers = {}) =>
    worker.fetch(path, {
      headers: { ...headers, "x-test-computer": id },
      redirect: "manual",
    });
  const rows = await (await call("/seed")).json();
  const issue = async () => (await (await call("/issue")).json()).token;
  return { call, rows, issue };
}
function cookie(response) {
  return response.headers.get("set-cookie").split(";")[0];
}

test("issuance rechecks admission and exposure, caps pending tokens, and reclaims expired capacity", async () => {
  const f = await fixture();
  assert.equal((await f.call("/issue?deny=yes")).status, 409);
  assert.equal((await f.call("/issue?port=5555")).status, 409);
  for (let count = 0; count < 64; count++)
    assert.equal((await f.call("/issue")).status, 200);
  assert.equal((await f.call("/issue")).status, 409);
  await f.call("/advance?ms=300000");
  assert.equal((await f.call("/issue")).status, 200);
  assert.equal((await (await f.call("/state")).json()).tokens.length, 1);
});

test("old exposure rows migrate to private without losing process ownership; reopening is idempotent", async () => {
  const f = await fixture();
  assert.deepEqual(f.rows, [
    {
      port: 5173,
      process_id: "retained-process",
      visibility: "private",
      share_token_hash: null,
    },
    {
      port: 5174,
      process_id: null,
      visibility: "private",
      share_token_hash: null,
    },
  ]);
  assert.equal((await f.call("/page")).status, 401);
  assert.equal((await f.call("/page")).status, 401);
});

test("concurrent one-time exchange creates exactly one session and strips only token", async () => {
  const f = await fixture();
  const token = await f.issue();
  const path = `/deep/page?keep=one&token=${token}&keep=two&t=unrelated`;
  const replies = await Promise.all([f.call(path), f.call(path)]);
  assert.deepEqual(replies.map((r) => r.status).sort(), [302, 401]);
  const success = replies.find((r) => r.status === 302);
  const target = new URL(success.headers.get("location"));
  assert.equal(target.pathname, "/deep/page");
  assert.equal(target.searchParams.has("token"), false);
  assert.deepEqual(target.searchParams.getAll("keep"), ["one", "two"]);
  assert.equal(target.searchParams.get("t"), "unrelated");
  const attributes = success.headers.get("set-cookie");
  assert.match(attributes, /^__Host-fungi-port=/);
  for (const flag of [
    "HttpOnly",
    "Secure",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=3600",
  ])
    assert.ok(attributes.includes(flag));
  assert.equal(attributes.includes("Domain="), false);
  assert.equal((await f.call(path)).status, 401);
  const state = await (await f.call("/state")).json();
  assert.equal(state.tokens.length, 0);
  assert.equal(state.sessions.length, 1);
  assert.match(state.sessions[0].session_hash, /^[0-9a-f]{64}$/);
  assert.equal(
    (await f.call("/asset.js", { cookie: cookie(success) })).status,
    200,
  );
});

test("refuses same-site sibling or malformed Origin/Referer before exchange; same-origin, absent and cross-site pass", async () => {
  const f = await fixture();
  const token = await f.issue();
  const sibling = "https://sibling.preview.test";
  const refused = [
    { origin: sibling },
    { referer: `${sibling}/page` },
    { origin: "https://preview.test:8443" },
    { origin: "http://preview.test" },
    { origin: "https://preview.test", referer: `${sibling}/page` },
    { origin: "https://foreign.example", referer: `${sibling}/` },
    { origin: "null" },
    { origin: "https://" },
    { referer: "not a url" },
  ];
  for (const headers of refused)
    assert.equal(
      (await f.call(`/page?token=${token}`, headers)).status,
      401,
      JSON.stringify(headers),
    );
  // Refusal happened before exchange: the one-time token still works.
  const exchanged = await f.call(`/page?token=${token}`, {
    referer: "https://preview.test/start",
  });
  assert.equal(exchanged.status, 302);
  for (const headers of refused)
    assert.equal(
      (await f.call("/asset.js", { ...headers, cookie: cookie(exchanged) }))
        .status,
      401,
      JSON.stringify(headers),
    );
  for (const headers of [
    {},
    { origin: "https://preview.test" },
    { origin: "https://preview.test", referer: "https://preview.test/a" },
    { origin: "https://foreign.example" },
    { referer: "https://foreign.example/link" },
  ])
    assert.equal(
      (await f.call("/asset.js", { ...headers, cookie: cookie(exchanged) }))
        .status,
      200,
      JSON.stringify(headers),
    );
  const upgrade = await f.call("/websocket-proof", {
    cookie: cookie(exchanged),
    origin: "https://preview.test",
    referer: `${sibling}/`,
  });
  assert.deepEqual(await upgrade.json(), {
    status: 401,
    socket: false,
    cookie: false,
  });
});

test("tokens and sessions bind to one Computer and port, expire without sliding, and store only hashes", async () => {
  const f = await fixture();
  const other = await fixture();
  const token = await f.issue();
  const state = await (await f.call("/state")).json();
  assert.match(state.tokens[0].token_hash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(state).includes(token), false);
  assert.equal((await f.call(`/page?port=5174&token=${token}`)).status, 401);
  assert.equal((await other.call(`/page?token=${token}`)).status, 401);
  const response = await f.call(`/page?token=${token}`);
  const headers = { cookie: cookie(response) };
  assert.equal((await f.call("/page?port=5174", headers)).status, 401);
  assert.equal((await other.call("/page", headers)).status, 401);
  await f.call("/advance?ms=3599999");
  assert.equal((await f.call("/page", headers)).status, 200);
  await f.call("/advance?ms=1");
  assert.equal((await f.call("/page", headers)).status, 401);
  const expiring = await f.issue();
  await f.call("/advance?ms=300000");
  assert.equal((await f.call(`/page?token=${expiring}`)).status, 401);
});

test("unexpose revokes tokens and sessions even after re-exposure", async () => {
  const f = await fixture();
  const response = await f.call(`/page?token=${await f.issue()}`);
  const pending = await f.issue();
  await f.call("/remove");
  assert.deepEqual(await (await f.call("/state")).json(), {
    tokens: [],
    sessions: [],
  });
  await f.call("/reexpose");
  assert.equal(
    (await f.call("/page", { cookie: cookie(response) })).status,
    401,
  );
  assert.equal((await f.call(`/page?token=${pending}`)).status, 401);
});

test("WebSocket admission preserves service tokens and requires a session", async () => {
  const f = await fixture();
  assert.deepEqual(
    await (
      await f.call("/websocket-proof?token=service-websocket-token", {
        origin: "https://preview.test",
      })
    ).json(),
    {
      status: 401,
      socket: false,
      cookie: false,
    },
  );
  const response = await f.call(`/page?token=${await f.issue()}`);
  assert.deepEqual(
    await (
      await f.call("/websocket-proof?token=service-websocket-token", {
        origin: "https://preview.test",
        cookie: cookie(response),
      })
    ).json(),
    { status: 101, socket: true, cookie: false },
  );
});

test("unlisted subresources use the session; reset and private visibility revoke prior access", async () => {
  const f = await fixture();
  const { share } = await (await f.call("/visibility?value=unlisted")).json();
  const response = await f.call(`/page?t=${share}&keep=yes`);
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get("location")).search, "?keep=yes");
  const headers = { cookie: cookie(response) };
  assert.equal((await f.call("/asset.js", headers)).status, 200);
  const reset = await (await f.call("/reset")).json();
  assert.equal((await f.call(`/page?t=${share}`)).status, 401);
  assert.equal((await f.call("/asset.js", headers)).status, 401);
  const fresh = await f.call(`/page?t=${reset.share}`);
  await f.call("/visibility?value=private");
  assert.equal(
    (await f.call("/asset.js", { cookie: cookie(fresh) })).status,
    401,
  );
});

test("retained public/unlisted/private admission table, with public off by default", async () => {
  const cases = [
    ["public", "anonymous", 200],
    ["unlisted", "right share", 302],
    ["unlisted", "wrong share", 401],
    ["private", "anonymous", 401],
    ["private", "good token", 302],
    ["private", "replay", 401],
  ];
  for (const [visibility, entry, status] of cases) {
    const f = await fixture();
    const configured = await f.call(
      `/visibility?value=${visibility}&public=on`,
    );
    const { share } = await configured.json();
    const token = await f.issue();
    if (entry === "replay") await f.call(`/page?token=${token}`);
    const query =
      entry === "right share"
        ? `t=${share}`
        : entry === "wrong share"
          ? `t=${"a".repeat(32)}`
          : entry === "good token" || entry === "replay"
            ? `token=${token}`
            : "";
    const response = await f.call(`/page?public=on&${query}`);
    assert.equal(response.status, status, `${visibility}: ${entry}`);
    if (visibility === "public") {
      assert.equal(response.headers.has("set-cookie"), false);
      assert.equal((await f.call("/page")).status, 401);
    }
  }
  const f = await fixture();
  assert.equal((await f.call("/visibility?value=public")).status, 409);
});

test("forwarding strips gateway credentials and service cookies, while preserving service headers", async () => {
  const f = await fixture();
  const response = await f.call(`/page?token=${await f.issue()}`);
  const names = [
    "authorization",
    "proxy-authorization",
    "cf-access-jwt-assertion",
    "cf-access-client-id",
    "cf-access-client-secret",
    "cf-access-authenticated-user-email",
    "x-authenticated-user",
    "x-authenticated-email",
    "x-auth-request-user",
    "x-auth-request-email",
    "x-user-id",
    "x-user-email",
    "x-forwarded-user",
    "x-forwarded-email",
  ];
  const echoed = await f.call("/asset.js", {
    ...Object.fromEntries(names.map((name) => [name, "fixture"])),
    cookie: cookie(response),
    "x-marker": "kept",
  });
  assert.equal(echoed.status, 200);
  const body = await echoed.json();
  for (const name of [...names, "cookie"])
    assert.equal(body.headers[name], undefined);
  assert.equal(body.headers["x-marker"], "kept");
  assert.equal(echoed.headers.get("x-service"), "kept");
  assert.equal(echoed.headers.has("set-cookie"), false);
  assert.equal(echoed.headers.get("cache-control"), "no-store");
  const navigation = await f.call("/page", { "sec-fetch-dest": "document" });
  assert.match(await navigation.text(), /Open this from Fungi/);
  assert.equal(await (await f.call("/asset.js")).text(), "");
});

test("refuses foreign or missing WebSocket origins even with a valid session", async () => {
  const f = await fixture();
  const exchanged = await f.call(`/page?token=${await f.issue()}`);
  for (const origin of [
    undefined,
    "null",
    "https://sibling.preview.test",
    "https://foreign.example",
  ]) {
    const headers = new globalThis.Headers({ cookie: cookie(exchanged) });
    if (origin !== undefined) headers.set("origin", origin);
    const response = await f.call(
      "/websocket-proof",
      Object.fromEntries(headers),
    );
    assert.deepEqual(await response.json(), {
      status: 401,
      socket: false,
      cookie: false,
    });
  }
});

test("refuses sibling-site requests before token exchange or forwarding", async () => {
  const f = await fixture();
  const token = await f.issue();
  const path = `/page?token=${token}`;
  assert.equal(
    (await f.call(path, { "sec-fetch-site": "same-site" })).status,
    401,
  );
  const exchanged = await f.call(path);
  assert.equal(exchanged.status, 302);
  const headers = { cookie: cookie(exchanged), "sec-fetch-site": "same-site" };
  assert.equal((await f.call("/asset.js", headers)).status, 401);
  const upgrade = await f.call("/websocket-proof", {
    ...headers,
    origin: "https://preview.test",
  });
  assert.deepEqual(await upgrade.json(), {
    status: 401,
    socket: false,
    cookie: false,
  });
  assert.equal(
    (
      await f.call("/asset.js", {
        cookie: cookie(exchanged),
        "sec-fetch-site": "same-origin",
      })
    ).status,
    200,
  );
});
