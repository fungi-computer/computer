// Real-container proof for Home's AGENTS.md: the Agent edits it with
// `apply_patch` (native engine, cwd /workspace), and the hosted instructions
// loader reads it through the Files port at /workspace/AGENTS.md. Both are the
// same file.
import assert from "node:assert/strict";
import process from "node:process";
import { proofWorkers } from "./proof-worker.mjs";
import { proofClient, proofFailure } from "./proof-client.mjs";

const workers = await proofWorkers("computer-home-patch-proof");
let worker;
const { call, json } = proofClient(() => worker);

try {
  worker = await workers.start();
  const patched = await json("/host-patch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      patch:
        "*** Begin Patch\n*** Add File: AGENTS.md\n+# Shiitake's instructions\n+edited by apply_patch\n*** End Patch\n",
    }),
  });
  assert.equal(patched.status, "completed", JSON.stringify(patched));
  // The hosted Hub keeps Home's instructions at /workspace/AGENTS.md (its
  // loader reads `${root}AGENTS.md` with root "/workspace/"), the one place
  // apply_patch's /workspace jail can write.
  const read = await call("read", { path: "/workspace/AGENTS.md" });
  process.stdout.write(
    `${JSON.stringify({ proof: "home-instructions-patch", content: read.content })}\n`,
  );
  assert.equal(
    read.content,
    "# Shiitake's instructions\nedited by apply_patch\n",
    "the file apply_patch wrote is the file the hosted loader reads",
  );
} catch (error) {
  throw proofFailure(error, workers, worker);
} finally {
  if (worker) await workers.stop(worker);
  await workers.dispose();
}
