import type { ComputerExecOutput } from "@fungi.computer/computer-contract";

/** Longest cause text reported to a caller. */
const maximumCauseCharacters = 400;

/**
 * How far one command got. `preparing` is everything before the runtime is
 * asked to start it, so nothing ran; `dispatched` means the runtime may have
 * started it and its result was lost.
 */
export type CommandStage = "preparing" | "dispatched";

export type CommandFailure =
  | Readonly<{ kind: "not_started"; output: ComputerExecOutput }>
  | Readonly<{ kind: "unknown"; cause: string }>;

function causeText(cause: unknown): string {
  return cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : `Computer execution rejected with ${String(cause)}`;
}

function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets)
    if (secret.length >= 8) result = result.replaceAll(secret, "[redacted]");
  return result.length > maximumCauseCharacters
    ? `${result.slice(0, maximumCauseCharacters - 1)}…`
    : result;
}

/**
 * Turn a thrown command failure into what the caller is told. A command that
 * never reached dispatch did not run: that is a failed result carrying its
 * cause. A command that may have started has no established outcome, so it
 * stays unknown, but never without its cause; for a hosted command only the
 * error name, since its runtime may echo env or stdin. `secrets` are credential values
 * handed to the command; they never appear in the reported text.
 */
export function describeCommandFailure(
  input: Readonly<{
    stage: CommandStage;
    cause: unknown;
    secrets: readonly string[];
    /** A host-credentialed command: its runtime errors may echo carriage values. */
    hosted: boolean;
  }>,
): CommandFailure {
  if (input.hosted && input.stage === "dispatched")
    return {
      kind: "unknown",
      cause:
        input.cause instanceof Error
          ? `the native runtime failed (${input.cause.name})`
          : "the native runtime failed",
    };
  const cause = redact(causeText(input.cause), input.secrets);
  if (input.stage === "dispatched") return { kind: "unknown", cause };
  return {
    kind: "not_started",
    output: {
      status: "failed",
      exitCode: -1,
      stdout: "",
      stderr: `The command did not start: ${cause}`,
      truncated: false,
    },
  };
}
