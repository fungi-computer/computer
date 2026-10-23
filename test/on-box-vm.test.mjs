import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { seamHeader } from "@fungi.computer/seam";
import { OnBoxVmContainerHost } from "../dist/on-box-vm.js";

const { privateKey } = generateKeyPairSync("ed25519");
const env = {
  COMPUTER_VM_SIGNING_KEY: `platform-1:${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")}`,
};
const host = new OnBoxVmContainerHost(
  { hostId: "hel1", origin: "https://box.example" },
  env,
  "a".repeat(64),
  60_000,
);

test("an expired VM destroy request is a typed timeout, not an offline observation", async (t) => {
  t.mock.method(globalThis.AbortSignal, "timeout", (timeoutMs) => {
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
    return globalThis.AbortSignal.abort(
      new globalThis.DOMException(
        "Host request deadline expired",
        "TimeoutError",
      ),
    );
  });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.ok(init.signal, "the host request must carry its deadline");
    init.signal.throwIfAborted();
    throw new Error("an expired request must not execute");
  });
  await assert.rejects(host.destroy(), (cause) => {
    assert.equal(cause._tag, "OnBoxVmTimeoutError");
    assert.equal(cause.operation, "destroy");
    assert.ok(Number.isSafeInteger(cause.timeoutMs) && cause.timeoutMs > 0);
    return true;
  });
});

test("host refusal and network failure are not relabeled as timeouts", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new globalThis.Response("host unavailable", { status: 503 }),
  );
  await assert.rejects(host.state(), {
    name: "OnBoxVmUnavailableError",
  });
  const offline = new TypeError("fetch failed: connection refused");
  t.mock.method(globalThis, "fetch", async () => {
    throw offline;
  });
  await assert.rejects(host.destroy(), (cause) => cause === offline);
});

test("inventory uses the same deadline and preserves its host-wide signed GET", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://box.example/vms");
    assert.equal(init.method, "GET");
    assert.ok(init.signal);
    assert.ok(init.headers.has(seamHeader));
    return globalThis.Response.json([]);
  });
  assert.deepEqual(await host.inventory(), []);
});

test(
  "the deadline covers successful and error response bodies, not only headers",
  { timeout: 10_000 },
  async (t) => {
    const nativeFetch = globalThis.fetch;
    for (const status of [200, 503]) {
      const server = createServer((_request, response) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.flushHeaders();
        // A real host can send headers and then stall its body indefinitely.
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      });
      const address = server.address();
      assert.ok(address);
      const local = new OnBoxVmContainerHost(
        { hostId: "hel1", origin: `http://127.0.0.1:${address.port}` },
        env,
        "a".repeat(64),
        60_000,
      );
      const controller = new globalThis.AbortController();
      t.mock.method(globalThis.AbortSignal, "timeout", () => controller.signal);
      t.mock.method(globalThis, "fetch", async (...args) => {
        const response = await nativeFetch(...args);
        controller.abort(
          new globalThis.DOMException(
            "Host request deadline expired",
            "TimeoutError",
          ),
        );
        return response;
      });
      await assert.rejects(local.state(), (cause) => {
        assert.equal(cause._tag, "OnBoxVmTimeoutError");
        assert.equal(cause.operation, "status");
        return true;
      });
    }
  },
);
