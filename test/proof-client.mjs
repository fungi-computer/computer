/* global fetch */
import assert from "node:assert/strict";
import { computerToolResultSchema } from "@fungi.computer/computer-contract";

/**
 * A command whose durable operation has no retained output: the Computer could
 * not establish a terminal result (for example its container failed to start),
 * so there is no exit code to assert on.
 */
export class ProofOperationUnsettledError extends Error {
  constructor(capability, operation) {
    super(
      `Computer ${capability} has no output: its operation is ${operation.status}`,
    );
    this.name = "ProofOperationUnsettledError";
    this.operation = operation;
  }
}

/** HTTP seam shared by native Computer proofs while the Worker is reconstructed. */
export function proofClient(worker) {
  async function json(path, init) {
    const response = await fetch(`${worker().baseUrl}${path}`, init);
    if (!response.ok)
      throw new Error(`Computer ${path} failed: ${await response.text()}`);
    return await response.json();
  }
  async function call(capability, input) {
    const result = await json("/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability, input }),
    });
    if (capability !== "bash" && capability !== "exec") return result;
    const operation = computerToolResultSchema.parse(result);
    if (operation.output === null)
      throw new ProofOperationUnsettledError(capability, operation);
    return operation.output;
  }
  return { json, call };
}

/** A raw capability result for proofs that inspect its response envelope. */
export async function proofCall(worker, capability, input) {
  const response = await fetch(`${worker.baseUrl}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability, input }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

export function proofFailure(error, workers, worker) {
  return new Error(
    `${error instanceof Error ? error.message : String(error)}\n${workers.runtime} output:\n${worker?.output.join("").slice(-4_000) ?? ""}`,
    { cause: error },
  );
}
