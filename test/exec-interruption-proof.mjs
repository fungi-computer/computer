/* global fetch, setTimeout, AbortSignal */
// pf-22: exec and bash against a real on-box VM backing, and a command
// interrupted while it runs.
//
//   1. exec and bash return their recorded result, and that result is what the
//      status lookup returns afterwards. Under COMPUTER_PROOF_RUNTIME=celld the
//      bash command runs in a Firecracker guest (kernel 6.1.141), not the host.
//   2. The VM is killed while a bash command is running. The operation is
//      recorded `unknown` for its request id (never `succeeded`, never left
//      `running`), the same id retried returns that status without running the
//      command again, and a new id recovers on a fresh VM boot.
//
// Run with the other on-box proofs: `leg1.sh exec-interruption`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import console from "node:console";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import process from "node:process";
import { z } from "zod";
import { proofWorkers } from "./proof-worker.mjs";

const onVm = process.env.COMPUTER_PROOF_RUNTIME === "celld";
const result = z.strictObject({
  requestId: z.string(),
  status: z.enum(["accepted", "running", "succeeded", "failed", "unknown"]),
  output: z
    .strictObject({
      status: z.enum(["completed", "failed", "cancelled"]),
      exitCode: z.number().int(),
      stdout: z.string(),
      stderr: z.string(),
      truncated: z.boolean(),
    })
    .nullable(),
});
const workers = await proofWorkers("computer-proof");

function uuidv7(createdAt = Date.now()) {
  const timestamp = createdAt.toString(16).padStart(12, "0");
  const random = randomUUID().replaceAll("-", "");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${random.slice(1, 4)}-8${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

/** One command through the operation record: `bash` runs on the backing. */
async function operation(worker, kind, input) {
  const response = await fetch(
    `${worker.baseUrl}/operation${kind === "bash" ? "?appMethod=1" : ""}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(120_000),
    },
  );
  return { http: response.status, body: await response.json() };
}
async function status(worker, requestId) {
  const response = await fetch(
    `${worker.baseUrl}/operation-status/${requestId}`,
  );
  assert.equal(response.status, 200, `status lookup for ${requestId}`);
  return result.parse(await response.json());
}
const recorded = ({ http, body }, label) => {
  assert.equal(
    http,
    200,
    `${label}: HTTP ${String(http)} ${JSON.stringify(body)}`,
  );
  return result.parse(body);
};
const bash = async (worker, command) => {
  const outcome = recorded(
    await operation(worker, "bash", {
      requestId: uuidv7(),
      command,
      cwd: "/workspace",
      timeoutMs: 30_000,
    }),
    command,
  );
  assert.equal(
    outcome.status,
    "succeeded",
    `${command}: ${JSON.stringify(outcome)}`,
  );
  assert.equal(
    outcome.output?.exitCode,
    0,
    `${command}: ${JSON.stringify(outcome)}`,
  );
  return outcome.output.stdout.trim();
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The Firecracker process of the VM this run's own vmd is running now: the
 * last `vm_start` in its log with no `vm_exit` after it, matched to the
 * process that names the same VM. Another run's VM on the same host names a
 * different id, so it is never touched.
 */
function runningVmPid() {
  const state = process.env.COMPUTER_VM_PROOF_STATE;
  assert.ok(
    state,
    "COMPUTER_VM_PROOF_STATE names this run's vmd state directory",
  );
  // vmd logs one JSON event per line, among plain-text lines.
  const events = readFileSync(`${state}/vmd.out`, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => vmEvent.parse(JSON.parse(line)));
  const running = new Map();
  for (const event of events) {
    if (event.event === "vm_start") running.set(event.id, event.name);
    if (event.event === "vm_exit") running.delete(event.id);
  }
  assert.equal(
    running.size,
    1,
    `expected one running VM, vmd shows ${String(running.size)}`,
  );
  const [[id, name]] = [...running];
  const processes = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    const cmdline = `/proc/${entry}/cmdline`;
    // A process may exit while /proc is being read; its entry is then gone.
    if (!existsSync(cmdline)) continue;
    const args = readFileSync(cmdline, "utf8").split("\0");
    if (args[0]?.endsWith("firecracker"))
      processes.push({ pid: Number(entry), args });
  }
  const mine = processes.filter(({ args }) =>
    args.some(
      (arg) =>
        arg === id ||
        arg === name ||
        arg.includes(`/${id}/`) ||
        arg.includes(`/${name}/`),
    ),
  );
  assert.equal(
    mine.length,
    1,
    `no single Firecracker process names VM ${name} (${id}): ${JSON.stringify(processes.map((p) => p.args))}`,
  );
  return mine[0].pid;
}
const vmEvent = z
  .object({
    event: z.string(),
    id: z.string().optional(),
    name: z.string().optional(),
  })
  .transform((value) => ({
    event: value.event,
    id: value.id ?? "",
    name: value.name ?? "",
  }));

const worker = await workers.start();
try {
  // 1. Recorded results for exec and bash.
  const execId = uuidv7();
  const executed = recorded(
    await operation(worker, "exec", {
      requestId: execId,
      command: "echo exec-recorded",
      cwd: "/workspace",
    }),
    "exec",
  );
  assert.equal(executed.status, "succeeded");
  assert.equal(executed.output?.stdout.trim(), "exec-recorded");
  assert.deepEqual(
    await status(worker, execId),
    executed,
    "exec status is its recorded result",
  );

  const bashId = uuidv7();
  const ran = recorded(
    await operation(worker, "bash", {
      requestId: bashId,
      command: "uname -r; cat /proc/sys/kernel/random/boot_id",
      cwd: "/workspace",
      timeoutMs: 30_000,
    }),
    "bash",
  );
  assert.equal(ran.status, "succeeded");
  const [kernel, firstBoot] = (ran.output?.stdout ?? "").trim().split("\n");
  if (onVm)
    assert.equal(kernel, "6.1.141", "bash did not run in the on-box VM guest");
  assert.deepEqual(
    await status(worker, bashId),
    ran,
    "bash status is its recorded result",
  );

  // 2. A VM killed while a command runs.
  const log = "/workspace/interrupted.log";
  const interruptedId = uuidv7();
  const interruptedInput = {
    requestId: interruptedId,
    command: `echo started >> ${log} && sync; sleep 60`,
    cwd: "/workspace",
    timeoutMs: 40_000,
  };
  // The caller may lose its response when the guest dies; the durable status is
  // what must be right either way.
  const pending = operation(worker, "bash", interruptedInput).then(
    (answered) => ({ answered }),
    (cause) => ({
      lost: cause instanceof Error ? cause.message : String(cause),
    }),
  );
  // Wait for the command to be running inside the guest, not merely accepted.
  const startedBy = Date.now() + 30_000;
  let seen = "";
  while (Date.now() < startedBy && seen !== "started") {
    await sleep(500);
    seen = await bash(worker, `cat ${log} 2>/dev/null || true`);
  }
  assert.equal(seen, "started", "the long command never started in the guest");
  assert.equal((await status(worker, interruptedId)).status, "running");

  if (onVm) {
    execFileSync("sudo", ["-n", "kill", "-KILL", String(runningVmPid())]);
  } else {
    throw new Error(
      "the interruption proof needs the on-box VM runtime (COMPUTER_PROOF_RUNTIME=celld)",
    );
  }

  const response = await pending;
  // The status settles: never left running, whatever the caller saw.
  const settledBy = Date.now() + 60_000;
  let interrupted = await status(worker, interruptedId);
  while (interrupted.status === "running" && Date.now() < settledBy) {
    await sleep(500);
    interrupted = await status(worker, interruptedId);
  }
  assert.equal(
    interrupted.status,
    "unknown",
    `an interrupted command must be recorded unknown: ${JSON.stringify(interrupted)}`,
  );
  assert.equal(
    interrupted.output,
    null,
    "an unknown outcome carries no output",
  );
  if ("answered" in response)
    assert.deepEqual(
      recorded(response.answered, "interrupted command"),
      interrupted,
      "the caller's answer is the recorded unknown",
    );

  // The same id returns that status and does not run the command again.
  const retried = recorded(
    await operation(worker, "bash", interruptedInput),
    "same-id retry",
  );
  assert.deepEqual(
    retried,
    interrupted,
    "a same-id retry returns the recorded unknown",
  );

  // Recovery: a new id runs on a fresh boot, and the command ran exactly once.
  const afterBoot = await bash(worker, "cat /proc/sys/kernel/random/boot_id");
  assert.notEqual(
    afterBoot,
    firstBoot,
    "the Computer did not come back on a new VM boot",
  );
  assert.equal(
    await bash(worker, `grep -c started ${log}`),
    "1",
    "the interrupted command ran again after the retry",
  );
  console.log(
    JSON.stringify({
      proof: "computer-exec-recorded-and-interrupted-on-vm",
      verdict: "pass",
      callerSaw:
        "answered" in response
          ? "the recorded unknown"
          : `a lost response (${response.lost})`,
      kernel,
      interrupted: interrupted.status,
      retry: retried.status,
      ranOnce: true,
    }),
  );
} finally {
  await workers.stop(worker);
}
