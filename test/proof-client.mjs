/* global fetch */
import assert from "node:assert/strict";

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
    return capability === "bash" || capability === "exec"
      ? result.output
      : result;
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
