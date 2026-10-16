// Real-workerd proof that ComputerProcessInventory's schema-version check
// runs against a real Durable Object's SQLite storage, not just node:sqlite.
//
// `PRAGMA user_version` returns SQLITE_AUTH against a real Durable Object's
// SQLite binding (confirmed in miniflare); node:sqlite does not enforce the
// same sandbox, so a unit test against it alone would hide that. This proof
// never starts a process or touches the platform container -- the schema
// check runs the moment anything accesses `#processes`, which `list_processes`
// (and `/ports`) does, so this is deliberately container-free and fast.
import assert from "node:assert/strict";
import process from "node:process";
import { z } from "zod";
import { proofWorkers } from "./proof-worker.mjs";
import { proofClient, proofFailure } from "./proof-client.mjs";

const processList = z.strictObject({
  processes: z.array(
    z.strictObject({
      id: z.string(),
      command: z.string(),
      cwd: z.string().nullable(),
      port: z.number().int().nullable(),
      state: z.enum(["running", "exited", "uncertain"]),
      exitCode: z.number().int().nullable(),
      sync: z.enum(["synced", "pending", "unknown"]),
      startedAt: z.number().int(),
      endedAt: z.number().int().nullable(),
    }),
  ),
});

const workers = await proofWorkers("computer-process-schema-proof");
const startWorker = workers.start;
const stopWorker = workers.stop;
let worker;

const { call } = proofClient(() => worker);

try {
  worker = await startWorker();
  // The constructor's schema check runs here, against the real Durable
  // Object SQLite binding: if `PRAGMA user_version` (or any replacement)
  // throws SQLITE_AUTH or anything else, this call fails.
  assert.deepEqual(processList.parse(await call("list_processes", {})), {
    processes: [],
  });

  // Reopening the same Durable Object (a fresh isolate, same storage) must
  // not re-run as a reset: it already saw the current schema version.
  await stopWorker(worker);
  worker = await startWorker();
  assert.deepEqual(processList.parse(await call("list_processes", {})), {
    processes: [],
  });

  process.stdout.write(
    `${JSON.stringify({
      proof: "computer-process-schema",
      verdict: "pass",
    })}\n`,
  );
} catch (error) {
  throw proofFailure(error, workers, worker);
} finally {
  if (worker) await stopWorker(worker);
  await workers.dispose();
}
