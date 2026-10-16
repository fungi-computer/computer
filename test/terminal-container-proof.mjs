/* global WebSocket, fetch, setTimeout, TextDecoder, TextEncoder */
// Real-image proof of the Computer-owned terminal: builds this Dockerfile,
// runs it, and drives the terminal server's wire directly. It proves resize,
// replay after a dropped socket, a long process that keeps running while no
// socket is attached, takeover, shell exit, orphan reaping, and that the
// container exits when computerd dies.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { proofImage } from "./proof-image.mjs";

const run = promisify(execFile);
const image = await proofImage();
const decoder = new TextDecoder();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function docker(...args) {
  return (await run("docker", args, { maxBuffer: 16 * 1_024 * 1_024 })).stdout;
}

function open(base, session) {
  const socket = new WebSocket(
    `${base}/pty?session=${session}&cols=80&rows=24&FUNGI_COMPUTER_NAME=Home&FUNGI_TEAM_NAME=proof-team&FUNGI_MODEL_DOOR=Team+inference`,
  );
  socket.binaryType = "arraybuffer";
  const state = { socket, text: "", closeCode: null };
  socket.addEventListener("message", (event) => {
    // Text frames are control JSON; binary frames are PTY bytes.
    if (event.data instanceof ArrayBuffer) {
      const bytes = decoder.decode(event.data);
      state.text += bytes;
    } else state.text += String(event.data);
  });
  socket.addEventListener("close", (event) => {
    state.closeCode = event.code;
  });
  return state;
}

async function until(state, needle, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (state.text.includes(needle)) return;
    await delay(50);
  }
  throw new Error(`terminal never showed ${needle}: ${state.text.slice(-400)}`);
}

/** Poll a condition that settles asynchronously, failing after a bound. */
async function eventually(check, message, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(message);
    await delay(100);
  }
}

async function inContainer(container, script) {
  return (await docker("exec", container, "sh", "-c", script)).trim();
}

function type(state, text) {
  state.socket.send(new TextEncoder().encode(text));
}

const container = (
  await docker(
    "run",
    "-d",
    ...(process.env.COMPUTER_PROOF_FUSE === "1"
      ? [
          "--device",
          "/dev/fuse",
          "--cap-add",
          "SYS_ADMIN",
          "--security-opt",
          "apparmor=unconfined",
        ]
      : []),
    "-p",
    "127.0.0.1::7681",
    image,
  )
).trim();
async function runProof() {
  const mapped = (await docker("port", container, "7681/tcp")).trim();
  const address = mapped.split("\n")[0];
  const deadline = Date.now() + 20_000;
  let lastFailure;
  for (;;) {
    try {
      const response = await fetch(`http://${address}/health`, {
        signal: globalThis.AbortSignal.timeout(
          Math.max(1, deadline - Date.now()),
        ),
      });
      if (response.ok) break;
      lastFailure = new Error(
        `Terminal health returned HTTP ${response.status}`,
      );
    } catch (cause) {
      if (!(
        cause instanceof TypeError &&
        cause.cause instanceof Error &&
        ["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"].includes(
          cause.cause.code,
        )
      ))
        throw new Error("Terminal health request failed", { cause });
      lastFailure = cause;
    }
    if (Date.now() >= deadline)
      throw new Error("Terminal never became healthy", { cause: lastFailure });
    await delay(100);
  }
  const base = `ws://${address}`;
  const session = `container-proof-${String(Date.now())}`;

  const first = open(base, session);
  await until(first, '"type":"ready"');
  await until(first, "fungi@Home");
  assert.deepEqual(await (await fetch(`http://${address}/sessions`)).json(), {
    attached: 1,
  });
  assert.ok(first.text.includes("\x1b[38;2;249;130;132m"));
  assert.ok(!first.text.includes("d888888P"));
  assert.ok(!first.text.includes("exit to close"));
  assert.ok(!first.text.includes(" · Team "));
  assert.ok(first.text.includes('"computerName":"Home"'));
  type(
    first,
    'node -e \'try { process.setuid(0); console.log("PRIV"+"ILEGE_GAINED"); } catch { console.log("PRIV"+"ILEGE_DENIED"); }\'\n',
  );
  await until(first, "PRIVILEGE_DENIED");
  assert.ok(!first.text.includes("PRIVILEGE_GAINED"));
  type(first, "git init -q -b juice; touch demo.txt; false\n");
  await until(first, "✗ 1");
  assert.ok(first.text.includes("git:(juice)"));
  assert.equal(
    await inContainer(container, "bash -lc 'printf quiet'"),
    "quiet",
  );
  first.socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
  await delay(200);
  type(first, "stty size; echo MARK_$((6*7))\n");
  await until(first, "40 120");
  await until(first, "MARK_42");
  // The loop also records its latest tick in the container, so the proof can
  // wait for progress while no socket is attached instead of sleeping.
  type(
    first,
    "for i in $(seq 1 100000); do echo TICK_$i; echo $i > /tmp/tick; sleep 0.2; done\n",
  );
  await until(first, "TICK_3");
  first.socket.close();
  await eventually(
    async () =>
      (await (await fetch(`http://${address}/sessions`)).json()).attached === 0,
    "a closed socket still counted as attached",
  );
  const seenBeforeDrop = Math.max(
    ...[...first.text.matchAll(/TICK_(\d+)/g)].map((match) => Number(match[1])),
  );
  await eventually(
    async () =>
      Number(await inContainer(container, "cat /tmp/tick")) >=
      seenBeforeDrop + 5,
    "the loop stopped while detached",
  );

  const second = open(base, session);
  await until(second, '"type":"ready"');
  await until(second, "MARK_42");
  const replayed = [...second.text.matchAll(/TICK_(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  const lastReplayed = replayed.at(-1) ?? 0;
  assert.ok(
    lastReplayed >= seenBeforeDrop + 5,
    "the loop kept running while detached",
  );
  await until(second, `TICK_${String(lastReplayed + 3)}`);
  const ticks = [...second.text.matchAll(/TICK_(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  assert.ok(
    ticks.every((tick, index) => index === 0 || tick === ticks[index - 1] + 1),
    "replay and live output have no gap",
  );

  const takeover = open(base, session);
  await until(takeover, '"type":"ready"');
  await eventually(
    () => second.closeCode !== null,
    "the replaced socket never closed",
  );
  assert.equal(second.closeCode, 4000, "a second attach replaces the first");
  // Interrupt the loop and wait for the shell to evaluate a marker. A ^C that
  // lands while bash is reclaiming the terminal from an exited `sleep` reaches
  // no process and is lost, and each ^C flushes queued input, so interrupt
  // again and retype the marker until the prompt answers.
  for (let attempt = 1; ; attempt += 1) {
    type(takeover, "\u0003");
    type(takeover, "echo STOPPED_$((6*8))\n");
    try {
      await until(takeover, "STOPPED_48", 2_000);
      break;
    } catch (cause) {
      if (attempt === 10) throw cause;
    }
  }
  type(takeover, "(sleep 1 &) ; exit\n");
  await until(takeover, '"type":"exit"');
  const fresh = open(base, session);
  await until(fresh, '"type":"ready"');
  // Frames arrive in order, so any replay precedes the new shell's answer.
  type(fresh, "echo FRESH_$((7*7))\n");
  await until(fresh, "FRESH_49");
  assert.ok(!fresh.text.includes("MARK_42"), "an exited shell is not revived");
  fresh.socket.close();

  // The orphaned `sleep 1` exits on its own; tini must then reap it.
  await eventually(
    async () =>
      (await inContainer(
        container,
        "grep -l '^State:.*Z' /proc/[0-9]*/status 2>/dev/null | wc -l; for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -c '^sleep 1 ' || true",
      )) === "0\n0",
    "tini did not reap orphaned shell jobs",
  );
  const processes = await docker(
    "exec",
    container,
    "sh",
    "-c",
    "for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline; echo; done",
  );
  assert.ok(!processes.includes("container-server"), "no Sandbox daemon");
  const computerd = await docker(
    "exec",
    container,
    "sh",
    "-c",
    "for p in /proc/[0-9]*; do grep -aq '^/usr/local/bin/node./opt/fungi/computerd.cjs' $p/cmdline 2>/dev/null && basename $p; done; true",
  );
  await docker("exec", container, "sh", "-c", `kill -9 ${computerd.trim()}`);
  await eventually(
    async () =>
      (
        await docker("inspect", container, "--format", "{{.State.Status}}")
      ).trim() === "exited",
    "computerd death did not end the Computer runtime",
  );

  return `${JSON.stringify({
    proof: "computer-terminal-container",
    resized: "40x120",
    replayedAfterDrop: true,
    ticksWhileDetached: lastReplayed,
    takeover: true,
    freshAfterExit: true,
    zombies: 0,
    exitsWithComputerd: true,
  })}\n`;
}
const [proof] = await Promise.allSettled([runProof()]);
// Remove only the container this proof started, attempting removal even if stop fails.
const outcomes = [proof];
outcomes.push(
  ...(await Promise.allSettled([docker("stop", "-t", "2", container)])),
);
outcomes.push(...(await Promise.allSettled([docker("rm", container)])));
const failures = outcomes.flatMap((outcome) =>
  outcome.status === "rejected" ? [outcome.reason] : [],
);
if (failures.length > 0)
  throw new AggregateError(
    failures,
    "Computer terminal proof or cleanup failed",
  );
if (proof.status === "fulfilled") process.stdout.write(proof.value);
