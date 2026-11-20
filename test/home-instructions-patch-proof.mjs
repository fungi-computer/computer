// Real-container proof that an Agent's relative paths mean one root. Files,
// exec and apply_patch all resolve from /workspace, so every step below names
// a file by the relative path an Agent writes, never an absolute one:
//   1. bash with no cwd creates `agent-root-probe.txt`; Files replaces it from
//      that relative path; `cat agent-root-probe.txt` in bash with no cwd reads
//      the bytes Files wrote.
//   2. apply_patch adds `AGENTS.md`; Files reads `AGENTS.md` (the path Home's
//      instructions loader reads) and gets the patched text.
//   3. Files lists `.` and finds both files.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { proofWorkers } from "./proof-worker.mjs";
import { proofClient, proofFailure } from "./proof-client.mjs";

const workers = await proofWorkers("computer-home-patch-proof");
let worker;
const { call, json } = proofClient(() => worker);
const agentFiles = (input) =>
  json("/agent-files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

try {
  worker = await workers.start();
  const nonce = `nonce-${randomUUID()}\n`;

  await call("bash", { command: "printf seed > agent-root-probe.txt" });
  await agentFiles({
    operation: "replace",
    path: "agent-root-probe.txt",
    expectedContent: "seed",
    content: nonce,
  });
  const cat = await call("bash", { command: "cat agent-root-probe.txt" });
  assert.equal(
    cat.stdout,
    nonce,
    "bash with no cwd reads the file Files replaced from a relative path",
  );

  const patched = await json("/host-patch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      patch:
        "*** Begin Patch\n*** Add File: AGENTS.md\n+# Shiitake's instructions\n+edited by apply_patch\n*** End Patch\n",
    }),
  });
  assert.equal(patched.status, "completed", JSON.stringify(patched));
  const read = await agentFiles({ operation: "read", path: "AGENTS.md" });
  assert.equal(
    read.content,
    "# Shiitake's instructions\nedited by apply_patch\n",
    "Files reads the file apply_patch wrote, from the same relative path",
  );

  const listed = await agentFiles({ operation: "list", path: "." });
  const names = listed.results.map(({ path }) => path);
  assert.ok(
    names.includes("/workspace/AGENTS.md") &&
      names.includes("/workspace/agent-root-probe.txt"),
    `listing "." shows both files: ${JSON.stringify(names)}`,
  );
  process.stdout.write(
    `${JSON.stringify({ proof: "agent-relative-paths", cat: cat.stdout, agents: read.content, names })}\n`,
  );
} catch (error) {
  throw proofFailure(error, workers, worker);
} finally {
  if (worker) await workers.stop(worker);
  await workers.dispose();
}
