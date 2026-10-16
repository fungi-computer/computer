import assert from "node:assert/strict";
import console from "node:console";
import { proofWorkers } from "./proof-worker.mjs";

const workers = await proofWorkers("fleet", {
  wranglerConfig: "test/fleet.wrangler.json",
});
let worker;
try {
  worker = await workers.start();
  const response = await globalThis.fetch(`${worker.baseUrl}/create`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    admitted: { kind: "admitted" },
    refused: { kind: "Refused", reason: "computer" },
    projection: {
      computerId: "one",
      revision: 0,
      backends: [{ kind: "platform-container" }],
    },
    fact: {
      kind: "interval",
      computerId: "one",
      provenance: { actor: "local-owner", via: "local-invocation" },
      runtimeId: "runtime-one",
      backing: { kind: "platform-container" },
      startedAt: 1_000,
      observedAt: 2_000,
      ended: true,
    },
  });
  await workers.stop(worker);
  worker = undefined;
  worker = await workers.start();
  const resumed = await globalThis.fetch(`${worker.baseUrl}/read`);
  assert.equal(resumed.status, 200);
  assert.deepEqual(await resumed.json(), [{ kind: "platform-container" }]);
  console.log("PASS Computer fleet grants, facts and durable backing restart");
} finally {
  if (worker) await workers.stop(worker);
  await workers.dispose();
}
