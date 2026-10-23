import type { Workspace } from "@fungi.computer/cloudflare-computer";
import {
  patchInputSchema,
  patchOutputSchema,
} from "@fungi.computer/computer-contract";
import { boundExecStream } from "./exec-output.js";

/** The packaged, pinned Codex engine owns patch parsing and the Workspace jail. */
const nativePatch = {
  executable: "/opt/fungi/fungi-apply-patch",
  cwd: "/workspace",
  timeoutMs: 30_000,
  mismatchExitCode: 23,
};

/** Await Workspace synchronization even when the native engine reports a partial failure. */
export async function applyWorkspacePatch(
  workspace: Pick<Workspace, "runtime">,
  backend: string,
  input: { patch: string },
) {
  const { patch } = patchInputSchema.parse(input);
  using run = await workspace.runtime.exec(nativePatch.executable, {
    backend,
    cwd: nativePatch.cwd,
    encoding: "utf8",
    stdin: patch,
    timeoutMs: nativePatch.timeoutMs,
  });
  const result = await run.result();
  const synchronizationFailure =
    result.sync.status === "pending" ? result.sync.error : null;
  const stdout = boundExecStream(result.stdout, "stdout");
  const stderr = boundExecStream(
    synchronizationFailure !== null
      ? `${result.stderr}\nPatch filesystem synchronization failed: ${synchronizationFailure}. Earlier patch writes may remain.`
      : result.stderr,
    "stderr",
  );
  const output = {
    status: synchronizationFailure !== null ? "failed" : result.status,
    exitCode:
      synchronizationFailure !== null && result.exitCode === 0
        ? 1
        : result.exitCode,
    stdout: stdout.value,
    stderr: stderr.value,
    truncated:
      stdout.truncation.length + stderr.truncation.length === 0
        ? false
        : [...stdout.truncation, ...stderr.truncation],
  };
  return patchOutputSchema.parse(
    result.exitCode === nativePatch.mismatchExitCode
      ? { ...output, error: { kind: "mismatch" } }
      : output,
  );
}
