import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { z } from "zod";
import { ProofOperationUnsettledError, proofClient } from "./proof-client.mjs";

async function workerReplying(body) {
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = z.object({ port: z.number().int() }).parse(server.address());
  return {
    worker: { baseUrl: `http://127.0.0.1:${String(port)}` },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("a command with no retained output is a typed unsettled failure, not a null exit", async () => {
  const { worker, close } = await workerReplying({
    status: "unknown",
    output: null,
  });
  try {
    const { call } = proofClient(() => worker);
    await assert.rejects(
      call("bash", { command: "true" }),
      (error) =>
        error instanceof ProofOperationUnsettledError &&
        error.operation.status === "unknown" &&
        error.message.includes("unknown"),
    );
  } finally {
    await close();
  }
});

test("a settled command returns its output", async () => {
  const output = {
    status: "completed",
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    truncated: false,
  };
  const { worker, close } = await workerReplying({
    status: "succeeded",
    output,
  });
  try {
    const { call } = proofClient(() => worker);
    assert.equal((await call("bash", { command: "true" })).exitCode, 0);
  } finally {
    await close();
  }
});
