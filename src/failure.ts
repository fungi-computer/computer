import * as Redacted from "effect/Redacted";

/** Report a Computer catch without printing exception or request data. */
export function reportCatchFailure(operation: string, cause: unknown): void {
  console.error(
    JSON.stringify({
      source: "computer",
      operation,
      failureKind: cause instanceof Error ? "Error" : "NonErrorThrown",
    }),
    Redacted.make(cause),
  );
}
