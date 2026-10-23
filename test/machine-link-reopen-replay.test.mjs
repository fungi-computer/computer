import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { webcrypto } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { signSeamRequest, unsignedPayload } from "@fungi.computer/seam";

const fixture = fileURLToPath(
  new URL("./machine-link-reopen-replay.fixture.mjs", import.meta.url),
);

// Each child invokes the production verifier composition and reopens the same
// receiver database rather than constructing a separate in-memory guard.
test("a signed local dial remains refused after its receiver process reopens", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "computer-dial-replay-"));
  try {
    const keys = await webcrypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const deviceId = "aaaaaaaaaaaaaaaa";
    const computerName = "computer-fixture";
    const audience =
      "fungi-local-backend:computer-fixture:local-aaaaaaaaaaaaaaaa";
    const url =
      "https://hub.example/api/teams/team-fixture/computers/computer-fixture/backends/local-aaaaaaaaaaaaaaaa/connect";
    const header = await signSeamRequest(
      { keyId: deviceId, key: keys.privateKey },
      audience,
      "GET",
      url,
      unsignedPayload,
    );
    const input = JSON.stringify({
      computerName,
      url,
      header,
      backend: {
        kind: "local",
        deviceId,
        publicKey: Buffer.from(
          await webcrypto.subtle.exportKey("raw", keys.publicKey),
        ).toString("base64"),
        hostLabel: "Fixture machine",
        folderLabel: "Fixture folder",
      },
    });
    const state = resolve(directory, "owner-state");
    await mkdir(state);
    async function reconstruct(name) {
      const home = resolve(directory, name);
      await mkdir(home);
      const child = spawnSync(process.execPath, [fixture], {
        encoding: "utf8",
        input,
        timeout: 10_000,
        maxBuffer: 512 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: home,
          XDG_CACHE_HOME: home,
          XDG_DATA_HOME: home,
          XDG_STATE_HOME: home,
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
          COMPUTER_DIAL_REPLAY_STATE: state,
        },
      });
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr);
      return JSON.parse(child.stdout);
    }
    const before = await reconstruct("before");
    assert.equal(before.first, true, "the actual pinned-key dial verifies");
    assert.equal(before.warmReplay, false, "warm replay is refused");
    const reopened = await reconstruct("reopened");
    assert.notEqual(
      before.pid,
      reopened.pid,
      "must use a genuinely new process",
    );
    assert.equal(reopened.warmReplay, false, "warm replay remains refused");
    t.diagnostic(
      `Node ${process.version}; physical processes ${before.pid} -> ${reopened.pid}`,
    );
    assert.equal(
      reopened.first,
      false,
      "the identical signed dial must remain a replay after process reconstruction",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
