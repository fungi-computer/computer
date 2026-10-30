import type {
  WorkspaceRuntimeExecHandle,
  WorkspaceRuntimeResultOptions,
} from "@fungi.computer/cloudflare-computer";

/** A host deadline cancels the owned execution, rather than merely abandoning its result. */
export async function computerExecutionResult(
  run: WorkspaceRuntimeExecHandle<"utf8">,
  signal?: AbortSignal,
  options?: WorkspaceRuntimeResultOptions,
) {
  if (signal === undefined) return await run.result(options);
  let interrupt: () => void = () => undefined;
  const interrupted = new Promise<{ kind: "interrupted" }>((resolve) => {
    interrupt = () => {
      resolve({ kind: "interrupted" });
    };
    signal.addEventListener("abort", interrupt, { once: true });
    if (signal.aborted) interrupt();
  });
  try {
    const result = await Promise.race([
      run.result(options).then((value) => ({ kind: "result" as const, value })),
      interrupted,
    ]);
    if (result.kind === "result") return result.value;
    await run.kill("SIGKILL");
    signal.throwIfAborted();
    throw new Error("Computer execution interrupted");
  } finally {
    signal.removeEventListener("abort", interrupt);
  }
}
