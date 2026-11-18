/* global console */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { URL } from "node:url";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import {
  decideComputerEgress,
  originGitRequest,
  sameOriginHttps,
  vaultRefusalStatus,
  vaultRequestData,
} from "../dist/egress-policy.js";
import {
  createComputerVaultReferences,
  vaultExecutionContext,
  vaultExecutionHooks,
  withVaultExecution,
} from "../dist/vault-references.js";

// A host's own Git as one host entry: origin plus the grammar its door serves.
const host = {
  origin: "https://oyster.test",
  route: (request, url) =>
    url.pathname.startsWith("/git/") ? { path: url.pathname } : null,
};

test("admits the host's own origin Git only through its grammar", () => {
  assert.deepEqual(
    decideComputerEgress(
      { method: "GET", headers: new globalThis.Headers() },
      new URL(
        "https://oyster.test/git/bonsai/notes.git/info/refs?service=git-upload-pack",
      ),
      host,
    ),
    { kind: "origin-git" },
  );
  for (const url of [
    "https://oyster.test/settings",
    "http://oyster.test/git/bonsai/notes.git/info/refs",
    "https://oyster.test:8443/git/bonsai/notes.git/info/refs",
    "https://user:pass@oyster.test/git/bonsai/notes.git/info/refs",
    "https://evil.test/git/bonsai/notes.git/info/refs",
    "https://oyster.test.evil.test/git/bonsai/notes.git/info/refs",
  ])
    assert.equal(
      decideComputerEgress(
        { method: "GET", headers: new globalThis.Headers() },
        new URL(url),
        host,
      ).kind,
      "denied",
      url,
    );
});

test("no origin entry admits nothing; a malformed origin is a config error", () => {
  const url = new URL("https://oyster.test/git/a/b.git/info/refs");
  assert.equal(sameOriginHttps(url, undefined), false);
  assert.equal(sameOriginHttps(url, "https://oyster.test/base"), false);
  assert.throws(() => sameOriginHttps(url, "not a url"));
});

test("an origin-git request keeps Git transport and the guest credential only", async () => {
  const forwarded = originGitRequest(
    new globalThis.Request("https://oyster.test/git/a/b.git/git-receive-pack", {
      method: "POST",
      headers: {
        authorization: "Bearer guest-pass",
        "content-type": "application/x-git-receive-pack-request",
        "git-protocol": "version=2",
        cookie: "session=owner",
        "x-workspace-egress-token": "leak",
      },
      body: "pack",
    }),
    new URL("https://oyster.test/git/a/b.git/git-receive-pack"),
  );
  assert.equal(forwarded.headers.get("authorization"), "Bearer guest-pass");
  assert.equal(forwarded.headers.get("git-protocol"), "version=2");
  assert.equal(forwarded.headers.get("cookie"), null);
  assert.equal(forwarded.headers.get("x-workspace-egress-token"), null);
  assert.equal(await forwarded.text(), "pack");
});

const reference = `fvr1.${"A".repeat(21)}_${"b".repeat(21)}`;
const other = `fvr1.${"C".repeat(43)}`;
const request = (url, init = {}) => new globalThis.Request(url, init);
const decideFor = (url, init) =>
  decideComputerEgress(request(url, init), new URL(url), host);

test("a presented reference takes the Vault lane wherever it is sent", () => {
  for (const [url, init] of [
    [
      "https://api.stripe.com/v1/charges",
      { headers: { authorization: `Bearer ${reference}` } },
    ],
    [
      "https://unlisted.example/",
      {
        headers: {
          authorization: `Basic ${globalThis.btoa(`user:${reference}`)}`,
        },
      },
    ],
    ["https://api.example.com/items?key=" + reference, {}],
    [
      "https://registry.npmjs.org/react",
      { headers: { "x-api-key": reference } },
    ],
    [
      "https://oyster.test/git/a/b.git/info/refs",
      { headers: { "x-token": reference } },
    ],
    [
      "https://api.example.com/",
      { method: "DELETE", headers: { "x-api-key": reference } },
    ],
  ])
    assert.deepEqual(decideFor(url, init), { kind: "vault", reference }, url);
  // Plain HTTP is never intercepted; two secrets in one request are refused.
  assert.deepEqual(
    decideFor("http://api.example.com/", {
      headers: { authorization: `Bearer ${reference}` },
    }),
    { kind: "denied", reason: "origin" },
  );
  assert.deepEqual(
    decideFor(`https://api.example.com/?a=${other}`, {
      headers: { authorization: `Bearer ${reference}` },
    }),
    { kind: "denied", reason: "references" },
  );
  // A longer token that merely starts like a reference is not one.
  assert.equal(
    decideFor("https://registry.npmjs.org/react", {
      headers: { "x-api-key": `${reference}x` },
    }).kind,
    "public",
  );
});

test("the owner receives the request without the reference, the body bounded", async () => {
  const url = new URL(`https://api.example.com/v1/items?key=${reference}&q=1`);
  const prepared = await vaultRequestData(
    request(url.href, {
      method: "POST",
      headers: {
        authorization: `Bearer ${reference}`,
        "x-basic": "ignored",
        "content-type": "application/json",
      },
      body: "{}",
    }),
    url,
    reference,
    16,
  );
  assert.equal(prepared.kind, "ready");
  assert.equal(prepared.data.url, "https://api.example.com/v1/items?q=1");
  assert.equal(prepared.data.method, "POST");
  assert.deepEqual(prepared.data.headers, [
    ["content-type", "application/json"],
    ["x-basic", "ignored"],
  ]);
  assert.equal(new globalThis.TextDecoder().decode(prepared.data.body), "{}");
  const basic = await vaultRequestData(
    request("https://api.example.com/", {
      headers: {
        authorization: `Basic ${globalThis.btoa(`user:${reference}`)}`,
      },
    }),
    new URL("https://api.example.com/"),
    reference,
    16,
  );
  assert.deepEqual(basic.kind === "ready" && basic.data.headers, []);
  // An intercepted GET may arrive with an open, empty body stream; the owner
  // gets no body, since a GET request cannot be built with one.
  const openGet = await vaultRequestData(
    {
      method: "GET",
      headers: new globalThis.Headers({ "x-api-key": reference }),
      body: new globalThis.ReadableStream({
        start: (controller) => controller.close(),
      }),
    },
    new URL("https://api.example.com/v1"),
    reference,
    16,
  );
  assert.equal(openGet.kind === "ready" && openGet.data.body, null);
  const inPath = new URL(`https://api.example.com/${reference}`);
  assert.deepEqual(
    await vaultRequestData(request(inPath.href), inPath, reference, 16),
    { kind: "refused", reason: "placement" },
  );
  assert.deepEqual(
    await vaultRequestData(
      request("https://api.example.com/", {
        method: "POST",
        headers: { "x-api-key": reference },
        body: "x".repeat(17),
      }),
      new URL("https://api.example.com/"),
      reference,
      16,
    ),
    { kind: "refused", reason: "too_large" },
  );
  assert.equal(vaultRefusalStatus("revoked"), 403);
  assert.equal(vaultRefusalStatus("invalid_response"), 502);
});

test("a reference names its owner, Agent, secret and command, and ends with it", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const references = createComputerVaultReferences(
      fromNodeSqlite(database).sql,
    );
    const holder = { owner: "team_a", subject: { kind: "agent", id: "ag_1" } };
    const asked = [];
    const hooks = withVaultExecution(
      vaultExecutionHooks(references, {
        grants: (input) => {
          asked.push(input);
          return Promise.resolve([
            { name: "STRIPE_KEY", connectionId: "c2", grantVersion: 3 },
            { name: "STRIPE_KEY", connectionId: "c3", grantVersion: 1 },
            { name: "not portable", connectionId: "c4", grantVersion: 1 },
            { name: "GITHUB_TOKEN", connectionId: "c1", grantVersion: 2 },
          ]);
        },
      }),
      {
        open: () => Promise.resolve({ env: { GIT: "host" } }),
        renew: () => Promise.resolve(),
        close: () => Promise.resolve(),
      },
    );
    const invocation = { id: "exec:1", kind: "exec" };
    const carriage = await hooks.open(
      invocation,
      vaultExecutionContext(holder),
    );
    assert.deepEqual(asked, [holder]);
    assert.deepEqual(Object.keys(carriage.env).sort(), [
      "GITHUB_TOKEN",
      "STRIPE_KEY",
    ]);
    for (const value of Object.values(carriage.env))
      assert.match(value, /^fvr1\.[A-Za-z0-9_-]{43}$/u);
    assert.deepEqual(await references.find(carriage.env.STRIPE_KEY), {
      invocationId: "exec:1",
      owner: "team_a",
      subject: { kind: "agent", id: "ag_1" },
      connectionId: "c2",
      grantVersion: 3,
    });
    // Only digests are stored.
    assert.equal(
      JSON.stringify(
        database.prepare("SELECT * FROM computer_vault_references").all(),
      ).includes(carriage.env.STRIPE_KEY),
      false,
    );
    assert.equal(await references.find(reference), null);
    // The host's own hooks keep every other context.
    assert.deepEqual(
      await hooks.open({ id: "exec:2", kind: "exec" }, { workflowGit: {} }),
      { env: { GIT: "host" } },
    );
    await hooks.close(invocation, vaultExecutionContext(holder), "native_exit");
    assert.equal(await references.find(carriage.env.STRIPE_KEY), null);
    // An owner that cannot answer gives the command no references, and
    // the failure is reported with its cause kept redacted.
    const reported = [];
    const consoleError = console.error;
    console.error = (...line) => {
      reported.push(line);
    };
    let unanswered;
    try {
      unanswered = await vaultExecutionHooks(references, {
        grants: () => Promise.reject(new Error("owner unavailable")),
      }).open({ id: "exec:3", kind: "exec" }, vaultExecutionContext(holder));
    } finally {
      console.error = consoleError;
    }
    assert.deepEqual(unanswered, { env: {} });
    assert.equal(reported.length, 1);
    assert.deepEqual(JSON.parse(reported[0][0]), {
      source: "computer",
      operation: "computer.vault-grants",
      failureKind: "Error",
    });
    assert.equal(String(reported[0][1]).includes("owner unavailable"), false);
    assert.throws(() =>
      vaultExecutionContext({
        owner: "team_a",
        subject: { kind: "app", id: "x" },
      }),
    );
  } finally {
    database.close();
  }
});
