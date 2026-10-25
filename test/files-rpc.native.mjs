import assert from "node:assert/strict";
import console from "node:console";
import { proofWorkers } from "./proof-worker.mjs";

const workers = await proofWorkers("files-rpc", {
  main: "test/files-rpc.fixture.ts",
  wranglerConfig: "test/files-rpc.wrangler.json",
});
let worker;
try {
  worker = await workers.start();
  const missing = await globalThis.fetch(`${worker.baseUrl}/missing`);
  assert.equal(missing.status, 200);
  assert.deepEqual(await missing.json(), { remoteCode: true });
  console.log(
    "PASS Workers RPC preserves the missing stat error's ENOENT code",
  );
  const search = await globalThis.fetch(`${worker.baseUrl}/search`);
  assert.equal(
    search.status,
    200,
    "Files search must accept an absent .gitignore over RPC",
  );
  assert.deepEqual(await search.json(), {
    path: "/",
    results: [{ path: "/visible.txt", type: "file" }],
    truncated: null,
  });
  console.log(
    "PASS Files search through a leased Workspace accepts missing ignore files",
  );
} finally {
  if (worker) await workers.stop(worker);
  await workers.dispose();
}
