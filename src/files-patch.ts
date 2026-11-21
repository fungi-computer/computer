import type { Workspace } from "@fungi.computer/cloudflare-computer";
import {
  patchInputSchema,
  patchOutputSchema,
} from "@fungi.computer/computer-contract";
import { boundExecStream } from "./exec-output.js";
import { workspaceRoot } from "./files.js";

/** The packaged, pinned Codex engine owns patch parsing and the Workspace jail. */
const nativePatch = {
  executable: "/opt/fungi/fungi-apply-patch",
  cwd: workspaceRoot,
  timeoutMs: 30_000,
  mismatchExitCode: 23,
  formatExitCode: 24,
};

/**
 * A patch the engine rejects as malformed (its format exit code) is often cut
 * short or wrapped. Quote the received last line so the Agent can fix the patch
 * instead of guessing at what the engine saw.
 */
function withReceivedLastLine(
  stderr: string,
  patch: string,
  exitCode: number,
): string {
  if (exitCode !== nativePatch.formatExitCode) return stderr;
  const lines = patch.trim().split("\n");
  const last = (lines.at(-1) ?? "").trim();
  const shown = last.length > 80 ? `${last.slice(0, 80)}...` : last;
  return `${stderr}\nThe patch you sent has ${String(lines.length)} lines and its last line is: ${JSON.stringify(shown)}. A patch ends with a line that is exactly *** End Patch, and every file line inside it starts with +, - or a space.\n`;
}

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
      : withReceivedLastLine(result.stderr, patch, result.exitCode),
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
