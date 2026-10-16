/* global WebSocket, fetch, setTimeout, TextDecoder, TextEncoder */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import console from "node:console";
import { randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { computerResourceBounds } from "../container/resource-bounds.mjs";
import { proofImage } from "./proof-image.mjs";

const exec = promisify(execFile);
const image = await proofImage();
const containers = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function docker(...args) {
  const { stdout, stderr } = await exec("docker", args, {
    timeout: 30_000,
    maxBuffer: 1 << 20,
  });
  return `${stdout}${stderr}`.trim();
}

async function start(name, extra = []) {
  const id = await docker(
    "run",
    "-d",
    "--name",
    name,
    "--cpus=1",
    "--memory=512m",
    `--pids-limit=${computerResourceBounds.pidsMax}`,
    "--tmpfs",
    "/workspace:size=64m",
    "-p",
    "127.0.0.1::7681",
    ...extra,
    image,
  );
  containers.push(id);
  return id;
}

async function healthy(id) {
  const address = (await docker("port", id, "7681/tcp")).split("\n")[0];
  const deadline = Date.now() + 20_000;
  let lastFailure;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${address}/health`, {
        signal: globalThis.AbortSignal.timeout(
          Math.max(1, deadline - Date.now()),
        ),
      });
      if (response.ok) return address;
      lastFailure = new Error(
        `Computer health returned HTTP ${response.status}`,
      );
    } catch (cause) {
      if (!(
        cause instanceof TypeError &&
        cause.cause instanceof Error &&
        ["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"].includes(
          cause.cause.code,
        )
      ))
        throw new Error(`Computer ${id} health request failed`, { cause });
      lastFailure = cause;
    }
    await delay(100);
  }
  throw new Error(`Computer ${id} did not become healthy`, {
    cause: lastFailure,
  });
}

async function until(state, text, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!state.text.includes(text) && Date.now() < deadline) await delay(50);
  assert.ok(
    state.text.includes(text),
    `terminal did not show ${text}: ${state.text.slice(-500)}`,
  );
}

async function terminal(address) {
  const socket = new WebSocket(
    `ws://${address}/pty?session=resource-${randomUUID()}&cols=80&rows=24`,
  );
  const decoder = new TextDecoder();
  const state = { socket, text: "" };
  socket.binaryType = "arraybuffer";
  socket.addEventListener("message", (event) => {
    state.text +=
      event.data instanceof ArrayBuffer
        ? decoder.decode(event.data)
        : String(event.data);
  });
  await until(state, '"type":"ready"');
  return state;
}

function send(state, command) {
  state.socket.send(new TextEncoder().encode(`${command}\n`));
}

async function cgroupCounter(id, file, name) {
  const values = await docker("exec", id, "cat", `/sys/fs/cgroup/${file}`);
  const count = values.match(new RegExp(`(?:^|\\n)${name} (\\d+)`))?.[1];
  assert.ok(count !== undefined, `${file} has no ${name} counter`);
  return Number(count);
}

async function hostCgroup(id) {
  const pid = Number(await docker("inspect", id, "--format", "{{.State.Pid}}"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "Computer has no host PID");
  const location = (await readFile(`/proc/${pid}/cgroup`, "utf8"))
    .split("\n")
    .find((line) => line.startsWith("0::"))
    ?.slice(3);
  assert.ok(location, "Computer has no cgroup v2 path");
  return join("/sys/fs/cgroup", location);
}

/** A child OOM kill can end the container before another docker exec starts. */
async function openMemoryEvents(id) {
  const cgroup = await hostCgroup(id);
  assert.equal(
    Number((await readFile(join(cgroup, "memory.max"), "utf8")).trim()),
    512 * 1024 * 1024,
    "Computer cgroup did not receive its memory bound",
  );
  return open(join(cgroup, "memory.events"), "r");
}

async function eventCount(file, name) {
  const buffer = Buffer.alloc(4096);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  const text = buffer.toString("utf8", 0, bytesRead);
  const count = text.match(new RegExp(`(?:^|\\n)${name} (\\d+)`))?.[1];
  assert.ok(count !== undefined, `memory.events has no ${name} counter`);
  return Number(count);
}

async function runProof() {
  const offender = await start(`computer-bound-${randomUUID()}`);
  const neighbour = await start(`computer-neighbour-${randomUUID()}`);
  const [offenderAddress, neighbourAddress] = await Promise.all([
    healthy(offender),
    healthy(neighbour),
  ]);
  const limits = JSON.parse(
    await docker("inspect", offender, "--format", "{{json .HostConfig}}"),
  );
  assert.equal(limits.NanoCpus, 1_000_000_000);
  assert.equal(limits.Memory, 512 * 1024 * 1024);
  assert.equal(limits.PidsLimit, computerResourceBounds.pidsMax);
  assert.match(limits.Tmpfs["/workspace"], /size=64m/);

  const shell = await terminal(offenderAddress);
  try {
    send(shell, "stty -echo");
    await delay(200);
    // A bounded fork bomb tries 300 children from the real Computer terminal.
    // Each child has the hard RLIMIT_NPROC installed before computerd started.
    send(
      shell,
      `node -e 'const {spawn}=require("node:child_process");let blocked=0;for(let i=0;i<300;i++){try{spawn("/bin/sleep",["5"]).on("error",e=>{if(e.code==="EAGAIN")blocked++})}catch(e){if(e.code==="EAGAIN")blocked++}}setTimeout(()=>console.log("FORK_BLOCKED:"+blocked),1000)' ; echo FORK_DONE`,
    );
    await until(shell, "FORK_BLOCKED:");
    const blocked = Number(shell.text.match(/FORK_BLOCKED:(\d+)/)?.[1]);
    assert.ok(blocked > 0, "the fork bomb crossed the process bound");
    assert.equal(
      (await fetch(`http://${neighbourAddress}/health`)).status,
      200,
    );
    await until(shell, "FORK_DONE");

    send(
      shell,
      "dd if=/dev/zero of=/workspace/fill bs=1M count=80 2>&1; echo DISK_CODE_$?",
    );
    await until(shell, "DISK_CODE_");
    const diskExit = Number(shell.text.match(/DISK_CODE_(\d+)/)?.[1]);
    assert.notEqual(diskExit, 0, "the disk filler crossed the disk bound");
    assert.match(shell.text, /No space left on device/);
    assert.equal(
      (await fetch(`http://${neighbourAddress}/health`)).status,
      200,
    );

    const throttledBefore = await cgroupCounter(
      offender,
      "cpu.stat",
      "nr_throttled",
    );
    send(
      shell,
      "for i in 1 2 3 4; do timeout 2 sh -c 'while :; do :; done' & done; wait; echo CPU_DONE",
    );
    await until(shell, "CPU_DONE", 10_000);
    assert.ok(
      (await cgroupCounter(offender, "cpu.stat", "nr_throttled")) >
        throttledBefore,
      "the CPU burner was not throttled",
    );
    assert.equal(
      (await fetch(`http://${neighbourAddress}/health`)).status,
      200,
    );

    const memoryEvents = await openMemoryEvents(offender);
    try {
      const oomBefore = await eventCount(memoryEvents, "oom_kill");
      send(
        shell,
        "node -e 'const blocks=[];for(let i=0;i<80;i++)blocks.push(Buffer.alloc(16*1024*1024,1))'",
      );
      let memoryStopped = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await eventCount(memoryEvents, "oom_kill")) > oomBefore) {
          memoryStopped = true;
          break;
        }
        await delay(100);
      }
      assert.ok(memoryStopped, "the memory burner crossed its cgroup bound");
    } finally {
      await memoryEvents.close();
    }
    assert.equal(
      (await fetch(`http://${neighbourAddress}/health`)).status,
      200,
    );
  } finally {
    shell.socket.close();
  }

  const deadline = await start(`computer-deadline-${randomUUID()}`, [
    "-e",
    "COMPUTER_MAX_RUNTIME_MS=1500",
  ]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = JSON.parse(
      await docker("inspect", deadline, "--format", "{{json .State}}"),
    );
    if (!state.Running) break;
    await delay(100);
  }
  assert.match(await docker("logs", deadline), /runtime deadline reached/);
  assert.equal((await fetch(`http://${neighbourAddress}/health`)).status, 200);
  return "Computer PID, disk, CPU, memory and runtime bounds stopped abuse; neighbour stayed healthy";
}
const [proof] = await Promise.allSettled([runProof()]);
const outcomes = [proof];
for (const id of containers.reverse()) {
  outcomes.push(...(await Promise.allSettled([docker("stop", "-t", "1", id)])));
  outcomes.push(...(await Promise.allSettled([docker("rm", id)])));
}
const failures = outcomes.flatMap((outcome) =>
  outcome.status === "rejected" ? [outcome.reason] : [],
);
if (failures.length > 0)
  throw new AggregateError(
    failures,
    "Computer resource proof or cleanup failed",
  );
if (proof.status === "fulfilled") console.log(proof.value);
