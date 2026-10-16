/* global setTimeout */
// Real-container proof of Computer-owned process identity: a started process
// keeps its id and `running` state across Worker reconstruction, a kill is
// observed as an exit, and nothing is listed that computerd did not report.
import assert from "node:assert/strict";
import process from "node:process";
import { z } from "zod";
import { mintComputerRequestId } from "../dist/operation-contract.js";
import { proofWorkers } from "./proof-worker.mjs";
import { proofClient, proofFailure } from "./proof-client.mjs";

const processRow = z.strictObject({
  id: z.string(),
  command: z.string(),
  cwd: z.string().nullable(),
  port: z.number().int().nullable(),
  state: z.enum(["running", "exited", "uncertain"]),
  exitCode: z.number().int().nullable(),
  sync: z.enum(["synced", "pending"]),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
});
const processList = z.strictObject({ processes: z.array(processRow) });
const killResult = z.strictObject({
  process: processRow,
  signalled: z.boolean(),
});
const writeResult = z.strictObject({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
});
const readResult = z.strictObject({
  path: z.string(),
  content: z.string(),
});
const workers = await proofWorkers("computer-process-proof");
const startWorker = workers.start;
const stopWorker = workers.stop;
let worker;

const { call, json } = proofClient(() => worker);

async function hostStart(input) {
  return await json("/host-process-start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function listed(id) {
  const rows = processList.parse(await call("list_processes", {})).processes;
  return rows.find((row) => row.id === id);
}

async function exited(id) {
  const deadline = Date.now() + 15_000;
  let final = await listed(id);
  while (final?.state === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    final = await listed(id);
  }
  assert.equal(final?.state, "exited", "the exit is observed");
  return final;
}

try {
  worker = await startWorker();
  await assert.rejects(
    call("start_process", {
      requestId: "forged",
      requestScope: "installation:other",
      command: "true",
    }),
    /Unrecognized keys|unrecognized_keys/,
  );
  assert.deepEqual(
    processList.parse(await call("list_processes", {})).processes,
    [],
  );
  const modelStarted = processRow.parse(
    await call("start_process", { command: "true" }),
  );
  assert.equal(modelStarted.command, "true");
  assert.equal(modelStarted.port, null);
  await call("mkdir", { path: "/workspace" });
  const startInput = {
    requestId: "opaque-frame-start-key",
    requestScope: "owner:process-proof",
    command: "printf 'start\\n' >> /workspace/s1-start-count; sleep 600",
    cwd: "/workspace",
    port: 3000,
  };
  const started = processRow.parse(await hostStart(startInput));
  assert.equal(started.port, 3000);
  assert.deepEqual(await json("/ports"), { ports: [3000] });
  assert.equal(processRow.parse(await hostStart(startInput)).id, started.id);
  await assert.rejects(
    hostStart({ ...startInput, command: "other" }),
    /already bound/,
  );
  await assert.rejects(
    hostStart({ ...startInput, requestScope: "installation:other" }),
    /Computer port is unavailable/,
  );
  assert.deepEqual(await json("/ports"), { ports: [3000] });
  assert.equal(started.state, "running");
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assert.equal((await listed(started.id))?.state, "running");
  assert.equal(
    (await call("bash", { command: "cat /workspace/s1-start-count" })).stdout,
    "start\n",
    "computerd executes the replayed start once",
  );

  // Worker reconstruction drops every isolate map; identity is durable.
  await stopWorker(worker);
  worker = await startWorker();
  const afterReconstruction = await listed(started.id);
  assert.ok(afterReconstruction, "the process id survives reconstruction");
  assert.notEqual(
    afterReconstruction.state,
    "uncertain",
    "a reachable container gives a definite state",
  );

  assert.equal(processRow.parse(await hostStart(startInput)).id, started.id);
  const oldKill = killResult.parse(
    await call("kill_process", { id: started.id }),
  );
  assert.equal(oldKill.signalled, afterReconstruction.state === "running");
  await exited(started.id);
  assert.deepEqual(
    await json("/ports"),
    { ports: [] },
    "a gone container cannot retain an owned exposure",
  );
  const survivorPorts = [];
  const sleeper = processRow.parse(
    await hostStart({
      requestId: mintComputerRequestId(),
      requestScope: "owner:process-proof",
      command: "sleep 600",
      port: 3001,
    }),
  );
  const killed = killResult.parse(
    await call("kill_process", { id: sleeper.id }),
  );
  assert.equal(killed.signalled, true);
  await exited(sleeper.id);
  assert.deepEqual(await json("/ports"), { ports: survivorPorts });

  const quick = processRow.parse(
    await hostStart({
      requestId: mintComputerRequestId(),
      requestScope: "owner:process-proof",
      command: "exit 3",
      port: 3002,
    }),
  );
  const settled = await exited(quick.id);
  assert.equal(settled?.exitCode, 3, "the exit code is observed");
  assert.deepEqual(await json("/ports"), { ports: survivorPorts });

  const transferred = processRow.parse(
    await hostStart({
      requestId: "manual-transfer",
      requestScope: "owner:process-proof",
      command: "sleep 600",
      port: 3003,
    }),
  );
  await json("/ports/expose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ port: 3003 }),
  });
  await call("kill_process", { id: transferred.id });
  await exited(transferred.id);
  assert.deepEqual(
    await json("/ports"),
    { ports: [3003] },
    "manual re-expose survives its former process",
  );
  await json("/ports/unexpose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ port: 3003 }),
  });

  // Storyboard Save's root cause: a container command's own files (a
  // `git clone`-shaped mkdir/write) must reach the Workspace before the
  // Computer's own, non-exec Files write can see their directory. Before
  // the fix, the process is observed exited well before computerd's
  // post-command pull has landed `/workspace/p/q`, so the write below
  // fails with "parent directory missing".
  const fileSync = processRow.parse(
    await hostStart({
      requestId: mintComputerRequestId(),
      requestScope: "owner:process-proof",
      command: "mkdir -p /workspace/p/q && echo x > /workspace/p/q/f",
    }),
  );
  const fileSyncSettled = await exited(fileSync.id);
  assert.equal(fileSyncSettled.exitCode, 0);
  assert.equal(
    fileSyncSettled.sync,
    "synced",
    "a clean exit with a landed pull is reported as synced",
  );
  const written = writeResult.parse(
    await call("write", { path: "/workspace/p/q/g", content: "y" }),
  );
  assert.equal(written.path, "/workspace/p/q/g");
  const readBack = readResult.parse(
    await call("read", { path: "/workspace/p/q/f" }),
  );
  assert.equal(
    readBack.content,
    "x",
    "the container's own file reached the Workspace",
  );

  process.stdout.write(
    `${JSON.stringify({
      proof: "computer-process-identity",
      verdict: "pass",
      stateAfterReconstruction: afterReconstruction.state,
    })}\n`,
  );
} catch (error) {
  throw proofFailure(error, workers, worker);
} finally {
  if (worker) await stopWorker(worker);
  await workers.dispose();
}
