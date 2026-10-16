import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import {
  decideComputerEgress,
  originGitRequest,
  sameOriginHttps,
} from "../dist/egress-policy.js";

// A host's own Git as one host entry: origin plus the grammar its door serves.
const host = {
  origin: "https://oyster.test",
  route: (request, url) =>
    url.pathname.startsWith("/git/") ? { path: url.pathname } : null,
};

test("admits the host's own origin Git only through its grammar", () => {
  assert.deepEqual(
    decideComputerEgress(
      { method: "GET" },
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
      decideComputerEgress({ method: "GET" }, new URL(url), host).kind,
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
