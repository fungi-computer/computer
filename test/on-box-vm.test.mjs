import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  importSeamSigner,
  seamHeader,
  signSeamRequest,
  unsignedPayload,
} from "@fungi.computer/seam";
import { OnBoxVmContainerHost, onBoxVmIngress } from "../dist/on-box-vm.js";

const { privateKey } = generateKeyPairSync("ed25519");
const env = {
  COMPUTER_VM_SIGNING_KEY: `platform-1:${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")}`,
};
const host = new OnBoxVmContainerHost(
  { hostId: "hel1", origin: "https://box.example" },
  env,
  "a".repeat(64),
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

test("a VM boots with vmd's sleep timer at its maximum and the Computer's size", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    bodies.push(JSON.parse(new globalThis.TextDecoder().decode(init.body)));
    return globalThis.Response.json({ runtimeId: "runtime-one" });
  });
  let size = "large";
  const sized = new OnBoxVmContainerHost(
    { hostId: "hel1", origin: "https://box.example" },
    env,
    "a".repeat(64),
    () => size,
  );
  assert.deepEqual(await sized.start({}, false), { runtimeId: "runtime-one" });
  size = "small";
  assert.deepEqual(await sized.restart({}, false), {
    runtimeId: "runtime-one",
  });
  assert.deepEqual(bodies, [
    { env: {}, enableInternet: false, sleepAfterMs: 86_400_000, size: "large" },
    { env: {}, enableInternet: false, sleepAfterMs: 86_400_000, size: "small" },
  ]);
});

test("a host built to read and stop VMs cannot boot one", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("a boot without a size must not reach the host");
  });
  await assert.rejects(host.start({}, false), /without a Computer size/);
});

function hostPair(hostId) {
  const pair = generateKeyPairSync("ed25519");
  return {
    secret: `${hostId}:${pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")}`,
    publicKey: Buffer.from(
      pair.publicKey.export({ format: "jwk" }).x,
      "base64url",
    ).toString("base64"),
  };
}

test(
  "one VM's guest filling its replay history never refuses another VM's ingress",
  { timeout: 60_000 },
  async (t) => {
    t.mock.method(globalThis.console, "error", () => undefined);
    const hel1 = hostPair("hel1");
    const hel2 = hostPair("hel2");
    const ingressEnv = {
      COMPUTER_VM_HOSTS: JSON.stringify({
        hel1: { origin: "https://hel1.example", publicKey: hel1.publicKey },
        hel2: { origin: "https://hel2.example", publicKey: hel2.publicKey },
      }),
    };
    const signers = {
      hel1: await importSeamSigner(hel1.secret),
      hel2: await importSeamSigner(hel2.secret),
    };
    const reached = [];
    const computers = {
      idFromString: (id) => id,
      get: (id) => ({
        fetch: async (request) => {
          reached.push(`${id}:${new globalThis.URL(request.url).pathname}`);
          return new globalThis.Response("connected");
        },
      }),
    };
    const ingress = async (hostId, vmId, path) => {
      const url = `https://hub.example/__computer-vm/${vmId}${path}`;
      const headers = new globalThis.Headers({
        [seamHeader]: await signSeamRequest(
          signers[hostId],
          "computer-vm-ingress",
          "GET",
          url,
          unsignedPayload,
        ),
      });
      const response = await onBoxVmIngress(
        new globalThis.Request(url, { headers }),
        ingressEnv,
        computers,
      );
      return response.status;
    };
    const attacker = "a".repeat(64);
    const victim = "c".repeat(64);
    // The guest's own health loop exhausts the 10,000-nonce window of its VM.
    for (let index = 0; index < 10_000; index += 1)
      assert.equal(await ingress("hel1", attacker, "/health"), 200);
    assert.equal(
      await ingress("hel1", attacker, "/health"),
      404,
      "the flooding VM is refused inside its own partition",
    );
    assert.equal(await ingress("hel1", victim, "/ws"), 200);
    assert.equal(await ingress("hel2", victim, "/ws"), 200);
    assert.deepEqual(reached, [
      `${victim}:/__vm/hel1/ws`,
      `${victim}:/__vm/hel2/ws`,
    ]);
  },
);
