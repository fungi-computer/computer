/* global fetch, console */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  computerOperationResultSchema,
  mintComputerRequestId,
  maximumProcessRecords,
} from "@fungi.computer/computer-contract";
import { proofWorkers } from "./proof-worker.mjs";

const carriageResultSchema = z.strictObject({
  operation: computerOperationResultSchema,
  opens: z.number().int().nonnegative(),
  renewals: z.number().int().nonnegative(),
  closes: z.number().int().nonnegative(),
  lifecycleIds: z.array(z.string().min(1)),
  processOwnerIds: z.array(z.string().min(1)),
  sqlSecretFree: z.boolean().nullable(),
  sqlPublicContext: z.boolean(),
  sqlBackendReceipt: z.boolean().nullable(),
});

test("same native env and stdin carriage seed", async () => {
  const workers = await proofWorkers("computer-execution-carriage-proof");
  let worker;
  try {
    worker = await workers.start();
    const requestId = mintComputerRequestId();
    const execute = () =>
      fetch(`${worker.baseUrl}/execution-carriage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
    const response = await execute();
    assert.equal(response.status, 200, "protected native dispatch must reply");
    const first = carriageResultSchema.parse(await response.json());
    console.log(
      JSON.stringify({
        proof: "native-execution-carriage-observation",
        status: first.operation.status,
        exitCode: first.operation.output?.exitCode ?? null,
        opens: first.opens,
        renewals: first.renewals,
        closes: first.closes,
        sqlSecretFree: first.sqlSecretFree,
        sqlPublicContext: first.sqlPublicContext,
        sqlBackendReceipt: first.sqlBackendReceipt,
        expectedOutput:
          first.operation.output?.stdout === "carried" &&
          first.operation.output?.stderr === "",
      }),
    );
    assert.equal(
      first.operation.status,
      "succeeded",
      "the same native invocation must receive host-only environment and stdin",
    );
    assert.equal(first.operation.output.exitCode, 0);
    assert.equal(first.operation.output.stdout === "carried", true);
    assert.equal(first.operation.output.stderr === "", true);
    assert.equal(first.opens, 1, "NEW native admission issues once");
    assert.equal(first.renewals, 0, "bounded exec never renews");
    assert.equal(first.closes, 1);
    assert.equal(first.sqlSecretFree, true);
    assert.equal(first.sqlBackendReceipt, true);
    assert.equal(
      first.sqlPublicContext,
      true,
      "durable context is public-only",
    );

    const replayResponse = await execute();
    assert.equal(replayResponse.status, 200);
    const replay = carriageResultSchema.parse(await replayResponse.json());
    assert.equal(
      JSON.stringify(replay.operation) === JSON.stringify(first.operation),
      true,
      "replay must return the same non-secret result",
    );
    assert.equal(replay.opens, 1, "replay must not issue or redispatch");
    assert.equal(replay.renewals, 0);
    assert.equal(replay.closes, 1);
    assert.equal(replay.sqlSecretFree, true);
    assert.equal(replay.sqlPublicContext, true);
    assert.equal(replay.sqlBackendReceipt, true);
    console.log(
      JSON.stringify({
        proof: "native-execution-carriage",
        runtime: "workerd + computerd container",
        requestId,
        envAndStdin: "same invocation",
        replay: "deduped",
        sql: "secret-free",
        verdict: "PASS",
      }),
    );
  } finally {
    if (worker !== undefined) await workers.stop(worker);
  }
});

const executionSnapshotSchema = z.object({
  watchedOwnerState: z.enum(["running", "exited"]).nullable(),
  watchedInvocationPhase: z
    .enum(["opening", "dispatching", "open", "closed"])
    .nullable(),
  watchedScopeRecords: z.number().int().nonnegative().nullable(),
  invocationPhase: z
    .enum(["opening", "dispatching", "open", "closed"])
    .nullable(),
  ownerState: z.enum(["running", "exited"]).nullable(),
  ownerStartedAt: z.number().int().nullable(),
  lifecycleIds: z.array(z.string().min(1)),
  processOwnerIds: z.array(z.string().min(1)),
  pullCalls: z.number().int().nonnegative(),
  pullsAtDispatch: z.number().int().nonnegative(),
  probeTrace: z.array(z.string()),
  watcherOutputHeld: z.boolean(),
  exitWitnessBusy: z.number().int().nonnegative(),
  nativeBackendRunning: z.boolean().nullable(),
  opens: z.number().int().nonnegative(),
  renewals: z.number().int().nonnegative(),
  closes: z.number().int().nonnegative(),
  nativeDispatches: z.number().int().nonnegative(),
  nativeProbes: z.number().int().nonnegative(),
  workspaceReads: z.number().int().nonnegative(),
  renewProofs: z.array(z.boolean()),
  startSettled: z.boolean(),
  invocationId: z.string().nullable(),
  processId: z.string().nullable(),
  processState: z.enum(["running", "exited", "uncertain"]).nullable(),
  processExitCode: z.number().int().nullable(),
  live: z.boolean().nullable(),
  startRejected: z.boolean(),
  execSettled: z.boolean(),
  execSucceeded: z.boolean().nullable(),
  execStatus: computerOperationResultSchema.shape.status.nullable(),
  killSettled: z.boolean(),
  killRejected: z.boolean(),
  killSignalled: z.boolean().nullable(),
  closeReasons: z.array(
    z.enum(["refused_start", "native_exit", "unknown", "reconstructed"]),
  ),
  closedBeforeCallbacks: z.array(z.boolean().nullable()),
  nativeExitBeforeCallbacks: z.array(z.boolean().nullable()),
  rawNativeAvailable: z.boolean(),
  nativeExitCode: z.number().int().nullable(),
  nativeReady: z.boolean(),
  sqlSecretFree: z.boolean().nullable(),
  sqlPublicContext: z.boolean(),
  sqlBackendReceipt: z.boolean().nullable(),
});

async function withExecutionLaw(run) {
  const workers = await proofWorkers("computer-execution-law");
  let worker = await workers.start();
  const requestId = mintComputerRequestId();
  const call = async (action, input = {}) => {
    const response = await fetch(`${worker.baseUrl}/execution-law`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, requestId, ...input }),
    });
    assert.equal(response.status, 200, "test host action must reply");
    return executionSnapshotSchema.parse(await response.json());
  };
  try {
    await run({
      call,
      evict: async () => {
        const response = await fetch(`${worker.baseUrl}/execution-law`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "evict", requestId }),
        });
        assert.equal(
          response.status,
          500,
          "the deliberate maintained DO abort terminates the control request, not a native process",
        );
      },
      restart: async () => {
        await workers.stop(worker);
        worker = await workers.start();
      },
    });
  } finally {
    try {
      await call("cleanup");
    } finally {
      await workers.stop(worker);
      await workers.dispose();
    }
  }
}

async function observed(call, predicate) {
  const deadline = Date.now() + 15_000;
  let snapshot = await call("snapshot");
  while (!predicate(snapshot) && Date.now() < deadline) {
    await delay(250);
    snapshot = await call("snapshot");
  }
  return snapshot;
}

test("renew only after proven native liveness, never while host open is pending", async () => {
  await withExecutionLaw(async ({ call }) => {
    await call("pending-process");
    const opening = await observed(
      call,
      (snapshot) => snapshot.opens === 1 || snapshot.startSettled,
    );
    assert.equal(opening.opens, 1, "NEW must enter the real host open");
    assert.equal(opening.sqlBackendReceipt, true);
    assert.equal(
      opening.nativeDispatches,
      0,
      "host gate precedes native dispatch",
    );
    const absent = await call("probe");
    assert.equal(absent.live, false, "warm opening is not native liveness");
    assert.equal(absent.renewals, 0, "absent-yet native work cannot renew");
    const started = await call("release-open");
    assert.equal(started.nativeDispatches, 1);
    const live = await call("probe");
    assert.equal(
      live.live,
      true,
      "released process requires real native proof",
    );
    assert.ok(live.nativeProbes > absent.nativeProbes);
    assert.ok(
      live.renewProofs.every(Boolean),
      "every renewal follows native proof",
    );
  });
});

test("refused start durably closes authority before host close with refused_start", async () => {
  await withExecutionLaw(async ({ call }) => {
    const refused = await call("refused-process");
    assert.equal(refused.opens, 1, "host issuance was attempted after NEW");
    assert.equal(
      refused.startRejected,
      true,
      "issuance refusal prevents native start",
    );
    assert.equal(refused.nativeDispatches, 0);
    assert.equal(refused.closes, 1);
    assert.deepEqual(refused.closeReasons, ["refused_start"]);
    assert.deepEqual(refused.closedBeforeCallbacks, [true]);
  });
});

test("native_exit follows proven native exit, never process-start return or SIGTERM acceptance", async () => {
  await withExecutionLaw(async ({ call }) => {
    const started = await call("process");
    assert.equal(started.opens, 1);
    assert.equal(started.startRejected, false);
    assert.equal(started.nativeDispatches, 1);
    assert.equal(
      started.closes,
      0,
      "start returning must not close live authority",
    );
    assert.equal((await call("probe")).live, true);
    await call("stop");
    const exited = await observed(call, (snapshot) => snapshot.closes !== 0);
    assert.equal(exited.closes, 1, "native completion owner must close");
    assert.deepEqual(exited.closeReasons, ["native_exit"]);
    assert.deepEqual(exited.closedBeforeCallbacks, [true]);
    assert.deepEqual(
      exited.nativeExitBeforeCallbacks,
      [true],
      "an actual native exit event, not SIGTERM acceptance, precedes host close",
    );
    assert.equal((await call("probe")).live, false);
  });
});

test("cold exec reconstruction closes unfinished host-open without native probe or redispatch", async () => {
  await withExecutionLaw(async ({ call, restart }) => {
    await call("pending-exec");
    const opening = await observed(
      call,
      (snapshot) => snapshot.opens === 1 || snapshot.execSettled,
    );
    assert.equal(opening.opens, 1);
    assert.equal(
      opening.execSettled,
      false,
      "host open is held across reconstruction",
    );
    assert.equal(opening.nativeDispatches, 0);
    await restart();
    const cold = await observed(call, (snapshot) => snapshot.closes !== 0);
    assert.equal(cold.opens, 0, "reconstruction must not reissue");
    assert.equal(cold.closes, 1);
    assert.deepEqual(cold.closeReasons, ["reconstructed"]);
    assert.deepEqual(cold.closedBeforeCallbacks, [true]);
    assert.equal(cold.nativeDispatches, 0);
    assert.equal(cold.nativeProbes, 0);
    assert.equal(
      cold.workspaceReads,
      0,
      "closing cold exec must not wake its backend",
    );
  });
});

test("same-key process replay never issues, rotates, or redispatches", async () => {
  await withExecutionLaw(async ({ call }) => {
    const first = await call("process");
    assert.equal(first.opens, 1);
    assert.equal(first.nativeDispatches, 1);
    assert.equal((await call("probe")).live, true);
    const replay = await call("replay-process");
    assert.equal(
      replay.processId,
      first.processId,
      "replay returns admitted native identity",
    );
    assert.equal(replay.invocationId, first.invocationId);
    assert.equal(replay.opens, 1, "issuer open is the only presenter mint");
    assert.equal(
      replay.nativeDispatches,
      1,
      "no credential-less second native start",
    );
    assert.equal(replay.closes, 0);
    assert.ok(
      replay.renewProofs.every(Boolean),
      "replay renewal requires actual proof",
    );
  });
});

test("executionContext is durable public cargo and real SQL contains no carriage presenter", async () => {
  await withExecutionLaw(async ({ call }) => {
    const executed = await call("exec");
    assert.equal(
      executed.opens,
      1,
      "secrecy must examine a real issued presenter",
    );
    assert.equal(executed.nativeDispatches, 1);
    assert.equal(executed.sqlBackendReceipt, true);
    assert.equal(
      executed.sqlPublicContext,
      true,
      "non-secret host context survives in SQLite",
    );
    assert.equal(
      executed.sqlSecretFree,
      true,
      "no issued env/stdin presenter may occur in any durable table",
    );
  });
});

test("Uint8Array stdin and environment reach the very same actual native exec", async () => {
  await withExecutionLaw(async ({ call }) => {
    const carried = await call("exec-bytes");
    assert.equal(carried.opens, 1);
    assert.equal(carried.nativeDispatches, 1);
    assert.equal(
      carried.execSucceeded,
      true,
      "fixed child compares its own stdin with its own env and emits only carried",
    );
    assert.equal(carried.renewals, 0);
    assert.equal(carried.closes, 1);
    assert.deepEqual(carried.closeReasons, ["native_exit"]);
    assert.deepEqual(carried.closedBeforeCallbacks, [true]);
    assert.equal(carried.sqlSecretFree, true);
    assert.equal(carried.sqlBackendReceipt, true);
  });
});

test("warm host-open cancellation fences authority with zero native SDK dispatch", async () => {
  await withExecutionLaw(async ({ call }) => {
    await call("pending-process");
    const opening = await observed(call, (snapshot) => snapshot.opens === 1);
    assert.equal(opening.nativeDispatches, 0);
    assert.equal(opening.startSettled, false);
    await call("cancel");
    const cancelled = await observed(call, (snapshot) => snapshot.killSettled);
    assert.equal(
      cancelled.killSettled,
      true,
      "cancelling host-open does not await issuance",
    );
    assert.equal(cancelled.nativeDispatches, 0);
    assert.equal(cancelled.closes, 1);
    assert.deepEqual(cancelled.closeReasons, ["refused_start"]);
    assert.deepEqual(cancelled.closedBeforeCallbacks, [true]);
    const released = await call("release-open");
    assert.equal(
      released.startRejected,
      true,
      "late host issuance cannot resurrect cancellation",
    );
    assert.equal(released.nativeDispatches, 0);
    assert.equal(released.closes, 1);
    assert.equal(
      cancelled.killRejected,
      false,
      "the maintained kill API returns its valid receipt, not a missing-row parse failure",
    );
    assert.equal(cancelled.killSignalled, false);
  });
});

test("pending SDK cancellation awaits the actual raw handle then sends SIGTERM to that invocation", async () => {
  await withExecutionLaw(async ({ call }) => {
    await call("pending-sdk-process");
    const pending = await observed(
      call,
      (snapshot) => snapshot.rawNativeAvailable,
    );
    assert.equal(pending.opens, 1);
    assert.equal(pending.nativeDispatches, 1);
    assert.equal(pending.startSettled, false);
    await call("cancel");
    const waiting = await call("snapshot");
    assert.equal(
      waiting.killSettled,
      false,
      "kill waits for the real SDK receipt",
    );
    assert.equal(
      waiting.nativeProbes,
      0,
      "pending receipt is not reconciled as absent",
    );
    assert.equal(waiting.closes, 0);
    const released = await call("release-sdk");
    assert.equal(released.killRejected, false);
    assert.equal(released.killSignalled, true);
    assert.equal(released.nativeDispatches, 1);
    const exited = await observed(call, (snapshot) => snapshot.closes !== 0);
    assert.equal(
      exited.nativeExitCode,
      143,
      "the fixed sleep child exits from SIGTERM, not SIGKILL",
    );
    assert.deepEqual(exited.closeReasons, ["native_exit"]);
    assert.deepEqual(exited.nativeExitBeforeCallbacks, [true]);
    assert.deepEqual(exited.closedBeforeCallbacks, [true]);
  });
});

test("ignored SIGTERM does not prove native exit or close credential authority", async () => {
  await withExecutionLaw(async ({ call }) => {
    await call("ignored-term-process");
    const ready = await observed(call, (snapshot) => snapshot.nativeReady);
    assert.equal(
      ready.nativeReady,
      true,
      "the actual child has installed its TERM-ignore trap",
    );
    assert.equal(ready.nativeDispatches, 1);
    assert.equal(ready.closes, 0);
    await call("cancel");
    const signalled = await observed(call, (snapshot) => snapshot.killSettled);
    assert.equal(signalled.killSettled, true);
    assert.equal(signalled.killRejected, false);
    assert.equal(signalled.killSignalled, true);
    const alive = await call("probe");
    assert.equal(
      alive.live,
      true,
      "the real native invocation is still live after accepted SIGTERM",
    );
    assert.equal(alive.nativeExitCode, null);
    assert.equal(
      alive.closes,
      0,
      "signal acceptance is not a native-exit receipt",
    );
    await call("force-stop");
    const exited = await observed(call, (snapshot) => snapshot.closes !== 0);
    assert.equal(
      exited.nativeExitCode,
      137,
      "only the test's actual SIGKILL ends this fixed child",
    );
    assert.deepEqual(exited.closeReasons, ["native_exit"]);
    assert.deepEqual(exited.nativeExitBeforeCallbacks, [true]);
    assert.deepEqual(exited.closedBeforeCallbacks, [true]);
  });
});

test("actual spawn with a lost dispatch reply stays uncertain and closed on replay", async () => {
  await withExecutionLaw(async ({ call }) => {
    const lost = await call("lost-reply-process");
    assert.equal(
      lost.rawNativeAvailable,
      true,
      "the maintained SDK returned an actual native handle before its reply was lost",
    );
    assert.equal(lost.startSettled, true);
    assert.equal(lost.startRejected, false);
    assert.equal(lost.processState, "uncertain");
    assert.equal(lost.processExitCode, null);
    assert.equal(
      lost.nativeExitCode,
      null,
      "a lost reply is not a native exit",
    );
    assert.equal(lost.opens, 1);
    assert.equal(lost.nativeDispatches, 1);
    assert.deepEqual(lost.closeReasons, ["unknown"]);
    assert.deepEqual(lost.closedBeforeCallbacks, [true]);
    assert.equal(lost.sqlSecretFree, true);
    assert.equal(lost.sqlPublicContext, true);
    assert.equal(
      lost.sqlBackendReceipt,
      true,
      "no delivered receipt was recorded as native-opened",
    );
    const replay = await call("replay-process");
    assert.equal(replay.processId, lost.processId);
    assert.equal(replay.processState, "uncertain");
    assert.equal(replay.opens, 1);
    assert.equal(replay.nativeDispatches, 1);
    assert.equal(replay.renewals, 0);
    assert.equal(replay.closes, 1);
    const reconciled = await call("reconcile");
    assert.ok(
      reconciled.nativeProbes > 0,
      "the actual native process is reconciled, not invented from the uncertain row",
    );
    assert.equal(reconciled.processState, "running");
    assert.equal(reconciled.processExitCode, null);
    const denied = await call("probe");
    assert.equal(
      denied.live,
      false,
      "reconciling a running process cannot reopen closed credential authority",
    );
    assert.equal(denied.nativeProbes, reconciled.nativeProbes);
    assert.equal(denied.opens, 1);
    assert.equal(denied.nativeDispatches, 1);
    assert.equal(denied.renewals, 0);
    assert.equal(denied.closes, 1);
  });
});

test("cold after-dispatch process reconstruction reconciles the actual native invocation", async () => {
  await withExecutionLaw(async ({ call, evict }) => {
    await call("pending-sdk-process");
    const dispatched = await observed(
      call,
      (snapshot) => snapshot.rawNativeAvailable,
    );
    assert.equal(dispatched.rawNativeAvailable, true);
    assert.equal(dispatched.nativeDispatches, 1);
    assert.equal(dispatched.startSettled, false);
    assert.ok(dispatched.invocationId);
    const processId = dispatched.invocationId;
    await evict();
    const cold = await call("snapshot");
    assert.equal(cold.opens, 0);
    assert.equal(cold.nativeDispatches, 0);
    assert.equal(cold.nativeProbes, 0);
    assert.equal(cold.workspaceReads, 0);
    assert.equal(
      cold.closes,
      0,
      "cold process dispatch is not guessed to have exited",
    );
    assert.equal(
      cold.nativeBackendRunning,
      true,
      "native proof precondition: the actual backend must survive isolate eviction before claiming cold live reconciliation",
    );
    const reconciled = await call("reconcile", { processId });
    assert.equal(reconciled.processId, processId);
    assert.equal(reconciled.processState, "running");
    assert.equal(reconciled.processExitCode, null);
    assert.ok(
      reconciled.nativeProbes > 0,
      "running requires actual maintained native reconciliation",
    );
    assert.equal(reconciled.opens, 0);
    assert.equal(reconciled.nativeDispatches, 0);
    assert.equal(reconciled.closes, 0);
    const live = await call("probe", { processId });
    assert.equal(live.live, true);
    assert.ok(live.nativeProbes > reconciled.nativeProbes);
    const replay = await call("replay-process");
    assert.equal(replay.processId, processId);
    assert.equal(replay.opens, 0, "cold replay cannot issue another presenter");
    assert.equal(replay.nativeDispatches, 0);
    await call("cancel");
    const accepted = await observed(call, (snapshot) => snapshot.killSettled);
    assert.equal(accepted.killRejected, false);
    assert.equal(accepted.killSignalled, true);
    const exited = await call("reconcile", { processId });
    assert.equal(exited.processState, "exited");
    assert.equal(exited.processExitCode, 143);
    assert.equal(exited.nativeExitCode, 143);
    assert.deepEqual(exited.closeReasons, ["native_exit"]);
    assert.deepEqual(exited.nativeExitBeforeCallbacks, [true]);
    assert.deepEqual(exited.closedBeforeCallbacks, [true]);
  });
});

test("cold exec after actual dispatch closes without Workspace, probe or redispatch", async () => {
  await withExecutionLaw(async ({ call, evict }) => {
    await call("pending-sdk-exec");
    const dispatched = await observed(
      call,
      (snapshot) => snapshot.rawNativeAvailable,
    );
    assert.equal(dispatched.rawNativeAvailable, true);
    assert.equal(dispatched.nativeDispatches, 1);
    assert.equal(dispatched.execSettled, false);
    assert.equal(dispatched.closes, 0);
    await evict();
    const cold = await observed(call, (snapshot) => snapshot.closes !== 0);
    assert.equal(
      cold.nativeBackendRunning,
      true,
      "native proof precondition: the actual backend survived isolate eviction",
    );
    assert.deepEqual(cold.closeReasons, ["reconstructed"]);
    assert.deepEqual(cold.closedBeforeCallbacks, [true]);
    assert.equal(cold.opens, 0);
    assert.equal(cold.renewals, 0);
    assert.equal(cold.nativeDispatches, 0);
    assert.equal(cold.nativeProbes, 0);
    assert.equal(cold.workspaceReads, 0);
    const replay = await call("replay-sdk-exec");
    assert.equal(replay.execSettled, true);
    assert.equal(replay.execStatus, "unknown");
    assert.equal(
      replay.execSucceeded,
      false,
      "the lost exec result is not invented as success",
    );
    assert.equal(replay.opens, 0);
    assert.equal(replay.renewals, 0);
    assert.equal(replay.nativeDispatches, 0);
    assert.equal(replay.nativeProbes, 0);
    assert.equal(replay.workspaceReads, 0);
    assert.equal(replay.closes, 1);
  });
});

test("native exit before post-pull denies authority with two unread gets and reverse disposal", async () => {
  await withExecutionLaw(async ({ call }) => {
    await call("held-exit-process");
    await observed(call, (snapshot) => snapshot.watcherOutputHeld);
    const exited = await observed(
      () => call("witness-exit"),
      (snapshot) => snapshot.nativeExitCode === 0,
    );
    assert.equal(exited.watcherOutputHeld, true);
    assert.ok(exited.processId);
    assert.equal(
      exited.closes,
      0,
      "the real exit has not been delivered to the original watcher",
    );
    assert.equal(exited.invocationPhase, "open");
    assert.equal(
      exited.pullCalls,
      exited.pullsAtDispatch,
      "native proof precondition: post-command pull has not started",
    );
    const processId = exited.processId;
    const pulls = exited.pullCalls;
    const denied = await call("probe", { processId });
    assert.equal(denied.live, false);
    assert.equal(
      denied.nativeProbes,
      exited.nativeProbes + 2,
      "the guard acquired exactly two actual unread handles after the independent exit witness",
    );
    assert.deepEqual(denied.probeTrace, [
      "get:1",
      "acquired:1",
      "get:2",
      "acquired:2",
      "cancel:2",
      "cancel:1",
    ]);
    assert.equal(
      denied.pullCalls,
      pulls,
      "unread liveness handles did not pull or consume the original watcher's result",
    );
    assert.equal(denied.invocationPhase, "closed");
    assert.deepEqual(denied.closeReasons, ["native_exit"]);
    assert.deepEqual(denied.nativeExitBeforeCallbacks, [true]);
    assert.deepEqual(denied.closedBeforeCallbacks, [true]);
    const again = await call("probe", { processId });
    assert.equal(again.live, false);
    assert.deepEqual(again.probeTrace, []);
    assert.equal(again.nativeProbes, denied.nativeProbes);
    assert.equal(again.pullCalls, pulls);
    assert.equal(again.closes, 1);
    await call("release-exit");
    const drained = await observed(
      call,
      (snapshot) =>
        snapshot.ownerState === "exited" && snapshot.pullCalls > pulls,
    );
    assert.equal(drained.closes, 1);
    assert.equal(drained.nativeExitCode, 0);
  });
});

test("existing scoped process retention prunes only eligible closed metadata and preserves replay", async () => {
  await withExecutionLaw(async ({ call, evict }) => {
    const scopeA = "retention-a";
    const scopeB = "retention-b";
    const anchor = await call("process", { requestScope: scopeA });
    assert.ok(anchor.processId);
    const anchorId = anchor.processId;
    assert.equal(anchor.nativeDispatches, 1);
    await call("retain-anchor");
    const initiallyLive = await call("probe", { processId: anchorId });
    assert.equal(
      initiallyLive.live,
      true,
      "the anchor has actual native authority before history churn",
    );
    const sideRequest = mintComputerRequestId();
    const side = await call("refused-process", {
      requestId: sideRequest,
      requestScope: scopeB,
    });
    assert.ok(side.invocationId);
    const sideId = side.invocationId;
    const oldestRequest = mintComputerRequestId();
    const oldest = await call("refused-process", {
      requestId: oldestRequest,
      requestScope: scopeA,
    });
    assert.ok(oldest.invocationId);
    assert.equal(oldest.startRejected, true);
    assert.equal(oldest.closeReasons.at(-1), "refused_start");
    assert.equal(oldest.closedBeforeCallbacks.at(-1), true);
    const oldestId = oldest.invocationId;
    const retained = await call("watch", {
      processId: oldestId,
      requestScope: scopeA,
    });
    assert.equal(retained.watchedOwnerState, "exited");
    assert.equal(retained.watchedInvocationPhase, "closed");
    const replay = await call("refused-process", {
      requestId: oldestRequest,
      requestScope: scopeA,
    });
    assert.equal(replay.processId, oldestId);
    assert.equal(replay.processState, "exited");
    assert.equal(
      replay.processExitCode,
      null,
      "release retains a failed-start receipt, not a fabricated native exit",
    );
    assert.equal(replay.opens, retained.opens);
    assert.equal(replay.closes, retained.closes);
    assert.equal(replay.nativeDispatches, 1);
    // Ordinary NEW admissions followed by host refusal exercise the existing
    // process owner, without another native spawn, direct SQL fixtures or clock.
    const churn = [];
    for (let index = 0; index < maximumProcessRecords; index++) {
      const admission = await call("refused-process", {
        requestId: mintComputerRequestId(),
        requestScope: scopeA,
      });
      assert.ok(admission.invocationId);
      assert.notEqual(admission.ownerStartedAt, null);
      churn.push({
        id: admission.invocationId,
        startedAt: admission.ownerStartedAt,
      });
    }
    const lastAdmission = churn.at(-1);
    assert.ok(lastAdmission);
    const priorNewest = churn.slice(0, -1).sort((left, right) => {
      if (left.startedAt !== right.startedAt)
        return right.startedAt - left.startedAt;
      if (left.id === right.id) return 0;
      return left.id > right.id ? -1 : 1;
    });
    // On the last NEW admission, the anchor and incoming row are running:
    // 62 prior exited rows + that newly released row fill the retained 64.
    const expectedRetainedIds = [
      anchorId,
      sideId,
      lastAdmission.id,
      ...priorNewest.slice(0, maximumProcessRecords - 2).map((row) => row.id),
    ].sort();
    const pruned = await call("watch", {
      processId: oldestId,
      requestScope: scopeA,
    });
    assert.equal(pruned.watchedScopeRecords, maximumProcessRecords);
    assert.equal(pruned.opens, replay.opens + maximumProcessRecords);
    assert.equal(pruned.closes, replay.closes + maximumProcessRecords);
    assert.equal(
      pruned.watchedOwnerState,
      null,
      "the process owner legitimately evicted its oldest terminal admission",
    );
    assert.equal(
      pruned.watchedInvocationPhase,
      null,
      "begin may prune that closed orphan only after owner eviction",
    );
    assert.equal(pruned.nativeDispatches, 1);
    assert.equal(pruned.sqlSecretFree, true);
    assert.deepEqual(
      [...pruned.processOwnerIds].sort(),
      expectedRetainedIds,
      "current process-owner IDs exactly match retained admission identities",
    );
    assert.deepEqual(
      [...pruned.lifecycleIds].sort(),
      expectedRetainedIds,
      "current lifecycle IDs exactly match retained admission identities: no missing or extra row",
    );
    assert.equal(pruned.sqlPublicContext, true);
    const otherScope = await call("watch", {
      processId: sideId,
      requestScope: scopeB,
    });
    assert.equal(otherScope.watchedScopeRecords, 1);
    assert.equal(otherScope.watchedOwnerState, "exited");
    assert.equal(otherScope.watchedInvocationPhase, "closed");
    const active = await call("watch", {
      processId: anchorId,
      requestScope: scopeA,
    });
    assert.equal(active.watchedOwnerState, "running");
    assert.equal(active.watchedInvocationPhase, "open");
    const live = await call("probe", { processId: anchorId });
    assert.equal(
      live.live,
      true,
      "terminal history churn did not remove actual live process authority",
    );
    assert.equal(live.nativeDispatches, 1);
    await call("stop-anchor");
    const exited = await observed(
      call,
      (snapshot) => snapshot.watchedOwnerState === "exited",
    );
    assert.equal(exited.nativeExitCode, 143);
    assert.equal(exited.closeReasons.at(-1), "native_exit");
    assert.equal(exited.closedBeforeCallbacks.at(-1), true);
    assert.equal(exited.nativeExitBeforeCallbacks.at(-1), true);
    await evict();
    const reopened = await call("watch", {
      processId: sideId,
      requestScope: scopeB,
    });
    assert.equal(reopened.watchedOwnerState, "exited");
    assert.equal(reopened.watchedInvocationPhase, "closed");
    assert.deepEqual([...reopened.processOwnerIds].sort(), expectedRetainedIds);
    assert.deepEqual([...reopened.lifecycleIds].sort(), expectedRetainedIds);
    assert.equal(reopened.opens, 0);
    assert.equal(reopened.renewals, 0);
    assert.equal(reopened.nativeDispatches, 0);
    assert.equal(reopened.nativeProbes, 0);
    assert.equal(reopened.workspaceReads, 0);
    assert.equal(reopened.closes, 0);
    const replayed = await call("refused-process", {
      requestId: sideRequest,
      requestScope: scopeB,
    });
    assert.equal(replayed.processId, sideId);
    assert.equal(replayed.processState, "exited");
    assert.equal(replayed.processExitCode, null);
    assert.equal(replayed.opens, 0);
    assert.equal(replayed.renewals, 0);
    assert.equal(replayed.nativeDispatches, 0);
    assert.equal(replayed.nativeProbes, 0);
    assert.equal(replayed.workspaceReads, 0);
    assert.equal(replayed.closes, 0);
  });
});
