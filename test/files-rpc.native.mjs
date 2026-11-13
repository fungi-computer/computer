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
  const moved = await (await globalThis.fetch(`${worker.baseUrl}/move`)).json();
  const base = [
    "/lib/Characters",
    "/lib/Characters/Mira",
    "/lib/Characters/Mira/shot.png",
    "/lib/a.png",
    "/lib/b.png",
  ];
  assert.deepEqual(moved.file, {
    ok: { from: "/lib/a.png", to: "/lib/Characters/a.png" },
  });
  assert.deepEqual(
    moved.fileTree,
    [...base.filter((p) => p !== "/lib/a.png"), "/lib/Characters/a.png"].sort(),
  );
  assert.equal(moved.fileBytes, "a");
  console.log("PASS files.move renames a file and keeps its bytes");
  assert.match(moved.conflict.refused, /already exists/);
  assert.equal(moved.conflictSourceKept, "b");
  console.log(
    "PASS files.move refuses an existing destination and keeps the source",
  );
  assert.deepEqual(moved.directory, {
    ok: { from: "/lib/Characters", to: "/lib/Cast" },
  });
  assert.ok(moved.directoryTree.includes("/lib/Cast/Mira/shot.png"));
  assert.ok(moved.directoryTree.includes("/lib/Cast/a.png"));
  assert.ok(!moved.directoryTree.some((p) => p.startsWith("/lib/Characters")));
  console.log("PASS files.move renames a directory with its whole subtree");
  assert.match(moved.intoSelf.refused, /into itself/);
  assert.match(moved.intoSelfRoot.refused, /into itself/);
  console.log("PASS files.move refuses a directory moved into itself");
  assert.match(moved.missingSource.refused, /no such path/);
  assert.match(moved.missingParent.refused, /parent directory missing/);
  assert.ok(!moved.noParentCreated.includes("/lib/Places"));
  console.log(
    "PASS files.move refuses a missing source or parent and creates nothing",
  );
  assert.deepEqual(moved.createParents, {
    ok: { from: "/lib/b.png", to: "/lib/Places/Forest/b.png" },
  });
  assert.ok(moved.afterCreate.includes("/lib/Places/Forest/b.png"));
  assert.ok(!moved.afterCreate.includes("/lib/b.png"));
  console.log("PASS files.move createParents makes the missing folders");
  assert.match(moved.createThenRefuse.refused, /into itself/);
  assert.deepEqual(moved.afterRefuse, moved.afterCreate);
  console.log("PASS a refused move rolls back the folders createParents made");
} finally {
  if (worker) await workers.stop(worker);
  await workers.dispose();
}
