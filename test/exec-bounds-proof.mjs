/* global fetch, AbortSignal */
// pf-23: commands inside the contract's bounds run on the backing and return
// their recorded result: a long timeout and a large heredoc. Under
// COMPUTER_PROOF_RUNTIME=celld they run in a Firecracker guest.
//
// Run with the other on-box proofs: `leg1.sh exec-bounds`.
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { setTimeout } from "node:timers";
import { mintComputerRequestId } from "@fungi.computer/computer-contract";
import { proofWorkers } from "./proof-worker.mjs";

const workers = await proofWorkers("computer-proof");
let worker;
try {
  worker = await workers.start();
  const bash = async (input) => {
    const response = await fetch(`${worker.baseUrl}/operation?bash=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: mintComputerRequestId(), ...input }),
      signal: AbortSignal.timeout(180_000),
    });
    return { http: response.status, body: await response.json() };
  };
  const sleepMs = Number(process.env.VMD_SLEEP_OVERRIDE_MS ?? 0);
  const cases = [
    [
      "a command with the long timeout",
      {
        command: "printf long-timeout-ok",
        cwd: "/workspace",
        timeoutMs: 120_000,
      },
      "long-timeout-ok",
    ],
    [
      "a quiet command that runs for 40 seconds",
      {
        command: "sleep 40; printf slept",
        cwd: "/workspace",
        timeoutMs: 120_000,
      },
      "slept",
    ],
    [
      "a 12 KB heredoc",
      {
        command: `cat > /workspace/big.txt <<'EOF'\n${"x".repeat(12_000)}\nEOF\nwc -c < /workspace/big.txt`,
        cwd: "/workspace",
      },
      "12001\n",
    ],
    [
      "a command that writes many files",
      {
        command:
          "mkdir -p /workspace/many && for i in $(seq 1 300); do echo $i > /workspace/many/f$i; done; ls /workspace/many | wc -l",
        cwd: "/workspace",
        timeoutMs: 30_000,
      },
      "300\n",
    ],
  ];
  for (const [label, input, stdout] of cases) {
    // The VM host stops a guest after its idle window, and a command that is
    // quiet for longer than a short window is idle by that rule.
    if (sleepMs > 0 && (input.timeoutMs ?? 0) >= 60_000) continue;
    const outcome = await bash(input);
    assert.equal(outcome.http, 200, `${label}: ${JSON.stringify(outcome)}`);
    assert.equal(
      outcome.body.status,
      "succeeded",
      `${label}: ${JSON.stringify(outcome.body)}`,
    );
    assert.equal(outcome.body.output.stdout, stdout, label);
  }
  // A VM host that sleeps the guest after its idle window must wake it for
  // the next command, which then runs and returns its result.
  if (sleepMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, sleepMs + 8_000));
    for (const label of ["first command after idle", "second command"]) {
      const outcome = await bash({
        command: "printf awake",
        cwd: "/workspace",
        timeoutMs: 30_000,
      });
      assert.equal(outcome.http, 200, `${label}: ${JSON.stringify(outcome)}`);
      assert.equal(
        outcome.body.status,
        "succeeded",
        `${label}: ${JSON.stringify(outcome.body)}`,
      );
      assert.equal(outcome.body.output.stdout, "awake", label);
    }
  }
  console.log(JSON.stringify({ proof: "exec-bounds", verdict: "PASS" }));
} finally {
  if (worker !== undefined) await workers.stop(worker);
}
