/* global fetch, console */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mintComputerRequestId } from "../dist/operation-contract.js";
import { proofWorkers } from "./proof-worker.mjs";

const workers = await proofWorkers("computer-app-method-proof");
let worker;
try {
  worker = await workers.start();
  const execute = (input, query = "?appMethod=1") =>
    fetch(`${worker.baseUrl}/operation${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  const tooLong = await execute({
    command: "true",
    timeoutMs: 45_001,
    requestId: mintComputerRequestId(),
  });
  assert.equal(
    tooLong.status,
    400,
    "App execution must refuse more than 45 seconds at native owner",
  );
  const input = {
    command: "printf app-native-ok",
    timeoutMs: 45_000,
    requestId: mintComputerRequestId(),
  };
  const first = await execute(input);
  assert.equal(first.status, 200, await first.clone().text());
  const recorded = await first.json();
  assert.equal(recorded.status, "succeeded");
  assert.equal(recorded.output.stdout, "app-native-ok");
  const replay = await execute(input);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), recorded);
  const conflicting = await execute({ ...input, command: "printf another" });
  assert.equal(conflicting.status, 409);
  const deniedInput = {
    command: "printf accepted-only-on-retry",
    requestId: mintComputerRequestId(),
  };
  const denied = await execute(deniedInput, "?appMethod=1&denyAcceptance=1");
  assert.equal(
    denied.status,
    500,
    "native admission refusal must prevent execution",
  );
  const acceptedRetry = await execute(deniedInput);
  assert.equal(acceptedRetry.status, 200);
  assert.equal(
    (await acceptedRetry.json()).output.stdout,
    "accepted-only-on-retry",
    "denied acceptance must not leave an accepted operation",
  );
  const cancellationId = mintComputerRequestId();
  const cancelledInput = {
    command: "sleep 2; printf orphan > /workspace/app-method-orphan.txt",
    timeoutMs: 45_000,
    requestId: cancellationId,
  };
  const cancelled = await execute(
    cancelledInput,
    "?appMethod=1&abortAfterMs=100",
  );
  assert.equal(cancelled.status, 200, await cancelled.clone().text());
  const interrupted = await cancelled.json();
  assert.deepEqual(interrupted, {
    requestId: cancellationId,
    status: "unknown",
    output: null,
  });
  const interruptedReplay = await execute(cancelledInput);
  assert.deepEqual(await interruptedReplay.json(), interrupted);
  await delay(2_200);
  const clean = await execute({
    command:
      "if test -e /workspace/app-method-orphan.txt; then printf leaked; else printf cleanup-ok; fi",
    requestId: mintComputerRequestId(),
  });
  assert.equal(clean.status, 200);
  assert.equal(
    (await clean.json()).output.stdout,
    "cleanup-ok",
    "interrupted process must not continue to write after the host returns",
  );
  const generic = await execute(
    {
      command: "printf generic-ok",
      timeoutMs: 120_000,
      requestId: mintComputerRequestId(),
    },
    "",
  );
  assert.equal(generic.status, 200);
  assert.equal((await generic.json()).output.stdout, "generic-ok");
  console.log(
    JSON.stringify({
      proof: "native-computer-app-execution",
      runtime: "workerd + computerd container",
      requestId: input.requestId,
      cancellationId,
      replay: "deduped",
      cancelled: "unknown",
      orphan: "absent",
      verdict: "PASS",
    }),
  );
} finally {
  if (worker !== undefined) await workers.stop(worker);
}
