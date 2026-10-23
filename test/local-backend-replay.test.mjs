/* global Request */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { webcrypto } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import {
  seamHeader,
  signSeamRequest,
  unsignedPayload,
} from "@fungi.computer/seam";
import {
  createLocalBackendReplayStore,
  maximumLocalDialReplayRecords,
} from "../dist/local-backend-replay.js";
import {
  localBackendAudience,
  verifyLocalBackendDial,
} from "../dist/local-backend.js";

const nonce = (index) => index.toString(16).padStart(32, "0");
const record = (index, now) => ({
  nonce: nonce(index),
  now,
  expiresAt: now + 120_000,
});

test("the inclusive deadline survives reconstruction without duplicate renewal", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const owner = fromNodeSqlite(database);
    const store = createLocalBackendReplayStore(owner);
    assert.equal(store.admit(record(0, 1_000)), "admitted");
    const reconstructed = createLocalBackendReplayStore(owner);
    assert.equal(reconstructed.admit(record(0, 121_000)), "replayed");
    assert.equal(reconstructed.admit(record(0, 121_001)), "admitted");
  } finally {
    database.close();
  }
});

test("clock steps do not make insertion order an expiry order", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const store = createLocalBackendReplayStore(fromNodeSqlite(database));
    assert.equal(store.admit(record(0, 1_000)), "admitted");
    assert.equal(store.admit(record(1, 500)), "admitted");
    assert.equal(store.admit(record(0, 120_501)), "replayed");
    assert.equal(store.admit(record(1, 120_501)), "admitted");
  } finally {
    database.close();
  }
});

test("finite capacity refuses new nonces without evicting live history", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const store = createLocalBackendReplayStore(fromNodeSqlite(database));
    assert.equal(maximumLocalDialReplayRecords, 4096);
    for (let index = 0; index < 4096; index++)
      assert.equal(store.admit(record(index, 1_000)), "admitted");
    assert.equal(store.admit(record(4096, 121_000)), "at-capacity");
    assert.equal(store.admit(record(0, 121_000)), "replayed");
    assert.equal(store.admit(record(4096, 121_001)), "admitted");
  } finally {
    database.close();
  }
});

test("a failed commit rolls back pruning and insertion before refusing admission", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const owner = fromNodeSqlite(database);
    const healthy = createLocalBackendReplayStore(owner);
    assert.equal(healthy.admit(record(0, 1_000)), "admitted");
    // The native adapter still owns the transaction and rollback. This trusted
    // storage fault occurs after the statements, before the commit can succeed.
    const failing = createLocalBackendReplayStore({
      sql: owner.sql,
      transactionSync(operation) {
        return owner.transactionSync(() => {
          operation();
          throw new Error("storage commit failed");
        });
      },
    });
    assert.equal(failing.admit(record(1, 121_001)), "unavailable");
    // A clock step back exposes whether pruning improperly escaped rollback.
    assert.equal(healthy.admit(record(0, 121_000)), "replayed");
    assert.equal(healthy.admit(record(1, 121_000)), "admitted");
  } finally {
    database.close();
  }
});

test("storage failure never falls back to fresh process-local history", () => {
  const database = new DatabaseSync(":memory:");
  const store = createLocalBackendReplayStore(fromNodeSqlite(database));
  database.close();
  assert.equal(store.admit(record(0, 1_000)), "unavailable");
  assert.equal(store.admit(record(0, 1_000)), "unavailable");
});

test("receiver databases keep independent nonce-only namespaces", () => {
  const first = new DatabaseSync(":memory:");
  const second = new DatabaseSync(":memory:");
  try {
    const one = createLocalBackendReplayStore(fromNodeSqlite(first));
    const two = createLocalBackendReplayStore(fromNodeSqlite(second));
    assert.equal(one.admit(record(0, 1_000)), "admitted");
    assert.equal(two.admit(record(0, 1_000)), "admitted");
    assert.equal(one.admit(record(0, 1_000)), "replayed");
    assert.equal(two.admit(record(0, 1_000)), "replayed");
  } finally {
    first.close();
    second.close();
  }
});

test("the durable composition preserves signature admission before consuming a nonce", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const owner = fromNodeSqlite(database);
    const keys = await webcrypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const other = await webcrypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const computerName = "computer-fixture";
    const backend = {
      kind: "local",
      deviceId: "aaaaaaaaaaaaaaaa",
      publicKey: Buffer.from(
        await webcrypto.subtle.exportKey("raw", keys.publicKey),
      ).toString("base64"),
      hostLabel: "Fixture machine",
      folderLabel: "Fixture folder",
    };
    const url =
      "https://hub.example/api/teams/team-fixture/computers/computer-fixture/backends/local-aaaaaaaaaaaaaaaa/connect";
    const header = await signSeamRequest(
      { keyId: backend.deviceId, key: keys.privateKey },
      localBackendAudience(computerName, `local-${backend.deviceId}`),
      "GET",
      url,
      unsignedPayload,
    );
    const request = (method = "GET") =>
      new Request(url, { method, headers: { [seamHeader]: header } });
    assert.equal(
      await verifyLocalBackendDial(request(), "wrong-computer", backend, owner),
      false,
    );
    assert.equal(
      await verifyLocalBackendDial(
        request("POST"),
        computerName,
        backend,
        owner,
      ),
      false,
    );
    assert.equal(
      await verifyLocalBackendDial(
        request(),
        computerName,
        {
          ...backend,
          publicKey: Buffer.from(
            await webcrypto.subtle.exportKey("raw", other.publicKey),
          ).toString("base64"),
        },
        owner,
      ),
      false,
    );
    assert.equal(
      await verifyLocalBackendDial(request(), computerName, backend, owner),
      true,
    );
    assert.equal(
      await verifyLocalBackendDial(request(), computerName, backend, owner),
      false,
    );
  } finally {
    database.close();
  }
});
