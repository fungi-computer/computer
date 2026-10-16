/* global TextEncoder */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  SeamReplayGuard,
  importSeamSigner,
  importSeamVerifiers,
  seamBodyDigest,
  signSeamRequest,
  unsignedPayload,
  verifySeamRequest,
} from "@fungi.computer/seam";

function pair(keyId) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    secret: `${keyId}:${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")}`,
    raw: Buffer.from(
      publicKey.export({ format: "jwk" }).x,
      "base64url",
    ).toString("base64"),
  };
}

const hub = pair("platform-1");
const other = pair("platform-1");
const signer = await importSeamSigner(hub.secret);
const verifiers = await importSeamVerifiers({ "platform-1": hub.raw });
const audience = "computer-vm-host:hel1";
const url = "https://box.example/vms/abc/start?x=1";
const body = new TextEncoder().encode('{"env":{}}');

test("a signed request verifies once and names its key", async () => {
  const digest = await seamBodyDigest(body);
  const header = await signSeamRequest(signer, audience, "POST", url, digest);
  const replay = new SeamReplayGuard();
  assert.equal(
    await verifySeamRequest(
      verifiers,
      audience,
      "POST",
      url,
      header,
      digest,
      replay,
    ),
    "platform-1",
  );
  await assert.rejects(
    verifySeamRequest(verifiers, audience, "POST", url, header, digest, replay),
    /replayed nonce/,
  );
});

test("the audience, method, path, body and clock are all bound", async () => {
  const digest = await seamBodyDigest(body);
  const header = await signSeamRequest(signer, audience, "POST", url, digest);
  const reject = (overrides, pattern) => {
    const value = {
      verifiers,
      audience,
      method: "POST",
      url,
      header,
      digest,
      ...overrides,
    };
    return assert.rejects(
      verifySeamRequest(
        value.verifiers,
        value.audience,
        value.method,
        value.url,
        value.header,
        value.digest,
        new SeamReplayGuard(),
        value.now,
      ),
      pattern,
    );
  };
  await reject({ audience: "computer-vm-ingress" }, /bad signature/);
  await reject({ method: "GET" }, /bad signature/);
  await reject(
    { url: "https://box.example/vms/abd/start?x=1" },
    /bad signature/,
  );
  await reject(
    { digest: await seamBodyDigest(new Uint8Array(1)) },
    /body digest/,
  );
  await reject({ digest: null }, /unsigned stream/);
  await reject({ now: Date.now() + 120_000 }, /skew/);
  await reject(
    { verifiers: await importSeamVerifiers({ "platform-1": other.raw }) },
    /bad signature/,
  );
  await reject({ verifiers: await importSeamVerifiers({}) }, /unknown key/);
  await reject({ header: header.replace("v1 ", "v2 ") }, /version/);
});

test("a stream route accepts only an unsigned payload", async () => {
  const header = await signSeamRequest(
    signer,
    audience,
    "GET",
    url,
    unsignedPayload,
  );
  assert.equal(
    await verifySeamRequest(
      verifiers,
      audience,
      "GET",
      url,
      header,
      null,
      new SeamReplayGuard(),
    ),
    "platform-1",
  );
});
