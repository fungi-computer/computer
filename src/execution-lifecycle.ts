import {
  computerValueSchema,
  type ComputerExecutionCloseReason,
  type ComputerExecutionInvocation,
  type ComputerValue,
} from "@fungi.computer/computer-contract";

type ExecutionStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
type Phase = "opening" | "dispatching" | "open" | "closed";
type ExecutionRow = {
  id: string;
  kind: ComputerExecutionInvocation["kind"];
  phase: Phase;
  backend: string;
  native_opened: number;
  context_json: string;
  close_reason: ComputerExecutionCloseReason | null;
};

type ComputerExecutionRecord = Readonly<{
  invocation: ComputerExecutionInvocation;
  phase: Phase;
  backend: string;
  nativeOpened: boolean;
  closeReason: ComputerExecutionCloseReason | null;
  context: ComputerValue;
}>;

function record(row: ExecutionRow): ComputerExecutionRecord {
  return {
    invocation: { id: row.id, kind: row.kind },
    phase: row.phase,
    backend: row.backend,
    nativeOpened: row.native_opened === 1,
    closeReason: row.close_reason,
    context: computerValueSchema.parse(JSON.parse(row.context_json)),
  };
}

/**
 * Only public host context and native invocation identity are durable here.
 * The operation/process owners continue to own admission, replay and retention;
 * neither credentials nor a second process inventory belong in this table.
 */
class ComputerExecutionLifecycle {
  readonly #storage: ExecutionStorage;
  readonly reconstructed: readonly ComputerExecutionRecord[];

  constructor(storage: ExecutionStorage) {
    this.#storage = storage;
    this.reconstructed = storage.transactionSync(() => {
      // The first partial checkpoint's preview metadata is disposable. Keep
      // only this current representation, never an old-shape reader or copy.
      storage.sql.exec("DROP TABLE IF EXISTS computer_execution_lifecycle");
      storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS computer_execution_invocations (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('exec', 'process')), phase TEXT NOT NULL CHECK (phase IN ('opening', 'dispatching', 'open', 'closed')), backend TEXT NOT NULL, native_opened INTEGER NOT NULL DEFAULT 0 CHECK (native_opened IN (0, 1)), context_json TEXT NOT NULL, close_reason TEXT CHECK (close_reason IN ('refused_start', 'native_exit', 'unknown', 'reconstructed'))) STRICT",
      );
      const interrupted = storage.sql
        .exec<ExecutionRow>(
          "SELECT id, kind, phase, backend, native_opened, context_json, close_reason FROM computer_execution_invocations WHERE phase <> 'closed' AND (kind = 'exec' OR phase = 'opening')",
        )
        .toArray()
        .map(record);
      // A cold exec never probes or dispatches again. Process reconciliation
      // will require native proof; an unfinished issuer open has no such proof.
      storage.sql.exec(
        "UPDATE computer_execution_invocations SET phase = 'closed', close_reason = 'reconstructed' WHERE phase <> 'closed' AND (kind = 'exec' OR phase = 'opening')",
      );
      return interrupted;
    });
    this.prune();
  }

  get(id: string): ComputerExecutionRecord | undefined {
    const row = this.#storage.sql
      .exec<ExecutionRow>(
        "SELECT id, kind, phase, backend, native_opened, context_json, close_reason FROM computer_execution_invocations WHERE id = ?",
        id,
      )
      .toArray()[0];
    return row === undefined ? undefined : record(row);
  }

  /** Called synchronously after the existing owner's atomic NEW admission. */
  begin(
    invocation: ComputerExecutionInvocation,
    backend: string,
    context: ComputerValue,
  ): void {
    const publicContext = computerValueSchema.parse(context);
    this.prune();
    this.#storage.sql.exec(
      "INSERT INTO computer_execution_invocations (id, kind, phase, backend, context_json) VALUES (?, ?, 'opening', ?, ?)",
      invocation.id,
      invocation.kind,
      backend,
      JSON.stringify(publicContext),
    );
  }

  /** The last synchronous fence before invoking the maintained native SDK. */
  dispatch(id: string): void {
    if (this.get(id)?.phase !== "opening")
      throw new Error("Computer execution is no longer open for dispatch");
    this.#storage.sql.exec(
      "UPDATE computer_execution_invocations SET phase = 'dispatching' WHERE id = ?",
      id,
    );
  }

  /** A native handle arrived; this phase alone is not proof of native liveness. */
  opened(id: string): void {
    this.#storage.sql.exec(
      "UPDATE computer_execution_invocations SET native_opened = 1, phase = CASE WHEN phase = 'dispatching' THEN 'open' ELSE phase END WHERE id = ?",
      id,
    );
  }

  /** Persist revocation before the caller attempts the remote host callback. */
  close(
    id: string,
    reason: ComputerExecutionCloseReason,
  ): ComputerExecutionRecord | undefined {
    return this.#storage.transactionSync(() => {
      const current = this.get(id);
      if (current === undefined || current.phase === "closed") return undefined;
      this.#storage.sql.exec(
        "UPDATE computer_execution_invocations SET phase = 'closed', close_reason = ? WHERE id = ?",
        reason,
        id,
      );
      return current;
    });
  }

  /** Closed metadata cannot outlive the existing operation/process owner. */
  prune(): void {
    this.#storage.sql.exec(
      "DELETE FROM computer_execution_invocations WHERE phase = 'closed' AND ((kind = 'exec' AND NOT EXISTS (SELECT 1 FROM computer_operations WHERE 'exec:' || request_id = computer_execution_invocations.id)) OR (kind = 'process' AND NOT EXISTS (SELECT 1 FROM computer_processes WHERE id = computer_execution_invocations.id)))",
    );
  }
}

/** Construct the ComputerDO's internal lifecycle owner, not a package API. */
export function createComputerExecutionLifecycle(
  storage: Pick<DurableObjectStorage, "sql" | "transactionSync">,
) {
  return new ComputerExecutionLifecycle(storage);
}
