import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { applyWorkspacePatch } from "../dist/files-patch.js";

const executable = fileURLToPath(
  new URL("../native/bin/fungi-apply-patch", import.meta.url),
);

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "fungi-computer-patch-"));
  const calls = [];
  let synchronizationFailure = false;
  const workspace = {
    runtime: {
      async exec(command, options) {
        calls.push({ command, options });
        assert.equal(command, "/opt/fungi/fungi-apply-patch");
        assert.equal(options.cwd, "/workspace");
        assert.equal(options.backend, "hosted:vm");
        assert.equal(options.timeoutMs, 30_000);
        // Run the packaged engine. Only the test Workspace's mount path is substituted.
        const process = spawn(executable, [], { cwd: root, stdio: "pipe" });
        let stdout = "",
          stderr = "";
        process.stdout.setEncoding("utf8").on("data", (data) => {
          stdout += data;
        });
        process.stderr.setEncoding("utf8").on("data", (data) => {
          stderr += data;
        });
        const settled = new Promise((resolve, reject) => {
          process.once("error", reject);
          process.once("close", (exitCode) =>
            resolve({
              status: exitCode === 0 ? "completed" : "failed",
              exitCode,
              stdout,
              stderr,
              sync: synchronizationFailure
                ? { status: "pending", error: "fixture sync transport lost" }
                : { status: "complete" },
            }),
          );
        });
        process.stdin.end(options.stdin);
        return {
          result: () => settled,
          [Symbol.dispose]() {
            if (process.exitCode === null) process.kill();
          },
        };
      },
    },
  };
  try {
    await writeFile(join(root, "note.txt"), "before\n");
    await run({
      root,
      calls,
      apply: (patch) => applyWorkspacePatch(workspace, "hosted:vm", { patch }),
      failSync: () => {
        synchronizationFailure = true;
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const patch =
  "*** Begin Patch\n*** Update File: note.txt\n@@\n-before\n+after\n*** End Patch\n";

test("Computer Files patch executes the packaged engine with stdin, not shell interpolation", () =>
  fixture(async ({ root, calls, apply }) => {
    const result = await apply(
      patch.replace("+after", "+$(touch escaped); 'quoted' \\n"),
    );
    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);
    assert.equal(
      await readFile(join(root, "note.txt"), "utf8"),
      "$(touch escaped); 'quoted' \\n\n",
    );
    assert.equal(calls.length, 1);
    await assert.rejects(readFile(join(root, "escaped")), { code: "ENOENT" });
  }));

test("Computer Files patch retains native mismatch and jail failures", () =>
  fixture(async ({ root, apply }) => {
    const mismatch = await apply(patch.replace("-before", "-absent"));
    assert.equal(mismatch.status, "failed");
    assert.deepEqual(mismatch.error, { kind: "mismatch" });
    const escaped = await apply(
      "*** Begin Patch\n*** Add File: ../escaped.txt\n+bad\n*** End Patch\n",
    );
    assert.equal(escaped.status, "failed");
    assert.equal(await readFile(join(root, "note.txt"), "utf8"), "before\n");
  }));

test("a successful native patch with pending Workspace sync is a visible failure", () =>
  fixture(async ({ apply, failSync }) => {
    failSync();
    const result = await apply(patch);
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 1);
    assert.match(
      result.stderr,
      /filesystem synchronization failed: fixture sync transport lost/u,
    );
    assert.match(result.stderr, /Earlier patch writes may remain/u);
  }));
