/* global AbortController, fetch, setTimeout */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { URLSearchParams } from "node:url";
import { z } from "zod";
import { proofWorkers } from "./proof-worker.mjs";
import { proofFailure } from "./proof-client.mjs";

const capabilitiesResult = z.array(
  z.object({
    id: z.string(),
    parameters: z.json(),
  }),
);
const readResult = z.strictObject({ path: z.string(), content: z.string() });
const replaceResult = z.strictObject({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
});
const filesReadResult = z.strictObject({
  path: z.string(),
  content: z.string(),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
});
const execResult = z.strictObject({
  status: z.enum(["completed", "failed", "cancelled"]),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
});
// computerd mounts the /workspace VFS subtree at the same absolute path.
const proofPath = "/workspace/computer-proof.txt";
const proofContent = `computer-proof-${randomUUID()}`;
const workers = await proofWorkers("computer-proof");
const startWorker = workers.start;
const stopWorker = workers.stop;

async function call(worker, capability, input) {
  const response = await fetch(`${worker.baseUrl}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability, input }),
  });
  if (!response.ok) {
    throw new Error(`Computer ${capability} failed: ${await response.text()}`);
  }
  const result = await response.json();
  return capability === "exec" || capability === "bash"
    ? result.output
    : result;
}

async function expectCallFailure(worker, capability, input) {
  const response = await fetch(`${worker.baseUrl}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability, input }),
  });
  if (response.ok) {
    throw new Error(`Computer ${capability} unexpectedly succeeded`);
  }
}

function uuidv7(createdAt = Date.now()) {
  const timestamp = createdAt.toString(16).padStart(12, "0");
  const random = randomUUID().replaceAll("-", "");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${random.slice(1, 4)}-8${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

async function operation(worker, input) {
  return await fetch(`${worker.baseUrl}/operation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function operationStatus(worker, requestId) {
  return await fetch(`${worker.baseUrl}/operation-status/${requestId}`);
}

function replaceResponse(worker, input, path = "/replace") {
  return fetch(`${worker.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function filesRead(worker, input) {
  const response = await fetch(`${worker.baseUrl}/files/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Computer Files read failed: ${await response.text()}`);
  }
  return response.json();
}

let worker;
async function proveRuntime() {
  worker = await startWorker();
  const capabilities = capabilitiesResult.parse(
    await (await fetch(`${worker.baseUrl}/capabilities`)).json(),
  );
  const advertised = capabilities.map(({ id }) => id);
  for (const expected of [
    "read",
    "list",
    "mkdir",
    "write",
    "bash",
    "exec",
    "start_process",
    "list_processes",
    "kill_process",
  ]) {
    if (!advertised.includes(expected)) {
      throw new Error(`Computer did not advertise ${expected}`);
    }
  }
  await expectCallFailure(worker, "exec", {
    command: "true",
    timeoutMs: 120_001,
  });
  await expectCallFailure(worker, "write", {
    path: `/missing-parent-${randomUUID()}/proof.txt`,
    content: proofContent,
  });
  await call(worker, "mkdir", { path: "/workspace" });
  await call(worker, "write", { path: proofPath, content: proofContent });
  await stopWorker(worker);

  worker = await startWorker();
  const read = readResult.parse(
    await call(worker, "read", { path: proofPath }),
  );
  if (read.content !== proofContent)
    throw new Error("Computer bytes did not survive Worker reconstruction");

  const bomPath = "/computer-bom-proof.txt";
  const bomContent = "\uFEFFé\r\n";
  await call(worker, "write", { path: bomPath, content: bomContent });
  const firstBomPage = filesReadResult.parse(
    await filesRead(worker, { path: bomPath, offset: 0, limit: 4 }),
  );
  if (
    firstBomPage.content !== "\uFEFF" ||
    firstBomPage.nextOffset !== 3 ||
    !firstBomPage.truncated
  ) {
    throw new Error("Computer Files read did not preserve a BOM page boundary");
  }
  const secondBomPage = filesReadResult.parse(
    await filesRead(worker, {
      path: bomPath,
      offset: firstBomPage.nextOffset,
      limit: 4,
    }),
  );
  if (
    secondBomPage.content !== "é\r\n" ||
    secondBomPage.nextOffset !== null ||
    secondBomPage.truncated
  ) {
    throw new Error("Computer Files read damaged UTF-8 or CRLF bytes");
  }
  const bomReplacement = "\uFEFFafter\r\n";
  const bomReplaceResponse = await replaceResponse(
    worker,
    {
      path: bomPath,
      expectedContent: bomContent,
      content: bomReplacement,
    },
    "/files/replace",
  );
  if (!bomReplaceResponse.ok) {
    throw new Error(
      `Computer Files BOM replacement failed: ${await bomReplaceResponse.text()}`,
    );
  }
  replaceResult.parse(await bomReplaceResponse.json());
  const replacedBom = filesReadResult.parse(
    await filesRead(worker, { path: bomPath, offset: 0, limit: 128 * 1024 }),
  );
  if (replacedBom.content !== bomReplacement) {
    throw new Error("Computer Files replacement did not retain BOM and CRLF");
  }

  const firstReplacement = `${proofContent}-first`;
  const secondReplacement = `${proofContent}-second`;
  const [firstResponse, secondResponse] = await Promise.all([
    replaceResponse(worker, {
      path: proofPath,
      expectedContent: proofContent,
      content: firstReplacement,
    }),
    replaceResponse(worker, {
      path: proofPath,
      expectedContent: proofContent,
      content: secondReplacement,
    }),
  ]);
  const successful = [
    { response: firstResponse, content: firstReplacement },
    { response: secondResponse, content: secondReplacement },
  ].filter(({ response }) => response.ok);
  if (successful.length !== 1) {
    throw new Error(
      "Computer concurrent replacements did not produce one winner",
    );
  }
  const winner = successful[0];
  if (winner === undefined)
    throw new Error("Computer replacement winner missing");
  replaceResult.parse(await winner.response.json());
  const failed = [firstResponse, secondResponse].filter(
    (response) => !response.ok,
  );
  if (failed.length !== 1) {
    throw new Error(
      "Computer concurrent replacement did not reject one stale write",
    );
  }
  const failedResponse = failed[0];
  if (failedResponse === undefined)
    throw new Error("Computer stale replacement response missing");
  if (!(await failedResponse.text()).includes("Files edit conflict")) {
    throw new Error(
      "Computer concurrent replacement failed for the wrong reason",
    );
  }
  const afterConcurrentReplacement = readResult.parse(
    await call(worker, "read", { path: proofPath }),
  );
  if (afterConcurrentReplacement.content !== winner.content) {
    throw new Error("Computer concurrent replacement lost its committed bytes");
  }
  const staleResponse = await replaceResponse(worker, {
    path: proofPath,
    expectedContent: proofContent,
    content: "stale overwrite",
  });
  if (staleResponse.ok) {
    throw new Error("Computer stale replacement unexpectedly succeeded");
  }
  if (!(await staleResponse.text()).includes("Files edit conflict")) {
    throw new Error("Computer stale replacement failed for the wrong reason");
  }
  const afterStaleReplacement = readResult.parse(
    await call(worker, "read", { path: proofPath }),
  );
  if (afterStaleReplacement.content !== winner.content) {
    throw new Error("Computer stale replacement changed committed bytes");
  }

  const command = `cat ${proofPath}`;
  const executed = execResult.parse(await call(worker, "exec", { command }));
  if (executed.exitCode !== 0 || executed.stdout.trim() !== winner.content) {
    throw new Error(
      `Worker shell did not observe Home: ${JSON.stringify(executed)}`,
    );
  }
  const containerPath = "/workspace/computer-container-proof.txt";
  const containerContent = `container-proof-${randomUUID()}`;
  const containerExecution = execResult.parse(
    await call(worker, "bash", {
      command: `cat ${proofPath} && printf '%s' '${containerContent}' > ${containerPath}`,
      cwd: "/workspace",
      timeoutMs: 30_000,
    }),
  );
  if (
    containerExecution.status !== "completed" ||
    containerExecution.exitCode !== 0 ||
    containerExecution.stdout.trim() !== winner.content
  ) {
    throw new Error(
      `Container shell did not observe Home: ${JSON.stringify(containerExecution)}`,
    );
  }
  const containerWrite = readResult.parse(
    await call(worker, "read", { path: containerPath }),
  );
  if (containerWrite.content !== containerContent) {
    throw new Error("Computer Files did not observe container-written bytes");
  }
  await stopWorker(worker);
  worker = await startWorker();
  const reopenedContainerFile = filesReadResult.parse(
    await filesRead(worker, {
      path: containerPath,
      offset: 0,
      limit: 128 * 1024,
    }),
  );
  if (reopenedContainerFile.content !== containerContent) {
    throw new Error(
      "Computer Files did not retain container-written bytes after Worker reconstruction",
    );
  }
  const reopenedContainerExecution = execResult.parse(
    await call(worker, "bash", {
      command: `cat ${containerPath}`,
      cwd: "/workspace",
      timeoutMs: 30_000,
    }),
  );
  if (
    reopenedContainerExecution.status !== "completed" ||
    reopenedContainerExecution.exitCode !== 0 ||
    reopenedContainerExecution.stdout !== containerContent
  ) {
    throw new Error(
      `Container shell did not retain container-written bytes after Worker reconstruction: ${JSON.stringify(reopenedContainerExecution)}`,
    );
  }

  const reopenOperationPath = "/workspace/computer-operation-reopen.txt";
  const reopenOperationInput = {
    requestId: uuidv7(),
    command: `printf x >> ${reopenOperationPath}`,
    cwd: "/workspace",
  };
  // Model a lost response by discarding the response after dispatch. The
  // caller recovers from durable status, then explicitly retries the ID.
  await operation(worker, reopenOperationInput);
  const afterDroppedResponse = await operationStatus(
    worker,
    reopenOperationInput.requestId,
  );
  const droppedResponseStatus = await afterDroppedResponse.json();
  if (
    !afterDroppedResponse.ok ||
    droppedResponseStatus.status !== "succeeded"
  ) {
    throw new Error("Lost-response status lookup did not return succeeded");
  }
  const droppedResponseRetry = await operation(worker, reopenOperationInput);
  if (
    !droppedResponseRetry.ok ||
    (await droppedResponseRetry.json()).status !== "succeeded"
  ) {
    throw new Error("Lost-response retry did not return its stored result");
  }
  const afterDroppedResponseRetry = readResult.parse(
    await call(worker, "read", { path: reopenOperationPath }),
  );
  if (afterDroppedResponseRetry.content !== "x") {
    throw new Error("Lost-response retry dispatched the command a second time");
  }
  const conflictingRetry = await operation(worker, {
    ...reopenOperationInput,
    command: "true",
  });
  if (conflictingRetry.status !== 409) {
    throw new Error(
      "Computer accepted a reused request ID with different input",
    );
  }
  await stopWorker(worker);
  worker = await startWorker();
  const afterReopen = await operation(worker, reopenOperationInput);
  const reopenedOperation = await afterReopen.json();
  if (!afterReopen.ok || reopenedOperation.status !== "succeeded") {
    throw new Error(
      `Computer operation did not survive DO reconstruction: HTTP ${afterReopen.status}, operation ${reopenedOperation.status ?? "missing"}, code ${reopenedOperation.code ?? "missing"}`,
    );
  }
  const reopenedOperationFile = readResult.parse(
    await call(worker, "read", { path: reopenOperationPath }),
  );
  if (reopenedOperationFile.content !== "x") {
    throw new Error(
      "Reconstruction retry dispatched the command a second time",
    );
  }

  // The model cannot name a request: each tool invocation gets a fresh host ID,
  // so repeating one command runs it again instead of replaying old output.
  await expectCallFailure(worker, "exec", {
    command: "true",
    requestId: reopenOperationInput.requestId,
  });
  const repeatedPath = `/workspace/repeated-${randomUUID()}.txt`;
  for (let invocation = 0; invocation < 2; invocation += 1) {
    const repeated = execResult.parse(
      await call(worker, "bash", {
        command: `printf x >> ${repeatedPath}`,
        cwd: "/workspace",
      }),
    );
    if (repeated.status !== "completed") {
      throw new Error("Repeated Computer tool invocation did not complete");
    }
  }
  const repeatedFile = readResult.parse(
    await call(worker, "read", { path: repeatedPath }),
  );
  if (repeatedFile.content !== "xx") {
    throw new Error("A repeated tool invocation replayed an earlier result");
  }

  const nonV7 = await operation(worker, {
    requestId: randomUUID(),
    command: "touch /workspace/invalid-version-ran",
  });
  if (nonV7.status !== 400) {
    throw new Error("Computer accepted a non-UUIDv7 request ID");
  }
  const future = await operation(worker, {
    requestId: uuidv7(Date.now() + 6 * 60 * 1_000),
    command: "touch /workspace/future-id-ran",
  });
  if (future.status !== 400) {
    throw new Error("Computer accepted a request ID beyond allowed clock skew");
  }
  const evictedId = uuidv7(Date.now() - 11 * 60 * 1_000);
  const seeded = await fetch(`${worker.baseUrl}/test-fill-operations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: evictedId }),
  });
  if (!seeded.ok) throw new Error("Could not seed proof operation records");
  const capacityTrigger = await operation(worker, {
    requestId: uuidv7(),
    command: "true",
  });
  if (
    !capacityTrigger.ok ||
    (await capacityTrigger.json()).status !== "succeeded"
  ) {
    throw new Error("Computer did not evict the oldest terminal operation");
  }
  const evictedRetry = await operation(worker, {
    requestId: evictedId,
    command: "touch /workspace/evicted-id-ran",
  });
  if (!evictedRetry.ok || (await evictedRetry.json()).status !== "expired") {
    throw new Error(
      `Computer dispatched an evicted request ID outside the admission window: ${String(evictedRetry.status)} ${await evictedRetry.text()}`,
    );
  }
  await expectCallFailure(worker, "read", {
    path: "/workspace/evicted-id-ran",
  });
  const concurrentId = uuidv7();
  const concurrentPath = `/workspace/concurrent-${randomUUID()}.txt`;
  const concurrentInput = {
    requestId: concurrentId,
    command: `printf x >> ${concurrentPath}`,
  };
  const concurrent = await Promise.all([
    operation(worker, concurrentInput),
    operation(worker, concurrentInput),
  ]);
  if (concurrent.some((response) => !response.ok)) {
    throw new Error("Computer rejected one of two same-ID concurrent calls");
  }
  let concurrentStatus;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await operationStatus(worker, concurrentId);
    concurrentStatus = await response.json();
    if (concurrentStatus.status === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (concurrentStatus?.status !== "succeeded") {
    throw new Error("Concurrent Computer operation did not reach succeeded");
  }
  const concurrentFile = readResult.parse(
    await call(worker, "read", { path: concurrentPath }),
  );
  if (concurrentFile.content !== "x") {
    throw new Error("Concurrent same-ID calls dispatched more than once");
  }

  const longStartedAt = Date.now();
  const longExecution = execResult.parse(
    await call(worker, "exec", {
      command: "sleep 31; printf explicit-timeout-finished",
      timeoutMs: 45_000,
    }),
  );
  const longElapsedMs = Date.now() - longStartedAt;
  if (
    longExecution.exitCode !== 0 ||
    longExecution.stdout !== "explicit-timeout-finished" ||
    longElapsedMs < 30_000
  ) {
    throw new Error(
      `Worker shell did not complete beyond 30 seconds: ${JSON.stringify({ longExecution, longElapsedMs })}`,
    );
  }

  const cancelledPath = `/computer-timeout-${randomUUID()}.txt`;
  const timedOut = execResult.parse(
    await call(worker, "exec", {
      command: `sleep 0.2; printf late > ${cancelledPath}`,
      timeoutMs: 50,
    }),
  );
  if (timedOut.exitCode !== 124 || timedOut.status !== "failed") {
    throw new Error(
      `Worker shell did not report its explicit timeout: ${JSON.stringify(timedOut)}`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  const afterTimeout = await call(worker, "list", { path: "/", limit: 256 });
  if (
    afterTimeout.nextOffset !== null ||
    afterTimeout.entries.some(({ name }) => name === cancelledPath.slice(1))
  ) {
    throw new Error("Worker shell wrote after its explicit timeout");
  }
  process.stdout.write(
    `${JSON.stringify({ proof: "computer-advertisement-do-reconstruction-worker-and-container-shells", verdict: "pass", longElapsedMs, timeoutExitCode: timedOut.exitCode })}\n`,
  );
}

async function proveBinaryFiles() {
  worker ??= await startWorker();
  await call(worker, "mkdir", { path: "/workspace" });
  const path = "/workspace/native-image.gif";
  // A complete one-pixel GIF fixture, including bytes that are not valid UTF-8.
  const image = new Uint8Array(
    Buffer.from(
      "47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b",
      "hex",
    ),
  );
  const fileUrl = () =>
    `${worker.baseUrl}/binary-file?${new URLSearchParams({ path })}`;
  const written = await fetch(fileUrl(), { method: "PUT", body: image });
  assert.equal(written.status, 204);
  const listed = await call(worker, "list", { path: "/workspace", limit: 256 });
  assert.ok(
    listed.entries.some(
      (entry) =>
        entry.name === "native-image.gif" &&
        entry.type === "file" &&
        entry.size === image.byteLength,
    ),
  );
  const first = await fetch(fileUrl());
  assert.equal(first.status, 200);
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), image);

  const concurrent = await Promise.all([fetch(fileUrl()), fetch(fileUrl())]);
  assert.deepEqual(
    concurrent.map((response) => response.status),
    [200, 200],
  );
  assert.deepEqual(
    await Promise.all(
      concurrent.map(
        async (response) => new Uint8Array(await response.arrayBuffer()),
      ),
    ),
    [image, image],
  );

  const cancellation = new AbortController();
  const cancelled = fetch(`${fileUrl()}&slow=1`, {
    signal: cancellation.signal,
  }).then(async (response) => {
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  cancellation.abort();
  await assert.rejects(cancelled, { name: "AbortError" });

  const afterCancellation = await fetch(fileUrl());
  assert.equal(afterCancellation.status, 200);
  assert.deepEqual(
    new Uint8Array(await afterCancellation.arrayBuffer()),
    image,
  );

  await stopWorker(worker);
  worker = await startWorker();
  const reopened = await fetch(fileUrl());
  assert.equal(reopened.status, 200);
  assert.deepEqual(new Uint8Array(await reopened.arrayBuffer()), image);
  process.stdout.write(
    `${JSON.stringify({ proof: "computer-native-binary-image-list-read-reopen", verdict: "pass", bytes: image.byteLength })}\n`,
  );
}

try {
  if (!process.argv.includes("--binary-files")) await proveRuntime();
  await proveBinaryFiles();
} catch (error) {
  throw proofFailure(error, workers, worker);
} finally {
  if (worker) await stopWorker(worker);
  await workers.dispose();
}
