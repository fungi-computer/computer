/* global WebSocket, fetch, setTimeout, clearTimeout, TextDecoder, TextEncoder */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { z } from "zod";
import { proofWorkers } from "./proof-worker.mjs";

const terminalMessage = z.union([z.string(), z.instanceof(ArrayBuffer)]);
const workers = await proofWorkers("terminal-proof");
const worker = await workers.start();
const { baseUrl, output } = worker;

async function stop() {
  await workers.stop(worker);
  await workers.dispose();
}

async function call(capability, input) {
  const response = await fetch(`${baseUrl}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability, input }),
  });
  if (!response.ok) {
    throw new Error(`Computer ${capability} failed: ${await response.text()}`);
  }
  const result = await response.json();
  return capability === "bash" || capability === "exec"
    ? result.output
    : result;
}

function hex() {
  return randomBytes(8).toString("hex");
}

async function containerRunning() {
  const response = await fetch(`${baseUrl}/container-running`);
  if (!response.ok) {
    throw new Error(
      `Computer container-running probe failed: ${await response.text()}`,
    );
  }
  const body = z.object({ running: z.boolean() }).parse(await response.json());
  return body.running;
}

async function putFile(path, content) {
  const response = await fetch(
    `${baseUrl}/files/write?path=${encodeURIComponent(path)}`,
    { method: "PUT", body: content },
  );
  if (!response.ok) {
    throw new Error(`Computer Files write failed: ${await response.text()}`);
  }
}

async function replaceFile(path, expectedContent, content) {
  const response = await fetch(`${baseUrl}/replace`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, expectedContent, content }),
  });
  if (!response.ok) {
    throw new Error(`Computer Files replace failed: ${await response.text()}`);
  }
}

async function readBinaryFile(path) {
  const response = await fetch(
    `${baseUrl}/binary-file?path=${encodeURIComponent(path)}`,
  );
  if (!response.ok) {
    throw new Error(
      `Computer binary-file read failed: ${await response.text()}`,
    );
  }
  return await response.text();
}

/** Poll the Worker's own `getWorkspace` reader, which never pulls on its own. */
async function pollFilesRead(path, needle, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(`${baseUrl}/files/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, offset: 0, limit: 64 }),
    });
    if (response.ok) {
      const body = await response.json();
      if (body.content === needle) return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Computer terminal sync loop never reached Files for ${path}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function openTerminal(session, principal) {
  const socket = new WebSocket(
    `${baseUrl.replace("http", "ws")}/pty?session=${encodeURIComponent(session)}&principal=${encodeURIComponent(principal)}`,
  );
  socket.binaryType = "arraybuffer";
  let received = "";
  socket.addEventListener("message", (event) => {
    const message = terminalMessage.parse(event.data);
    received +=
      message instanceof ArrayBuffer
        ? new TextDecoder().decode(message)
        : message;
  });
  return { socket, read: () => received };
}

async function waitFor(read, needle, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !read().includes(needle)) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert(
    read().includes(needle),
    `Terminal output lacked ${needle}: ${JSON.stringify(read().slice(-1_000))}`,
  );
}

async function waitForOpen(socket, timeoutMs = 15_000) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Computer terminal connection timed out")),
      timeoutMs,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("Computer terminal connection failed"));
      },
      { once: true },
    );
  });
}

async function close(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise((resolve) => {
    socket.addEventListener("close", resolve, { once: true });
    socket.close();
  });
}

try {
  // On celld a warm VM makes this vacuous; report whether it was exercised.
  const coldBefore = await containerRunning();
  await call("mkdir", { path: "/workspace", recursive: true });
  const file = `/workspace/terminal-proof-${Date.now()}.txt`;
  await call("write", { path: file, content: "before" });
  const coldBootGuardChecked = !coldBefore;
  if (coldBootGuardChecked) {
    assert.equal(
      await containerRunning(),
      false,
      "a Files write must not boot the Computer runtime",
    );
  }

  const session = `terminal-proof-${Date.now()}`;
  const first = openTerminal(session, "member-one");
  await waitForOpen(first.socket);
  await waitFor(first.read, '"type":"ready"');
  first.socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
  first.socket.send(
    new TextEncoder().encode(
      `stty size; export TDD_MEMBER_SCOPE=member-one; printf 'PTY_MARKER_${session}\\n'; printf '%s' '${session}' > '${file}'\n`,
    ),
  );
  await waitFor(first.read, `PTY_MARKER_${session}`);
  await waitFor(first.read, "40 120");
  await close(first.socket);

  const reconnect = openTerminal(session, "member-one");
  await waitForOpen(reconnect.socket);
  await waitFor(reconnect.read, `PTY_MARKER_${session}`);
  reconnect.socket.send(
    new TextEncoder().encode(`printf 'RECONNECTED_${session}\\n'\n`),
  );
  await waitFor(reconnect.read, `RECONNECTED_${session}`);
  reconnect.socket.send(
    new TextEncoder().encode(
      `printf 'SAME_MEMBER_SCOPE=%s\\n' "$TDD_MEMBER_SCOPE"\n`,
    ),
  );
  await waitFor(reconnect.read, "SAME_MEMBER_SCOPE=member-one");
  await close(reconnect.socket);

  const otherMember = openTerminal(session, "member-two");
  await waitForOpen(otherMember.socket);
  await waitFor(otherMember.read, '"type":"ready"');
  assert(
    !otherMember.read().includes(`PTY_MARKER_${session}`),
    "another member must not receive the first member's replay",
  );
  otherMember.socket.send(
    new TextEncoder().encode(
      `printf 'OTHER_MEMBER_SCOPE=%s\\n' "\${TDD_MEMBER_SCOPE-unset}"\n`,
    ),
  );
  await waitFor(otherMember.read, "OTHER_MEMBER_SCOPE=unset");
  await close(otherMember.socket);

  const workspaceRead = await call("read", { path: file });
  assert.equal(
    workspaceRead.content,
    session,
    "PTY shell and Workspace did not share the same file contents",
  );
  const bash = await call("bash", {
    command: `cat '${file}'`,
    cwd: "/workspace",
    timeoutMs: 10_000,
  });
  assert.equal(
    bash.stdout,
    session,
    "computerd and PTY shell did not share the same workspace",
  );

  // One fresh session, opened once: a reconnect would run the readiness
  // bracket's own push/pull and mask the bug this proof exists to catch.
  const syncSession = `terminal-sync-${Date.now()}`;
  const sync = openTerminal(syncSession, "member-sync");
  await waitForOpen(sync.socket);
  await waitFor(sync.read, '"type":"ready"');

  // 1. Save -> cat. The Workspace write must push before the terminal sees it.
  const savedPath = `/workspace/saved-${Date.now()}.md`;
  const savedContent = `inkcap-save-${hex()}`;
  await putFile(savedPath, savedContent);
  sync.socket.send(
    new TextEncoder().encode(`cat '${savedPath}'; echo CAT_$((6*7))\n`),
  );
  await waitFor(sync.read, savedContent);
  await waitFor(sync.read, "CAT_42");

  // 2. Replace -> cat. The replace must also push before the next cat runs.
  const replacedContent = `inkcap-replace-${hex()}`;
  await replaceFile(savedPath, savedContent, replacedContent);
  sync.socket.send(
    new TextEncoder().encode(`cat '${savedPath}'; echo CAT_$((7*7))\n`),
  );
  await waitFor(sync.read, replacedContent);
  await waitFor(sync.read, "CAT_49");

  // 3. PTY write -> Files at once. computer.readFile and "list" pull first.
  const ptyCreatedPath = `/workspace/pty-created-${Date.now()}.txt`;
  const ptyCreatedContent = `pty-${hex()}`;
  sync.socket.send(
    new TextEncoder().encode(
      `printf '%s' '${ptyCreatedContent}' > '${ptyCreatedPath}'; echo WROTE_$((6*9))\n`,
    ),
  );
  await waitFor(sync.read, "WROTE_54");
  const ptyWriteReachedFiles =
    (await readBinaryFile(ptyCreatedPath)) === ptyCreatedContent;
  assert.ok(
    ptyWriteReachedFiles,
    "computer.readFile did not pull the PTY's write before reading",
  );
  const listed = await call("list", {
    path: "/workspace",
    limit: 256,
    offset: 0,
  });
  assert.ok(
    listed.entries.some(
      (entry) => entry.name === ptyCreatedPath.split("/").pop(),
    ),
    "Computer list did not pull the PTY's write before listing",
  );

  // 4. Loop. Only the periodic terminal sync can satisfy a reader that never
  // pulls on its own (the Worker's `getWorkspace` stub behind /files/read).
  const ptyTickedPath = `/workspace/pty-ticked-${Date.now()}.txt`;
  const ptyTickedContent = `tick-${hex()}`;
  sync.socket.send(
    new TextEncoder().encode(
      `printf '%s' '${ptyTickedContent}' > '${ptyTickedPath}'; echo TICKED_$((7*8))\n`,
    ),
  );
  await waitFor(sync.read, "TICKED_56");
  await pollFilesRead(ptyTickedPath, ptyTickedContent);

  await close(sync.socket);

  process.stdout.write(
    `${JSON.stringify({
      proof: "computer-terminal-pty",
      verdict: "pass",
      resized: "40x120",
      reconnectReusedSession: true,
      otherMemberGotNewSession: true,
      workspaceSharedWithFilesAndComputerd: true,
      coldBootGuardChecked,
      workspaceWriteReachedLivePty: true,
      ptyWriteReachedFiles,
      terminalLoopPulled: true,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `Computer terminal proof ${workers.runtime} output:\n${output.join("").slice(-6_000)}\n`,
  );
  throw error;
} finally {
  await stop();
}
